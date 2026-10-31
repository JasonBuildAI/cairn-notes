---
title: "Stage 3: Execution and Documentation"
description: "How execd turns commands, files, and streams into verifiable and controllable side effects."
---

> Corresponding to [Learning Path](../learning-path/) Stage 3 (Core · 3 days). This stage turns the notion of "the model wants to run some code" into tool calls that can be checked, restricted, and provide retrievable evidence.
> Source code directory: `$OSB_SRC`.
> Core output: a command tool layer with timeouts, truncation, and structured returns, as well as one experiment with streaming output and one with file artifacts.

## 1. What this stage aims to solve

The "execution tool" in AI applications is not an ordinary `subprocess.run()`. It serves four duties simultaneously:

1. **Produce side effects**: write files, install dependencies, start services, access the network.
2. **Provide evidence to the model**: stdout, stderr, exit codes, artifact paths.
3. **Protect the host and platform**: restrict injection, resources, time, and output size.
4. **Make failures explainable**: distinguish between "non-zero command return", "transmission failure", "timeout", and "policy rejection".

If you just shove `execution.text` back into the model as-is, you will encounter three typical problems:

- stderr is lost, so the model doesn't know what went wrong;
- long output overwhelms the context;
- non-zero exit codes, but the model sees text and assumes success.

execd provides sufficient raw information, but **correctly interpreting this information is the job of the application layer**. The main storyline of this stage is:

```text
Write input (file/environment)
  → Select shell text or argv
  → Set timeout, working directory, identity
  → Collect stdout / stderr / result / exit_code / error
  Truncation, structuring, desensitization
  → Read the product, or hand over the evidence to the next step
```

## 2. Vocabulary Related to Execution

| Term | Meaning | Common Confusion Points |
| --- | --- | --- |
| execd | Execution daemon inside the sandbox, listens on `44772` | Not the user workload |
| Shell text | A whole string handed to the shell for interpretation | Risk of injection |
| argv | Program argument list, bypasses the shell | Safer, but not a complete permission system |
| SSE | Server-Sent Events, server continuously pushing events | Not a WebSocket |
| `Execution` | A single execution result after SDK aggregation | HTTP 200 does not mean it succeeded |
| `exit_code` | Process exit code | Could be `None` |
| `error` | Execution layer error object | Not the same signal as a non-zero exit code |
| Session | Persistent shell, keeps `cd` and variables across multiple calls | Not a new sandbox |
| PTY | Pseudo terminal, used by interactive programs | Different from a regular command channel |
| Code Context | Jupyter kernel context, preserves variables across calls | Requires a specific image |
| Isolated Session | bubblewrap namespace session | Not a tenant isolation boundary |

## 3. Execution Chain: From `commands.run` to Evidence

Stage 1 already has a drawn path, here we add the internal structure:

```text
Application
  │  sandbox.commands.run(...)
  ▼
SDK CommandService
  │ Verify parameters, assemble RunCommandOpts
  ▼
CommandAdapter
  │  POST {execd endpoint}/command
  │ (or /session/{id}/run, /code, /pty/...)
  ▼
execd
  │  Choose shell / argv
  │ Start the process, bind stdout / stderr
  ▼
SSE Event Stream
  │  init / stdout / stderr / result / error / complete
  ▼
Aggregation
  │  Execution(id, logs, result, error, exit_code, complete)
  ▼
Application judgment successful, truncate, structure, hand over to the model or downstream
```

Key Source Code Coordinates:

| Question to Answer | First Look |
| --- | --- |
| Command API and Events | `sdks/sandbox/python/src/opensandbox/services/command.py`, `models/execd.py` |
| How SDK Sends HTTP/SSE | `sdks/sandbox/python/src/opensandbox/adapters/command_adapter.py` |
| execd Routing | `components/execd/pkg/web/router.go` |
| Command Handling | `components/execd/pkg/web/controller/command.go` |
| File Interface | `sdks/sandbox/python/src/opensandbox/services/filesystem.py` |
| Public Execution Contract | `specs/execd-api.yaml` |

## 4. Shell Text and Native argv: Solve Injection First

Python SDK's `commands.run()` receives `str | list[str]`:

```python
# Mode: Pipes, variables, redirection, and quotes are all interpreted by the shell
await sandbox.commands.run("echo $HOME && ls -la /workspace")

# argv mode: the program and parameters are separated, without being parsed by the shell
await sandbox.commands.run(["python3", "-c", "print('hello')"])
```

