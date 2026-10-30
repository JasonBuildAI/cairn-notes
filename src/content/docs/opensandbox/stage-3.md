---
title: "阶段 3：执行与文件"
description: "execd 如何把命令、文件与流变成可验证、可限制的副作用。"
---

> 对应[学习路线](../learning-path/)阶段 3（核心 · 3 天）。本阶段把“模型说要运行一段代码”变成可检查、可限制、可回传证据的工具调用。
> 源码目录：`$OSB_SRC`。
> 核心产出：一个带超时、截断和结构化返回的命令工具层，以及一次流式输出和一次文件产物实验。

## 一、这一阶段到底要解决什么

AI 应用里的“执行工具”不是普通的 `subprocess.run()`。它同时承担四个职责：

1. **产生副作用**：写文件、装依赖、启动服务、访问网络。
2. **向模型提供证据**：stdout、stderr、退出码、产物路径。
3. **保护宿主和平台**：限制注入、资源、时间和输出体积。
4. **让失败可解释**：区分“命令返回非零”“传输失败”“超时”“策略拒绝”。

如果只把 `execution.text` 原样塞回模型，你会遇到三个典型问题：

- stderr 丢失，模型不知道错在哪；
- 长输出压爆上下文；
- 退出码非零，但模型看到有文字就以为成功。

execd 提供了足够的原始信息，但**正确解释这些信息是应用层的工作**。本阶段的主线是：

```text
写入输入（文件 / 环境）
  → 选择 shell 文本或 argv
  → 设置超时、工作目录、身份
  → 收集 stdout / stderr / result / exit_code / error
  → 截断、结构化、脱敏
  → 读取产物，或把证据交给下一步
```

## 二、执行相关的词汇表

| 术语 | 含义 | 容易混淆的点 |
| --- | --- | --- |
| execd | 沙箱内的执行守护进程，监听 `44772` | 不是用户的工作负载 |
| Shell 文本 | 一整段交给 shell 解释的字符串 | 有注入风险 |
| argv | 程序 + 参数列表，不经过 shell | 更安全，但不是完整权限系统 |
| SSE | Server-Sent Events，服务端持续推送事件 | 不是 WebSocket |
| `Execution` | SDK 聚合后的一次执行结果 | HTTP 200 不等于它成功 |
| `exit_code` | 进程退出码 | 可能为 `None` |
| `error` | 执行层错误对象 | 与非零退出码不是同一信号 |
| Session | 持久 shell，跨多次调用保留 `cd`、变量 | 不是新的沙箱 |
| PTY | 伪终端，交互式程序用 | 与普通命令通道不同 |
| Code Context | Jupyter 内核上下文，跨调用保留变量 | 需要特定镜像 |
| Isolated Session | bubblewrap 命名空间会话 | 不是租户隔离边界 |

## 三、执行链路：从 `commands.run` 到证据

阶段 1 已经画过路径，这里补上内部结构：

```text
应用
  │  sandbox.commands.run(...)
  ▼
SDK CommandService
  │  校验参数、组装 RunCommandOpts
  ▼
CommandAdapter
  │  POST {execd endpoint}/command
  │  （或 /session/{id}/run、/code、/pty/...）
  ▼
execd
  │  选择 shell / argv
  │  启动进程，绑定 stdout / stderr
  ▼
SSE 事件流
  │  init / stdout / stderr / result / error / complete
  ▼
SDK 聚合
  │  Execution(id, logs, result, error, exit_code, complete)
  ▼
应用判断成功，截断，结构化，交给模型或下游
```

关键源码坐标：

| 想回答的问题 | 先看 |
| --- | --- |
| 命令 API 与事件 | `sdks/sandbox/python/src/opensandbox/services/command.py`、`models/execd.py` |
| SDK 怎样发 HTTP/SSE | `sdks/sandbox/python/src/opensandbox/adapters/command_adapter.py` |
| execd 路由 | `components/execd/pkg/web/router.go` |
| 命令处理 | `components/execd/pkg/web/controller/command.go` |
| 文件接口 | `sdks/sandbox/python/src/opensandbox/services/filesystem.py` |
| 公开执行契约 | `specs/execd-api.yaml` |

