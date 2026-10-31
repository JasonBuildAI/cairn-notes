---
title: "Stage 7: Interface and Integration"
description: "TUI, print, JSON, RPC, and SDK: How the same engine serves different entry points."
---

> **Position of this Stage**: The previous chapters have already explained loops, context, tools, models, and extensions. Now we address a product question: How can the same set of Agent engines be used simultaneously by people in terminals, scripts, and external programs?
> **Source Code Directory**: `$PI_SRC`. Core materials: `docs/cli-integration.md`, `json.md`, `rpc.md`, `sdk.md`, `tui.md`.
> **One-sentence Mainline**: **The engine only produces states and events; different interfaces are just different consumers of these events.**

## 1. Why Multiple Interfaces Are Needed

Even though it's the same Agent working, different users want completely different things:

- A person collaborating in a terminal needs to see streaming text, tool progress, confirmation boxes, and editable input;
- A shell script only wants the final part of the response for easy piping;
- Monitoring programs want to know each tool call, the time taken, and token usage;
- IDEs or desktop apps want bidirectional control over a long-running Pi;
- Node programs want to embed the Agent directly into their own process.

If each need duplicates a set of loop, session, and tool logic, consistency is quickly lost: one interface supports compression, another doesn't; one interface can abort, another can't.

Pi's approach is:

```text
                  ┌── Interaction TUI
                  ├── print(final text)
The same AgentSession ─├── JSON (structured event)
                  ├── RPC (Bidirectional Commands and Events)
                  └── SDK (in-process API)
```

The shell is responsible for "how to input, how to output, how long the process lives," and is not responsible for re-implementing the Agent.

---

## 2. Clarify the Five Forms First

### 2.1 Comparison Table

| Form | Input | Output | Lifecycle | Best Suited For |
| --- | --- | --- | --- | --- |
| Interactive TUI | Terminal keyboard | Real-time interface | Until the user exits | Direct human-Pi collaboration |
| print | Command line arguments/pipes | Final text on stdout | Single run | Scripts, command replacement, one-off tasks |
| JSON | Command line arguments | JSONL events on stdout | Single run | Programs that need a structured process |
| RPC | JSONL commands on stdin | Responses and events on stdout | Long-lived | Cross-language, IDEs, custom clients, process isolation |
| SDK | TypeScript methods | In-process events and return values | Controlled by host | Embedded in Node/Bun processes |

Note: **SDK is not a CLI mode**. TUI, print, JSON, and RPC are all ways to start a Pi process; SDK embeds Pi's library directly into your process.

### 2.2 How to Choose

Ask yourself in this order:

1. **Is a person sitting in front of the terminal?** Yes → Interactive TUI.
2. **Do you only care about the final answer?** Yes → print.
3. **Do you need to follow a structured process for a single run?** Yes → JSON.
4. **Is the host not Node/Bun, or do you need process isolation/long-term bidirectional control?** Yes → RPC.
5. **Is the host Node/Bun, and do you want full access to the API directly?** Yes → SDK.

A common rule of thumb:

```text
"I wrote a PowerShell script to run tasks in batches, I just need the results"
  → print or JSON

"I am writing a VS Code plugin, which should show the tool's progress and allow the user to interject midway."
  → RPC

"I am writing a Node service and want to call Agent as a library."
  → SDK
```

---

## 3. How an Event Moves to Different Interfaces

### 3.1 Three-layer Events

Stage 5 has already distinguished three-layer events:

```text
Model Manufacturer Leak Incident
    ↓ Translated by provider adapter
Model Layer AssistantMessageEvent
    ↓ translated by Agent in a loop
Agent / Session event
    ↓ Consumed by the interface adapter
TUI / print / JSON / RPC / SDK subscribers
```

The interface does not directly parse OpenAI or Anthropic SSE. It only recognizes unified events like `agent_start`, `message_update`, `tool_execution_start`.

### 3.2 Events are an architectural interface, not a byproduct of logs

The same event stream simultaneously supports:

- TUI updating the interface;
- JSON mode outputting JSONL;
- RPC forwarding to external processes;
- SDK callbacks to the host program;
- test assertions for execution order;
- restoring what the system did during debugging.

So whether the event design is good or not directly affects all interfaces. Treating events like println logs will cause some interfaces to have to guess the state.

### 3.3 Unified semantics

All forms share several key semantics:

- `message_update` provides incremental updates, with `message_end` being final;
- a turn is one model response and its tool execution;
- `agent_end` only marks the end of the underlying loop;
- `agent_settled` indicates no automatic retries, compression recovery, or queued work;
- tool execution has start, update, and finish, associated by `toolCallId`.

If a certain interface invents its own definition of 'finish,' external programs may experience race conditions.

---

## 4. print: The form most like Unix tools

### 4.1 What it does

```powershell
cd $PI_SRC
.\pi-test.ps1 --print "Summarize this repository in one sentence"
```

Output only the final assistant text, suitable for:

- Command substitution;
- Pipelines;
- One-time batch processing;
- Tasks that do not require intermediate steps.

### 4.2 Automatic Switching

When stdin or stdout is redirected, and JSON/RPC is not explicitly selected, Pi will automatically use print mode. Therefore:

```powershell
Get-Content README.md | .\pi-test.ps1 "Explain this document"
```

Can work directly.

Note: `--mode text` may still open the TUI in the terminal; to force a single run and exit, use `--print`.

### 4.3 Errors and Exit Codes

The conventions for print mode are more suitable for scripts:

- Errors are written to stderr;
- If the final answer is `error` or `aborted`, the exit code is non-zero;
- If truncated by the model output limit (`length`), some text may still be printed, but a warning is given on stderr, and the exit code is non-zero.

So to determine whether a script succeeded or not, you cannot just check if stdout has any text; you also need to check the exit code.

---

## 5. JSON: Process for Programs

### 5.1 What It Outputs

```powershell
.\pi-test.ps1 --mode json "Check this repository" > events.jsonl
```

The first line is the conversation header:

```json
{"type":"session","version":3,"id":"...","timestamp":"...","cwd":"..."}
```

What follows are individual events, one JSON object per line:

```text
agent_start
turn_start
message_start(user)
message_end(user)
message_start(assistant, pending)
message_update(text_delta / toolcall_delta ...)
message_end(assistant)
tool_execution_start
tool_execution_update
tool_execution_end
turn_end
agent_end
agent_settled
```

This is not a 'JSON wrapper of the final result,' but a record of a single run process.

### 5.2 Why stdout can only contain protocol records

If the program is reading JSONL, and Pi writes a normal log line to stdout:

```text
Connecting...
{"type":"agent_start"}
```

The reader cannot distinguish between 'logs' and 'events'. Therefore, the JSON/RPC mode must follow:

- stdout writes only protocol records;
- logs, diagnostics, and error messages go to stderr;
- exactly one JSON object per line;
- ends with LF;
- the reader splits by LF and does not treat Unicode line separators within strings as newlines.

The last point is easy to get wrong: JSON strings can legally contain `U+2028` / `U+2029`, but some generic line readers will treat them as newlines, causing a single record to be split.

### 5.3 `message_update` Why it is incremental

If each frame sends the 'currently complete message' in full, the stream size will grow approximately quadratically with the reply length. In Pi's JSON events, `message_update` carries only the increment and content index:

```json
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
```

These increments can be concatenated for real-time display; however, the final authoritative result must be `message_end.message`, because streaming concatenation may encounter slices, tool parameters, or vendor corrections.

### 5.4 When is it truly finished

See `agent_settled`, not just `agent_end`:

```text
agent_end       = This round of the underlying Agent loop ends
agent_settled = Automatic retry, compression recovery, and queued messages have all been processed
```

Just wait for `agent_end` to exit the program, which may miss subsequent automatic operations.

---

## 6. RPC: Let another program control the Pi long-term

### 6.1 What the protocol looks like

RPC sends commands via stdin and receives responses and events via stdout:

```text
Your program ── JSON command ──→ Pi subprocess
Your program ←─ JSON response/event ─ Pi subprocess
```

Suitable for:

- Non-Node languages;
- IDE or desktop clients;
- Requires process isolation;
- Needs to send tasks multiple times, change models, and check status.

Startup:

```powershell
.\pi-test.ps1 --mode rpc --no-session
```

### 6.2 How Commands Correspond to Responses

A command can include a `id`:

```json
{"id":"req-1","type":"get_state"}
```

The response will return the same ID:

```json
{"id":"req-1","type":"response","command":"get_state","success":true,"data":{...}}
```

Command processing is asynchronous, so do not assume that 'responses will return in the order they were sent.' When sending concurrently, use IDs to correlate.

### 6.3 `prompt` Success does not equal task completion

This is the most common mistake in RPC:

```json
{"id":"req-2","type":"prompt","message":"Check the warehouse"}
```

Receiving a successful response only indicates that:

- The prompt was accepted;
- Or it was queued;
- Or it was processed for expansion.

It does not mean that the model has finished answering. The actual completion still depends on the event stream, until `agent_settled`.

Therefore:

1. Subscribe to events first;
2. Then send the prompt;
3. Wait for `agent_settled`;
4. Then decide whether to close or continue to the next round.

If you send the prompt before subscribing, tasks that finish quickly might complete before you subscribe.

### 6.4 Differences between RPC and JSON

The event structures are largely the same, but:

- JSON exits after running once;
- RPC stays resident and can receive repeated commands;
- JSON has session headers, RPC does not, status needs to be checked;
- RPC also has command responses and extended UI sub-protocols.

So don't treat RPC as just a "JSON mode that can send multiple prompts"; it is a bidirectional protocol.

---

## 7. SDK: Embedding the Agent in Node/Bun

### 7.1 Minimal usage

```ts
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();

const unsubscribe = session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  await session.prompt("Explain this repository");
} finally {
  unsubscribe();
  session.dispose();
}
```

This code reflects the core of the SDK:

- Create a session;
- Subscribe first;
- Call `prompt()`;
- Use `dispose()`.

### 7.2 Trade-offs between SDK and RPC

| Dimension | SDK | RPC |
| --- | --- | --- |
| Language | TypeScript/JavaScript | Any language that can read/write JSONL |
| Process | Same process as the host | Separate subprocess |
| Control | Direct method calls | JSON commands |
| Fault isolation | Shared process, higher risk | Subprocess can be restarted individually |
| Deployment | Requires Node/Bun dependencies | Only requires an executable |

If the host is Node/Bun, the SDK has one less process boundary and is usually more direct; if cross-language or isolation is needed, RPC is more suitable.

### 7.3 Session boundaries in the SDK

Only `SessionManager` has persistent sessions and active branches. Directly modifying `session.agent.state.messages` will not automatically rewrite the persistent context.

If an in-memory session is needed, it can be explicitly passed in:

```ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});
```

These types of boundaries are very important: **the interface layer can be replaced, but the session tree and projections are still determined by the core.**

---

## 8. TUI: A Complex Consumer of Events

### 8.1 TUI is Not Equal to an Agent

The interactive interface does the following:

- Reads keyboard input and pastes;
- Maintains the input editor;
- Displays streaming messages;
- Shows tool invocations and results;
- Displays confirmation dialogs, status bars, and selection lists;
- Passes user input to `AgentSession`.

It is not responsible for deciding when the model calls tools, nor for compressing the context.

### 8.2 Why Differential Rendering is Important

If each incremental change causes the entire screen to be re-rendered:

- There is a large amount of data;
- The terminal flickers;
- Scroll positions easily get disordered;
- It is noticeably laggy over remote connections.

Differential rendering only redraws the parts that have changed. You feel on the screen that the "entire block of content has updated," but in reality, usually only a few lines of changes are sent.

This is a typical layered result: the agent produces fine-grained events, and the TUI decides how to render them cheaply.

### 8.3 Why Input Needs to be Handled Separately

In raw mode, the terminal no longer echoes characters for you, nor can it simply rely on the default behavior of Ctrl C signals. The TUI must handle:

- Regular characters;
- Arrow keys and key combinations;
- Pasting;
- Mouse input;
- Submission and cancellation;
- Overlays and focus.

This is why the TUI is an independent package, not just tens of lines of `console.log`.

---

## 9. Practical Observations and Experiments

### Experiment 1: Comparing print and JSON

```powershell
cd $PI_SRC
.\pi-test.ps1 --print "Introduce this repository in two sentences" > answer.txt
.\pi-test.ps1 --mode json "Introduce this repository in two sentences" > events.jsonl
```

Comparison:

- What is in `answer.txt`?
- How many types of events are in `events.jsonl`?
- Which `message_end` does the final text correspond to?
- Where are `agent_end` and `agent_settled`?

### Experiment 2: Statistical Tool Calls

```powershell
Get-Content events.jsonl | ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object type -eq 'tool_execution_start' |
  Group-Object toolName |
  Select-Object Name, Count
```

Then count `durationMs` each time the tool is executed. This is the minimal example of 'observability using event streams.'

### Experiment 3: Running the Minimal SDK Example

Run in the root directory of the repository:

```powershell
npx tsx packages/coding-agent/examples/sdk/01-minimal.ts
```

Observe whether it:

- Subscribes to events first;
- Outputs streaming text;
- Releases the session after `prompt()` ends.

### Experiment 4: Running the RPC Client

RPC examples usually require building the CLI first:

```powershell
npm run build --workspace=@earendil-works/pi-coding-agent
npx tsx packages/coding-agent/examples/rpc-client.ts "Introduce this repository in one sentence"
```

Observe how the client waits for `agent_settled`, rather than just looking at the response from the prompt.

---

## 10. Common Misunderstandings

| Misunderstanding | Correct Understanding |
| --- | --- |
| Each interface has its own set of Agents | They share the same AgentSession, loop, tools, and sessions |
| print and JSON are just different output formats | print only produces the final text; JSON provides the full process and requires a clean protocol |
| `agent_end` means the task is finished | There may still be retries, compression recovery, and queued work afterward |
| `prompt` a successful response means the model has finished answering | It only indicates that the prompt has been accepted, queued, or processed; actual completion is indicated by `agent_settled` |
| In JSON mode, model errors always result in a non-zero exit | Failures appear in events and don't necessarily change the exit code directly; events need to be checked |
| RPC is just "multi-turn JSON" | It is a bidirectional long-lived protocol with command IDs, responses, events, and UI sub-protocols |
| SDK and RPC are just different writing styles | SDK is same-process, RPC is cross-process; boundaries of isolation, language, and deployment differ |
| TUI decides when an Agent stops | TUI is just an event consumer; stop semantics come from the core |
| An extra line of log in stdout doesn't matter | In JSON/RPC, stdout is a protocol channel; mixing logs can break parsing |

---

## 11. Self-Check for Completion

Please answer:

1. Why can the same engine simultaneously support TUI, print, JSON, RPC, and SDK?
2. In which scenarios should print be chosen, and in which must JSON be chosen?
3. Why does JSON mode require clean stdout? Where should logs go?
4. What roles do `message_update` and `message_end` play respectively?
5. Why can't `prompt` responses in RPC be taken as a completion signal?
6. What trade-offs arise from the process boundary differences between SDK and RPC?
7. What is the relationship between TUI differential rendering and the Agent's event stream?
8. Why must `agent_end` and `agent_settled` be distinguished?

Recommended outputs:

- [ ] A selection table of the five forms;
- [ ] One print output and one JSON event stream;
- [ ] A script for counting tool calls/time consumed;
- [ ] A minimal SDK or RPC client that runs successfully;
- [ ] A 3-minute explanation showing that "the interface is just an event consumer."

Next stop is Stage 8: Engineering. After being able to write functionality, you also need to learn how to make changes testable, checkable, and retractable.

---

*Accompanying [Learning Path](../learning-path/) Stage 7 · Based on v1.3.0 (`71023aec`)*