Assume the file name comes from the model or the user:

```python
name = "report; rm -rf /workspace"
await sandbox.commands.run(f"cat {name}")     # Danger: semicolon executed by shell
await sandbox.commands.run(["cat", name])      # Parameters are passed by literal value
```

The second method eliminates injection through "string concatenation commands," but **it is not completely secure**. You still need to restrict:

- Executable programs (allowlist);
- Parameter ranges and paths;
- Working directories and writable paths;
- Network access;
- Running identity and resource limits.

A practical rule:

| Scenario | Recommended Form |
| --- | --- |
| Fixed scripts, trusted shell pipelines | String |
| Paths, filenames, user inputs, model-generated parameters | `list[str]` |
| Need to maintain shell state across steps | Explicit session, not concatenating overly long commands |
| Need to run completely untrusted code | First consider isolated sessions or stronger runtimes, not just replacing argv |

Remember: **argv solves the problem of 'parameters being interpreted by the shell,' not the problem of 'the program itself being dangerous.'**

## 5. Understanding a `Execution`

`commands.run()` returns `Execution`. Key fields:

| Field | Meaning | Common Mistakes |
| --- | --- | --- |
| `id` | Execution ID | Used for background commands, auditing, and correlating logs |
| `logs.stdout` | stdout fragment list | Can have many fragments; the last fragment may not end with a newline |
| `logs.stderr` | stderr fragment list | `execution.text` **does not include** it |
| `result` | Structured results, such as code interpreter output | Do not only look at stdout |
| `exit_code` | Exit code | Can be `None`, cannot be directly compared with 0 |
| `error` | Execution-level errors | Different signal from a non-zero exit code |
| `complete` | Completion event | Does not necessarily mean the exit code is 0 |

### What exactly is `text`

In the source code, `Execution.text` only merges **stdout and result** and normalizes line endings as needed for display; stderr is not included. Therefore:

- To see error messages, you must read `logs.stderr` separately;
- To see complete diagnostics, use `str(execution)` (it will include stderr and error), or format it yourself;
- Do not assume that each fragment ends with `\n`; when concatenating, preserve the original order and line endings.

### Logic for inferring exit codes

The SDK has a function to infer the exit code for foreground commands; the logic is:

```text
There is an error → trying to convert error.value to an integer; if it can't be converted, it is None
No error, but there is complete → 0
Otherwise → None
```

This explains two things:

1. When the completion event is not received, `exit_code` may be `None`, and should not be treated as 0;
2. When there is `complete` and no `error`, the SDK will infer it as 0—but your business logic should still consider stderr and output, and not rely on just a single number.

### A conservative normalizer

```python
from dataclasses import dataclass
from typing import Any

@dataclass
class CommandResult:
    ok: bool
    exit_code: int | None
    stdout: str
    stderr: str
    error: str | None
    truncated: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "error": self.error,
            "truncated": self.truncated,
        }

def clip(text: str, limit: int = 16_000) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    half = limit // 2
    return (
        text[:half]
        + "\n...<output clipped; full output is in the sandbox>...\n"
        + text[-half:],
        True,
    )

def normalize(execution, limit: int = 16_000) -> CommandResult:
    stdout = "".join(message.text for message in execution.logs.stdout)
    stderr = "".join(message.text for message in execution.logs.stderr)
    error = None
    if execution.error:
        error = f"{execution.error.name}: {execution.error.value}"

    if error:
        ok = False
    elif execution.exit_code is None:
        ok = False
    else:
        ok = execution.exit_code == 0

    stdout, clipped_out = clip(stdout, limit)
    stderr, clipped_err = clip(stderr, limit)
    return CommandResult(
        ok=ok,
        exit_code=execution.exit_code,
        stdout=stdout,
        stderr=stderr,
        error=error,
        truncated=clipped_out or clipped_err,
    )
```

The `ok` rules here are deliberately conservative: **do not declare success when there is no exit code.**

## 6. Timeout, Working Directory, Environment, and Identity

The main fields of `RunCommandOpts`:

| Field | Purpose | Note |
| --- | --- | --- |
| `timeout` | Maximum execution time on the server | If omitted, the server does not enforce a timeout; production tools should set it explicitly |
| `working_directory` | Working directory | Do not rely on the caller's current directory |
| `envs` | Environment variables for a single command | Do not write secrets into logs or model context |
| `uid` / `gid` | Unix identity of the running process | `gid` must be used together with `uid` |
| `background` | Background execution | Requires polling for status and logs |