## 四、Shell 文本与原生 argv：先解决注入

Python SDK 的 `commands.run()` 接收 `str | list[str]`：

```python
# Shell 模式：管道、变量、重定向、引号都由 shell 解释
await sandbox.commands.run("echo $HOME && ls -la /workspace")

# argv 模式：程序与参数分离，不经过 shell 解析
await sandbox.commands.run(["python3", "-c", "print('hello')"])
```

假设文件名来自模型或用户：

```python
name = "report; rm -rf /workspace"
await sandbox.commands.run(f"cat {name}")     # 危险：分号被 shell 执行
await sandbox.commands.run(["cat", name])      # 参数按字面量传递
```

第二种写法消除了“字符串拼接命令”的注入，但**不是万能安全**。你仍然要限制：

- 可执行程序（允许清单）；
- 参数范围与路径；
- 工作目录与可写路径；
- 网络访问；
- 运行身份与资源上限。

一个实用规则：

| 场景 | 推荐形式 |
| --- | --- |
| 固定脚本、可信 shell 管道 | 字符串 |
| 路径、文件名、用户输入、模型生成的参数 | `list[str]` |
| 需要跨步骤保持 shell 状态 | 显式 session，而不是拼接超长命令 |
| 需要运行完全不可信的代码 | 先考虑隔离会话或更强运行时，而不是只换 argv |

记住：**argv 解决的是“参数被 shell 解释”的问题，不解决“程序本身有危险”的问题。**

## 五、读懂一个 `Execution`

`commands.run()` 返回 `Execution`。关键字段：

| 字段 | 含义 | 易错点 |
| --- | --- | --- |
| `id` | 执行 ID | 后台命令、审计、关联日志都要用它 |
| `logs.stdout` | stdout 分片列表 | 可能很多片，最后一片可能没有换行 |
| `logs.stderr` | stderr 分片列表 | `execution.text` **不包含**它 |
| `result` | 结构化结果，例如代码解释器输出 | 不要只看 stdout |
| `exit_code` | 退出码 | 可能是 `None`，不能直接和 0 比较 |
| `error` | 执行层错误 | 与非零退出码是不同信号 |
| `complete` | 完成事件 | 不代表退出码一定为 0 |

### `text` 到底是什么

源码里的 `Execution.text` 只合并 **stdout 和 result**，并按显示需要规范化行尾；stderr 不在里面。所以：

- 想看错误信息，必须单独读 `logs.stderr`；
- 想看完整诊断，用 `str(execution)`（它会附加 stderr 和 error），或自己格式化；
- 不要假设每个分片以 `\n` 结尾，拼接时保留原始顺序和行尾。

### 退出码的推断逻辑

SDK 对前台命令的退出码有一个推断函数，逻辑是：

```text
有 error → 尝试把 error.value 转成整数；转不了就是 None
没有 error，但有 complete → 0
否则 → None
```

这解释了两件事：

1. 没有收到完成事件时，`exit_code` 可能是 `None`，不能当成 0；
2. 有 `complete` 且没有 `error` 时，SDK 会推断为 0——但你的业务仍应结合 stderr 和输出判断，不要只看一个数字。

### 一个保守的归一化器

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

这里的 `ok` 规则故意保守：**没有退出码时不宣布成功。**

## 六、超时、工作目录、环境与身份

`RunCommandOpts` 的主要字段：

| 字段 | 作用 | 注意 |
| --- | --- | --- |
| `timeout` | 服务端最大执行时间 | 省略时服务端不强制超时；生产工具应显式设置 |
| `working_directory` | 工作目录 | 不要依赖调用者当前目录 |
| `envs` | 单次命令的环境变量 | 不要把秘密写进日志或模型上下文 |
| `uid` / `gid` | 运行进程的 Unix 身份 | `gid` 必须配合 `uid` |
| `background` | 后台执行 | 需要轮询状态和日志 |

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

三个边界要分清：

1. **命令超时**是服务端执行预算；到点后进程会被终止。
2. **HTTP 客户端超时**可能只中断你的连接，不保证服务端进程立刻消失。
3. **传输断开**不等于命令超时，也不等于命令失败；要查执行状态。

如果任务确实需要更长时间，应该调整预算或改成后台执行，而不是把客户端超时设得无限大。

## 七、流式输出：边跑边处理，而不是攒到最后

前台命令通过 SSE 返回事件。SDK 可以把事件分发给异步回调：

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

`skip_accumulation=True` 表示 stdout/stderr 只交给回调，不在 `ExecutionLogs` 里继续累积。它适合长任务和日志很多的任务，能避免内存无限增长；代价是你必须自己收集摘要和关键证据。

一个容易被忽略的细节：**事件不是“每行一个完整字符串”。** stdout/stderr 分片保留原始行尾，最后一片可能是未终止的片段。人类界面可以按行重组；审计和复现则应保留原始事件或完整产物。

## 八、后台命令：长任务的状态、日志与中断

当前台连接可能撑不住任务时长时，使用后台模式：

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

# 增量读取：把上次的 cursor 传回去
new_logs = await sandbox.commands.get_background_command_logs(
    execution_id, cursor=logs.cursor
)

# 需要提前停止
await sandbox.commands.interrupt(execution_id)
```

要点：

- 后台命令的“完成”要靠 `get_command_status` 轮询，不是靠第一次调用返回。
- `get_background_command_logs` 的 `cursor` 用于增量读取，避免每次拉全量。
- 完成后输出仍可读取一段时间（官方说明为至少 24 小时）；运行中的命令不会被这条保留策略清理。
- 不要把“日志还能读”误解成“进程还在跑”，也不要把“进程结束了”误解成“日志立刻消失”。

## 九、Session：跨调用保持 shell 状态

Session 适合多步 shell 流程，例如先 `cd`、设置变量、再运行多个命令：

```python
session_id = await sandbox.commands.create_session(working_directory="/workspace")
try:
    await sandbox.commands.run_in_session(session_id, "export MODE=lab && pwd")
    result = await sandbox.commands.run_in_session(session_id, "echo $MODE")
    print(result.text)
finally:
    await sandbox.commands.delete_session(session_id)