```python
from datetime import timedelta

from opensandbox.models.execd import RunCommandOpts

execution = await sandbox.commands.run(
    ["python3", "job.py"],
    opts=RunCommandOpts(
        working_directory="/workspace",
        timeout=timedelta(seconds=60),
        envs={"PYTHONUNBUFFERED": "1"},
    ),
)
```

Three boundaries need to be distinguished:

1. **Command timeout** is the server-side execution budget; when the time is up, the process will be terminated.
2. **HTTP client timeout** may only interrupt your connection and does not guarantee that the server-side process disappears immediately.
3. **Connection drop** does not equal command timeout, nor does it equal command failure; you need to check the execution status.

If the task really requires more time, you should adjust the budget or switch to background execution, rather than setting the client timeout to be infinite.

## 7. Streaming output: Process while running, instead of accumulating until the end

Foreground commands return events via SSE. The SDK can dispatch events to asynchronous callbacks:

```python
from datetime import timedelta

from opensandbox.models.execd import ExecutionHandlers, RunCommandOpts

async def stream_lab(sandbox) -> None:
    async def on_stdout(message) -> None:
        print("OUT", message.text, end="")

    async def on_stderr(message) -> None:
        print("ERR", message.text, end="")

    handlers = ExecutionHandlers(
        on_stdout=on_stdout,
        on_stderr=on_stderr,
        skip_accumulation=True,
    )
    execution = await sandbox.commands.run(
        ["python3", "-c", "import time; print('start', flush=True); time.sleep(1); print('done')"],
        opts=RunCommandOpts(timeout=timedelta(seconds=30)),
        handlers=handlers,
    )
    print("\nexit:", execution.exit_code)
```

`skip_accumulation=True` indicates that stdout/stderr is only handed to the callback and will not continue accumulating in `ExecutionLogs`. It is suitable for long tasks and tasks with a lot of logs, preventing memory from growing indefinitely; the trade-off is that you must collect summaries and key evidence yourself.

A detail that is easily overlooked: **events are not "one complete string per line."** stdout/stderr fragments retain the original line endings, and the last fragment may be incomplete. Human interfaces can reconstruct by line; for auditing and reproduction, the original events or full outputs should be preserved.

## 8. Background Commands: Status, Logs, and Interrupts for Long Tasks

Use background mode when the foreground connection may not withstand the task duration:

```python
execution = await sandbox.commands.run(
    ["python3", "long_job.py"],
    opts=RunCommandOpts(
        background=True,
        working_directory="/workspace",
        timeout=timedelta(minutes=10),
    ),
)
execution_id = execution.id
assert execution_id is not None

status = await sandbox.commands.get_command_status(execution_id)
print(status.running, status.exit_code, status.error)

logs = await sandbox.commands.get_background_command_logs(execution_id)
print(logs.content, logs.cursor)

# Incremental reading: pass back last time's cursor
new_logs = await sandbox.commands.get_background_command_logs(
    execution_id, cursor=logs.cursor
)

# Needs to stop in advance
await sandbox.commands.interrupt(execution_id)
```

Key Points:

- The "completion" of backend commands relies on `get_command_status` polling, not on the return from the first call.
- `get_background_command_logs`'s `cursor` is used for incremental reading to avoid pulling the full data each time.
- After completion, the output can still be read for some time (officially stated as at least 24 hours); running commands will not be cleaned up by this retention policy.
- Do not misunderstand "logs can still be read" as "the process is still running," and do not assume "the process has ended" means "logs immediately disappear."

## 9. Session: Maintaining Shell State Across Calls

Sessions are suitable for multi-step shell processes, such as first `cd`, setting variables, and then running multiple commands:

```python
session_id = await sandbox.commands.create_session(working_directory="/workspace")
try:
    await sandbox.commands.run_in_session(session_id, "export MODE=lab && pwd")
    result = await sandbox.commands.run_in_session(session_id, "echo $MODE")
    print(result.text)
finally:
    await sandbox.commands.delete_session(session_id)
```

Boundaries:

- A session is a persistent shell within the sandbox, not a new sandbox; once the sandbox is destroyed, the session also disappears.
- Use Bash if the image has it; otherwise, fall back to POSIX `sh`; the syntax in minimal images must be compatible `sh`.
- Do not treat a session as "unlimited context"; variables, working directory, and background processes will end with the sandbox's lifecycle.
- `commands.set_env` can persist environment variables to subsequent commands and sessions; it is suitable for non-secret configuration, not for storing credentials.

## 10. Files: Put large materials in the sandbox, not in the model context

Python `sandbox.files` covers full filesystem operations:

| Capability | Method |
| --- | --- |
| Text read/write | `read_file`, `write_file` |
| Binary read/write | `read_bytes`, `read_bytes_stream` |
| Bulk write | `write_files` |
| Directories | `create_directories`, `list_directory`, `search` |
| Changes | `delete_files`, `delete_directories`, `move_files`, `set_permissions` |
| Content replacement | `replace_contents`, `replace_contents_detailed` |
| Metadata | `get_file_info` |

A repeatable input/output process:

```python
from opensandbox.models.filesystem import DirectoryListEntry, WriteEntry

await sandbox.files.create_directories([WriteEntry(path="/workspace/out")])
await sandbox.files.write_file(
    "/workspace/job.py",
    "from pathlib import Path\n"
    "Path('/workspace/out/result.txt').write_text('42\\n')\n",
    mode=644,
)
execution = await sandbox.commands.run(
    ["python3", "/workspace/job.py"],
    opts=RunCommandOpts(working_directory="/workspace"),
)
result = normalize(execution)
if not result.ok:
    raise RuntimeError(result.as_dict())

print(await sandbox.files.read_file("/workspace/out/result.txt"))
for entry in await sandbox.files.list_directory(
    DirectoryListEntry(path="/workspace", depth=2)
):
    print(entry.path, entry.size)
```

Key Details:

- The default `mode` of `write_file` is `755`; ordinary data files explicitly write `644`—do not unconsciously turn all files into executables.
- The `range_header` of `read_file` is a byte range, `offset`/`limit` reads by line; the two are mutually exclusive.
- For large files, use `read_bytes_stream(path, chunk_size=64*1024)` to read in chunks to avoid blowing up memory at once.
- `search`/`list_directory` return metadata, not the file content.
- Use `sandbox.files_with_identity(uid, gid)` when reading or writing requires a specific UID/GID. This is a capability of 1.1.1; when the old server returns unsupported, the client must not silently fall back to the default identity.

### Why Large Files Must Use the File Interface

Stuffing a 50 MB CSV into the model context is expensive and easy to truncate; the correct approach is:

1. Use the file interface to write data into the sandbox;
2. Let the script run calculations inside the sandbox;
3. Only bring back summaries, statistics, and output paths to the model;
4. Read the full file range only when necessary.

The file interface is not a "replacement for command execution" but a way to provide a stable landing point for side effects and evidence.

## XI. PTY: Channel for Interactive Programs

The ordinary command interface suits non-interactive execution; interactive programs (editor, REPL, Agent CLI) need a pseudo terminal (PTY). execd provides:

| Route | Function |
| --- | --- |
| `POST /pty` | Create a PTY session |
| `GET /pty/{sessionId}` | Query session status |
| `DELETE /pty/{sessionId}` | Delete session |
| `GET /pty/{sessionId}/ws` | WebSocket access |

The PTY sharing model is: **one holder has the keyboard, any number of viewers can only watch.** This is useful for "human-supervised Agent operations," but also means:

- PTY routes are currently reference implementation extensions and have not yet been publicly included in `execd-api.yaml`; encapsulation in different SDKs/versions may vary;
- WebSocket requires the correct entry point and HTTP/1.1 upgrade, which will be explained in stage 5;
- The lifecycle of interactive sessions is still tied to the sandbox; destroying the sandbox ends the session.

## XII. Code Interpreter: Another Execution Method Requiring Runtime

Shell is suitable for "running a program or script"; Code Interpreter suits tasks requiring a language runtime, execution context, and structured results:

- Python variables persist across multiple executions;
- Iterative analysis in the same Jupyter context;
- Results returned in structured form, rather than relying solely on stdout.

It requires that the image contains a Jupyter runtime (e.g., `opensandbox/code-interpreter` and its derivative images) and be wrapped with the existing sandbox.

```python
from code_interpreter import CodeInterpreter
from code_interpreter.models.code import SupportedLanguage

sandbox = await Sandbox.create(
    "opensandbox/code-interpreter:latest",
    entrypoint=["/opt/code-interpreter/code-interpreter.sh"],
    # ...
)
interpreter = await CodeInterpreter.create(sandbox=sandbox)
context = await interpreter.codes.create_context(SupportedLanguage.PYTHON)
result = await interpreter.codes.run("print('hello')", context=context)
print(result.text)

await interpreter.aclose()
await sandbox.destroy()
```

Three Boundaries:

1. **If the mirror is incorrect, there is no capability.** General `python:3.12` is not equal to Code Interpreter; it does not have a Jupyter kernel.
2. **Packaging does not equal ownership.** `CodeInterpreter.aclose()` only releases its own HTTP client and does not destroy the underlying sandbox; the sandbox lifecycle is still the responsibility of the caller.
3. **Context is stateful.** Retaining variables is an advantage but also a pollution risk; different tasks should use different contexts or different sandboxes.

## 13. Isolated Session: Another Layer of Isolation within the Sandbox

Isolated Session creates a bubblewrap namespace within the sandbox, suitable for running untrusted or exploratory scripts:

- Each session has an independent mount and identity view;
- Explicit bind mounts determine which paths are visible;
- Writes are restricted by an allowlist and verified against the resolved real paths;
- When created, it reports which capabilities the current environment supports, so the caller should check `capabilities()` first.

However, it is not a tenant isolation boundary: it still shares the sandbox kernel and resource limits, and does not provide a guarantee of an independent network namespace. For stronger isolation, a different runtime (Stage 4) should be used, rather than treating bubblewrap as an all-purpose wall.

## 14. Metrics: The Difference Between Snapshot and Stream

execd provides two types of metric capabilities:

- `GET /metrics`: A CPU/memory snapshot at a specific point in time;
- `GET /metrics/watch`: A continuously pushed metric stream.

The Python SDK currently exposes the snapshot interface:

```python
metrics = await sandbox.get_metrics()
print(metrics.cpu_count, metrics.cpu_used_percentage)
print(metrics.memory_used_in_mib, metrics.memory_total_in_mib)
```

When real-time streaming is needed, you can directly call execd's `/metrics/watch`, but you need to handle connection, reconnection, and backpressure yourself. **"API support" does not equal "currently packaged by the SDK"**—this is another example of a conditional line.

## 15. Make execution a tool available to the Agent

Do not serialize the original event object directly to the model. It is recommended to return a stable structure:

```json
{
  "ok": false,
  "exit_code": 2,
  "stdout": "reading input...\n",
  "stderr": "FileNotFoundError: data.csv\n",
  "error": null,
  "truncated": false,
  "artifact_paths": ["/workspace/out/report.html"],
  "hint": "Input file is missing; list /workspace/input first."
}
```

Implementation Principles:

1. **Preserve verifiable facts**: exit codes, stderr, error names, artifact paths.
2. **Limit return size**: single results have a hard upper limit; if exceeded, write the full content to a file, returning only a summary and the path.
3. **Do not let the model guess success**: non-zero exit codes must return `ok=false`, even if stdout looks normal.
4. **Differentiate between retryable and non-retryable**: brief network interruptions can be retried a limited number of times; syntax errors, permission denials, policy rejections generally should not be retried.
5. **Desensitize**: environment variables, request headers, credentials, complete command history may all leak secrets.
6. **Preserve execution ID**: associate model traces, execd logs, and metrics.

A minimal argv tool:

```python
ALLOWED_PROGRAMS = {"python3", "pytest", "node", "git"}

async def run_command_tool(sandbox, argv: list[str], timeout_seconds: int = 60):
    if not argv or argv[0] not in ALLOWED_PROGRAMS:
        return {"ok": False, "error": "program_not_allowed", "argv": argv}
    if timeout_seconds < 1 or timeout_seconds > 300:
        return {"ok": False, "error": "invalid_timeout"}

    execution = await sandbox.commands.run(
        argv,
        opts=RunCommandOpts(
            working_directory="/workspace",
            timeout=timedelta(seconds=timeout_seconds),
        ),
    )
    return normalize(execution).as_dict()
```

This is not a complete permission system. The model can issue commands, but **approval rules must be enforced by code and policies**.

## 16. Experiment: From Output to Evidence

### Experiment 1 · Difference between shell and argv

```python
name = "report; echo INJECTED"
shell_result = await sandbox.commands.run(f"echo {name}")
argv_result = await sandbox.commands.run(["echo", name])
print("shell:", shell_result.text)
print("argv :", argv_result.text)
```