```

边界：

- Session 是沙箱内的持久 shell，不是新沙箱；沙箱销毁后 session 也没了。
- 镜像有 Bash 时用 Bash，没有时回退到 POSIX `sh`；最小镜像里的语法要兼容 `sh`。
- 不要把 session 当成“无限长的上下文”；变量、工作目录、后台进程都会随沙箱生命周期结束。
- `commands.set_env` 可以把环境变量持久化到后续命令和 session；它适合非秘密配置，不适合放凭据。

## 十、文件：把大材料放在沙箱里，而不是模型上下文里

Python `sandbox.files` 覆盖完整文件系统操作：

| 能力 | 方法 |
| --- | --- |
| 文本读写 | `read_file`、`write_file` |
| 二进制读写 | `read_bytes`、`read_bytes_stream` |
| 批量写 | `write_files` |
| 目录 | `create_directories`、`list_directory`、`search` |
| 变更 | `delete_files`、`delete_directories`、`move_files`、`set_permissions` |
| 内容替换 | `replace_contents`、`replace_contents_detailed` |
| 元数据 | `get_file_info` |

一个可重复的输入/输出流程：

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

关键细节：

- `write_file` 的默认 `mode` 是 `755`；普通数据文件显式写 `644`，不要无意识地把所有文件变成可执行。
- `read_file` 的 `range_header` 是字节范围，`offset` / `limit` 是按行读取，二者互斥。
- 大文件用 `read_bytes_stream(path, chunk_size=64*1024)` 逐块读，避免一次性撑爆内存。
- `search` / `list_directory` 返回元数据，不等于文件内容。
- 需要以特定 UID/GID 读写时用 `sandbox.files_with_identity(uid, gid)`。这是 1.1.1 的能力；旧服务端返回不支持时，客户端不能静默回退到默认身份。

### 大文件为什么必须走文件接口

把 50 MB 的 CSV 塞进模型上下文，既贵又容易被截断；正确做法是：

1. 用文件接口把数据写进沙箱；
2. 让脚本在沙箱里计算；
3. 只把摘要、统计结果和产物路径带回模型；
4. 需要全文时再按范围读取。

文件接口不是“命令执行的替代品”，而是让副作用和证据有一个稳定的落点。

## 十一、PTY：交互式程序的通道

普通命令接口适合非交互式执行；交互式程序（编辑器、REPL、Agent CLI）需要伪终端（PTY）。execd 提供：

| 路由 | 作用 |
| --- | --- |
| `POST /pty` | 创建 PTY 会话 |
| `GET /pty/{sessionId}` | 查询会话状态 |
| `DELETE /pty/{sessionId}` | 删除会话 |
| `GET /pty/{sessionId}/ws` | WebSocket 接入 |

PTY 的共享模型是：**一个 holder 拥有键盘，任意多个 viewer 只能看。** 这对“人监督 Agent 操作”很有用，但也意味着：

- PTY 路由目前是参考实现扩展，尚未进入公开的 `execd-api.yaml`；不同 SDK/版本的封装可能不一致；
- WebSocket 需要正确的入口和 HTTP/1.1 升级，阶段 5 会展开；
- 交互式会话的生命周期仍绑定沙箱，沙箱销毁就结束。

## 十二、Code Interpreter：需要运行时的另一种执行

Shell 适合“运行一个程序或脚本”；Code Interpreter 适合需要语言运行时、执行上下文和结构化结果的工作：

- Python 变量跨多次执行保留；
- 同一个 Jupyter 上下文里迭代分析；
- 结果以结构化形式返回，而不是只靠 stdout。

它要求镜像包含 Jupyter 运行时（例如 `opensandbox/code-interpreter` 及其派生镜像），并用既有沙箱包装：

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

三个边界：

1. **镜像不对，能力就没有。** 通用 `python:3.12` 不等于 Code Interpreter；它没有 Jupyter 内核。
2. **包装不等于拥有。** `CodeInterpreter.aclose()` 只释放自己的 HTTP 客户端，不销毁底层沙箱；沙箱生命周期仍由调用者负责。
3. **上下文有状态。** 变量保留是优点，也是污染风险；不同任务应使用不同 context 或不同沙箱。

## 十三、Isolated Session：沙箱里的再一层隔离

Isolated Session 在沙箱内再创建一个 bubblewrap 命名空间，适合运行不可信或探索性脚本：

- 每次会话有独立的挂载和身份视图；
- 显式 bind mount 决定哪些路径可见；
- 写入受 allowlist 限制，并按解析后的真实路径校验；
- 创建时会报告当前环境支持哪些能力，调用方应先查 `capabilities()`。

但它不是租户隔离边界：它仍共享沙箱内核和资源上限，也不提供独立的网络命名空间保证。需要更强隔离时，应该换运行时（阶段 4），而不是把 bubblewrap 当成万能墙。

## 十四、指标：快照与流的区别

execd 提供两类指标能力：

- `GET /metrics`：某一时刻的 CPU / 内存快照；
- `GET /metrics/watch`：持续推送的指标流。

Python SDK 当前暴露的是快照接口：

```python
metrics = await sandbox.get_metrics()
print(metrics.cpu_count, metrics.cpu_used_percentage)
print(metrics.memory_used_in_mib, metrics.memory_total_in_mib)
```

需要实时流时，可以直接调用 execd 的 `/metrics/watch`，但要自己处理连接、重连和背压。**“API 支持”不等于“当前 SDK 封装了”**——这是条件线的又一个例子。

## 十五、把执行做成 Agent 可用的工具

不要把原始事件对象直接序列化给模型。推荐返回稳定的结构：

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

实现原则：

1. **保留可验证事实**：退出码、stderr、错误名、产物路径。
2. **限制返回体积**：单次结果有硬上限；超限时把完整内容写进文件，只返回摘要和路径。
3. **不要让模型猜成功**：非零退出码必须让 `ok=false`，即使 stdout 看起来正常。
4. **区分可重试与不可重试**：网络瞬断可以有限重试；语法错误、权限拒绝、策略拒绝通常不应重试。
5. **脱敏**：环境变量、请求头、凭据、完整命令历史都可能泄漏秘密。
6. **保留执行 ID**：把模型轨迹、execd 日志和指标关联起来。

一个最小的 argv 工具：

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

这不是完整的权限系统。模型可以提出命令，但**批准规则必须由代码和策略执行**。

## 十六、实验：从输出到证据

### 实验 1 · shell 与 argv 的差别

```python
name = "report; echo INJECTED"
shell_result = await sandbox.commands.run(f"echo {name}")
argv_result = await sandbox.commands.run(["echo", name])
print("shell:", shell_result.text)
print("argv :", argv_result.text)
```

观察 argv 版本是否把分号当成普通字符。再运行一个带空格和引号的参数，确认它原样传递。

### 实验 2 · 同时读取 stdout、stderr 和退出码

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

**要观察**：`text` 里没有 stderr；HTTP 层成功，但退出码是 7；`error` 可能为空，也可能带错误对象，取决于事件序列。

### 实验 3 · 流式输出与内存控制

用 `ExecutionHandlers(skip_accumulation=True)` 跑一个每秒输出一行的脚本，观察：

- 回调是否实时收到分片；
- `execution.logs.stdout` 是否为空（因为跳过了累积）；
- 如果不跳过累积，长任务的内存是否持续增长。

### 实验 4 · 后台任务与增量日志

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

观察 cursor 是否让每次只返回新增内容，以及完成后的状态字段。

### 实验 5 · 文件产物

写一个脚本生成 CSV，运行后读取前 5 行，再用 `read_bytes_stream` 统计字节数。把“完整文件留在沙箱、只把摘要带回模型”的流程走一遍。

### 实验 6 · 失败分类

分别制造：

- 命令不存在（`exit 127`）；
- 超时（`sleep 10` + 2 秒超时）；
- 工作目录不存在；
- 连接错误（故意用错端点）。

记录每种的 `exit_code`、`error`、stderr 和 HTTP 层表现，填进失败表。**这四类失败在应用层的处理方式完全不同。**

## 十七、失败模式表

| 现象 | 可能原因 | 先查什么 | 处理 |
| --- | --- | --- | --- |
| 命令找不到 | 程序不在 PATH、镜像缺依赖 | `exit_code=127`、stderr | 修镜像或改用绝对路径 |
| 参数被拆开/注入 | 用了 shell 字符串 | 命令构造方式 | 改用 argv + 允许清单 |
| 有输出但业务失败 | 非零退出码被忽略 | `exit_code`、`error` | 统一归一化，禁止只看 text |
| `exit_code` 为 `None` | 没收到完成事件、连接中断 | `complete`、传输日志 | 视为未完成，不宣布成功 |
| 超时 | 执行预算太小、进程卡死 | `RunCommandOpts.timeout`、状态 | 区分超时与普通非零退出 |
| 后台日志重复/缺失 | cursor 没更新、读取太频繁 | `cursor`、轮询间隔 | 用增量读取，设合理间隔 |
| 文件权限不对 | `write_file` 默认 755 | 写入时的 `mode` | 数据文件显式 644 |
| 大文件 OOM | 一次性 `read_bytes` | 文件大小、读取方式 | 改用 `read_bytes_stream` |
| Code Interpreter 启动失败 | 镜像没有 Jupyter 运行时 | 镜像、`/ping`、运行时进程 | 换官方 code-interpreter 镜像 |
| PTY 连不上 | 路由未进入公开契约、WebSocket 升级失败 | 入口、HTTP 版本 | 查阶段 5 的入口约束 |
| 身份读写失败 | 旧服务端不支持身份前缀 | 服务端版本、错误码 | 不静默回退；升级或换方案 |

## 十八、常见误区

| 误区 | 更准确的理解 |
| --- | --- |
| “`execution.text` 就是全部输出” | 它只含 stdout 和 result，不含 stderr。 |
| “HTTP 200 就是命令成功” | 200 只代表请求被接受；成功看退出码、错误和完整输出。 |
| “argv 模式绝对安全” | 它只避免 shell 解释，不限制程序本身的危险行为。 |
| “超时就是网络问题” | 超时可能是执行预算、进程卡死或服务端终止。 |
| “后台命令返回就结束了” | 后台模式返回的是句柄；完成要轮询状态。 |
| “Session 是新的沙箱” | 它只是沙箱内的持久 shell，生命周期仍绑定沙箱。 |
| “PTY 已经进入公开契约” | 当前是参考实现扩展，SDK 支持程度不一。 |
| “`CodeInterpreter.aclose()` 会销毁沙箱” | 它只释放自己的客户端；沙箱仍由调用者负责。 |
| “指标流 SDK 一定有” | Python SDK 当前暴露快照，流要直接调 execd。 |

## 十九、通关自检（含参考答案）

**1. Shell 字符串和 argv 的安全差异是什么？**

Shell 字符串会把整段内容交给 shell 解释，分号、管道、变量替换都可能执行注入内容；argv 把程序和参数分开传递，参数按字面量进入进程，不经过 shell。但 argv 不限制程序本身，仍需允许清单和沙箱边界。

**2. `execution.text` 为什么不能作为完整诊断？**

它只合并 stdout 和 result，不包含 stderr；而失败原因经常只在 stderr 或 `error` 里。正确做法是分别拼接 stdout/stderr，并检查退出码和错误。

**3. 退出码为 0、stderr 有内容，算失败吗？**

不一定。很多程序把警告写到 stderr。失败判断应基于退出码、`execution.error` 和业务输出共同决定；但 stderr 不能丢弃，尤其当模型需要据此修正参数时。

**4. 命令超时和 HTTP 客户端超时有什么区别？**

命令超时是服务端执行预算，到点会终止进程；客户端超时可能只中断你的连接，不保证远端进程停止。两者要分别设置、分别诊断。

**5. 什么时候用后台命令，什么时候用 session？**

任务可能超过前台连接寿命时用后台命令，通过状态和日志轮询获取结果；需要在多次调用之间保持 `cd`、变量等 shell 状态时用 session。两者都不能替代沙箱生命周期管理。

**6. 为什么大文件要用 `read_bytes_stream`？**

一次性 `read_bytes` 会把整个文件放进内存，大文件可能撑爆进程；流式读取按块处理，可以把内存占用控制在固定范围。更好的做法是让计算发生在沙箱内，只把摘要带回。

**7. Code Interpreter 和普通命令的本质区别是什么？**

普通命令每次是一个进程，状态不自动保留；Code Interpreter 管理 Jupyter 内核上下文，变量和导入可以跨多次执行保留，结果以结构化形式返回。它需要包含 Jupyter 运行时的镜像。

**8. 为什么说“传输成功不等于命令成功”？**

SSE 的 HTTP 200 只表示请求被接受并开始推送事件；命令可能随后以非零退出码结束，也可能中途断开。真正的成功证据是完整的输出、退出码和错误字段。

### 完成清单

- [ ] 能用 argv 跑一个带空格、分号、引号的参数，并解释为什么更安全。
- [ ] 能同时读取 stdout、stderr、`exit_code` 和 `error`，给出正确判断。
- [ ] 能解释 `execution.text` 的边界和分片行尾问题。
- [ ] 能给命令设置超时，并区分超时、非零退出和连接错误。
- [ ] 能用 handlers 流式显示输出，并用 `skip_accumulation` 控制内存。
- [ ] 能跑一个后台任务，查询状态并用 cursor 增量读取日志。
- [ ] 能写文件、运行脚本、读取产物，并用流式接口读大文件。
- [ ] 能设计一个让模型知道“失败原因和下一步”的工具返回值。

## 二十、做完之后

现在你能把模型动作转换成带证据的副作用，并且知道如何限制它、如何解释失败。

但执行总是发生在某个地方。同样的 `commands.run`，在 Docker 上是容器里的进程，在 Kubernetes 上是 Pod 里的进程，在 FastSandbox 上是微虚拟机里的进程；池化、快照和模板又会改变“环境从哪来”。下一阶段处理运行时：**同一份契约，怎样落到不同的落脚点，以及为什么“接口支持”必须带上后端条件。**

带着这个问题进入下一章：**“同一个创建请求，凭什么能在三种完全不同的资源上跑出同一种行为？”**

进入[阶段 4](../stage-4/)。

---

*配套[学习路线](../learning-path/)阶段 3 编写 · 2026-10-30 · 基于 release-1.1.1（`531700ca`）*