Check whether the argv version treats semicolons as ordinary characters. Then run a parameter with spaces and quotes to confirm it is passed as-is.

### Experiment 2 · Reading stdout, stderr, and exit code simultaneously

```python
execution = await sandbox.commands.run(
    "echo out; echo err 1>&2; exit 7"
)
print("text   :", execution.text)
print("stdout :", "".join(m.text for m in execution.logs.stdout))
print("stderr :", "".join(m.text for m in execution.logs.stderr))
print("exit   :", execution.exit_code)
print("error  :", execution.error)
```

**To observe**: There is no stderr in `text`; the HTTP layer succeeds, but the exit code is 7; `error` may be empty or contain an error object, depending on the event sequence.

### Experiment 3 · Streaming Output and Memory Control

Run a script that outputs one line per second using `ExecutionHandlers(skip_accumulation=True)` and observe:

- Whether the callback receives chunks in real-time;
- Whether `execution.logs.stdout` is empty (because accumulation was skipped);
- If accumulation is not skipped, whether long tasks cause continuous memory growth.

### Experiment 4 · Background Tasks and Incremental Logs

```python
execution = await sandbox.commands.run(
    ["sh", "-c", "for i in 1 2 3; do echo line-$i; sleep 1; done"],
    opts=RunCommandOpts(background=True),
)
cursor = None
while True:
    status = await sandbox.commands.get_command_status(execution.id)
    logs = await sandbox.commands.get_background_command_logs(
        execution.id, cursor=cursor
    )
    print(logs.content, end="")
    cursor = logs.cursor
    if not status.running:
        print("exit:", status.exit_code)
        break
    await asyncio.sleep(0.5)
```

Observe whether cursor returns only new content each time, as well as the completed status field. 

### Experiment 5 · Document product

Write a script to generate a CSV, run it to read the first 5 lines, and then use `read_bytes_stream` to count the byte count. Go through the process of "leaving the complete file in the sandbox and only bringing the summary back to the model." 

### Experiment 6 · Failure classification

Manufactured separately: 

- The command does not exist (`exit 127`); 
- Timeout (`sleep 10` + 2-second timeout); 
- The work directory does not exist; 
- Incorrect connection (intentionally using the wrong endpoint). 

Record the performance of each type in `exit_code`, `error`, stderr, and the HTTP layer, then fill them into the failure table. **These four types of failures are handled completely differently at the application layer.** 

## 17. Failure Pattern Table

| Phenomenon | Possible Cause | What to Check First | Handle |
| --- | --- | --- | --- |
| Command not found | Program not in PATH, image lacks dependencies | `exit_code=127`, stderr | Edit the image or switch to an absolute path |
| Parameters are split/injected | Use shell strings | Command construction method | Switch to argv + allowlist |
| Output but business failure | Nonzero exit code ignored | `exit_code`, `error` | Unified normalization, prohibiting viewing only text |
| `exit_code` is `None` | No completion event received, connection interruption | `complete`, transmission log | Considered incomplete, not declared successful |
| Timeout | Execution budget too small, process freezes | `RunCommandOpts.timeout`, status | Distinguishing timeout from ordinary nonzero exit |
| Backend logs are duplicated/missing | cursor not updated, reading is too frequent | `cursor`, polling interval | Use incremental reading, set reasonable intervals |
| File permission incorrect | `write_file` Default 755 | Write `mode` | Data file explicit 644 |
| Large file OOM | One-time `read_bytes` | File size, read method | Switch to `read_bytes_stream` |
| Code Interpreter startup failure | Image without Jupyter runtime | Image, `/ping`, runtime process | Switch to the official code-interpreter image |
| PTY cannot connect | Routing not entering public contract, WebSocket upgrade failure | Entry point, HTTP version | Check the entry constraints of phase 5 |
| Identity read/write failure | Old server does not support identity prefixes | Server version, error code | No silent rollback; Upgrade or change solution |

## 18. Common Misconceptions

| Misconceptions | A More Accurate Understanding |
| --- | --- |
| "`execution.text` means all outputs" | It only contains stdout and result, not stderr. |
| "HTTP 200 means command successful" | 200 only means the request was accepted; Success checks exit code, error, and full output. |
| "ARGV mode is absolutely safe" | It only avoids shell interpretation and does not restrict the dangerous behavior of the program itself
| "Timeout is a network issue" | Timeout may be due to budget execution, process freeze, or server termination
| "Background command returns and it's finished" | Background mode returns handles; Completion requires polling status. |
| "Session is the new sandbox" | It is just a persistent shell inside the sandbox, and its lifecycle remains tied to the sandbox
| "PTY has entered the public contract" | Currently, it is a reference implementation extension, with varying levels of SDK support. |
| "`CodeInterpreter.aclose()` will destroy the sandbox" | It only releases its own client; The sandbox remains managed by the caller. |
| "The metric stream SDK must have it" | The Python SDK currently exposes snapshots, so the stream needs to be directly execd. |

## 19. Customs Self-Check (Including Reference Answers)

**1. What is the security difference between shell strings and argv?** 

Shell strings hand over the entire content to the shell for interpretation, and semicolons, pipelines, and variable substitutions can all be injected; argv passes the program and parameters separately, with parameters entering the process literal without passing through the shell. However, argv does not restrict the program itself and still requires allowing checklist and sandbox boundaries. 

**2. `execution.text` Why can't it be considered a complete diagnosis?** 

It only merges stdout and result, not stderr; And the failure reason is often only in stderr or `error`. The correct approach is to concatenate stdout/stderr separately and check the exit code and error. 

**3. If the exit code is 0 or stderr contains content, does that count as a failure?** 

Not necessarily. Many programs write warnings to stderr. Failure decisions should be based on exit codes, `execution.error`, and business outputs; But stderr cannot be discarded, especially when the model needs to adjust parameters accordingly. 

**4. What is the difference between command timeout and HTTP client timeout?** 

Command timeout refers to the server-side executing the budget, which terminates the process at the right time; The client timeout may only interrupt your connection and does not guarantee that the remote process will stop. Both should be set and diagnosed separately. 

**5. When should you use background commands, and when should you use sessions?** 

When a task may exceed the front-end connection lifespan, use backend commands to obtain results through status and log polling; Use session when maintaining shell states such as `cd` or variables between multiple calls. Neither can replace sandbox lifecycle management. 

**6. Why do large files need `read_bytes_stream`?** 

A one-time `read_bytes` will put the entire file into memory, and large files may overwhelm the process; Streaming read is processed by chunk, which can keep memory usage within a fixed range. A better approach is to let the computation happen in the sandbox, bringing only the summary back. 

**7. What is the essential difference between Code Interpreter and regular commands?**

Ordinary commands run as a single process each time, and their state is not automatically preserved; the Code Interpreter manages the Jupyter kernel context, allowing variables and imports to persist across multiple executions, with results returned in a structured form. It requires including a Jupyter runtime image.

**8. Why is it said that 'successful transmission does not equal command success'?**

HTTP 200 in SSE only indicates that the request was accepted and event pushing has started; the command may later exit with a non-zero code, or disconnect midway. True evidence of success is complete output, exit codes, and error fields.

### Completion Checklist

- [ ] Can run argv with an argument containing spaces, semicolons, and quotes, and explain why it is safer.
- [ ] Can read stdout, stderr, `exit_code`, and `error` simultaneously and make correct judgments.
- [ ] Can explain the boundaries of `execution.text` and line-ending issues in split segments.
- [ ] Can set a timeout for a command and distinguish between timeout, non-zero exit, and connection errors.
- [ ] Can use handlers to stream output, and control memory with `skip_accumulation`.
- [ ] Can run a background task, query its status, and incrementally read logs with a cursor.
- [ ] Can write files, run scripts, read artifacts, and use a streaming interface to read large files.
- [ ] Can design a tool return value that informs the model of 'the reason for failure and the next steps'.

## Twenty, After Completion

Now you can convert model actions into side effects with evidence, and you know how to limit them and interpret failures.

But execution always occurs somewhere. The same `commands.run` runs as a process inside a container on Docker, as a process inside a Pod on Kubernetes, and as a process inside a micro virtual machine on FastSandbox; pooling, snapshots, and templates further change 'where the environment comes from'. The next stage deals with runtime: **how the same contract is implemented on different endpoints, and why 'interface support' must include backend conditions.**

Enter the next chapter with this question: **'For the same creation request, why can it produce the same behavior on three completely different resources?'**

Go to [Stage 4](../stage-4/).

---

*Accompanying [learning path](../learning-path/) Stage 3 draft · 2026-10-30 · based on release-1.1.1 (`531700ca`)*
