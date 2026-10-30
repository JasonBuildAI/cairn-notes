---
title: "阶段 7：界面与集成"
description: "TUI、print、JSON、RPC 与 SDK：同一引擎如何服务不同入口。"
---

> **本阶段的位置**：前面几章已经讲清循环、上下文、工具、模型和扩展。现在回答一个产品问题：同一套 Agent 引擎，怎样同时给终端里的人、脚本和外部程序使用？
> **源码目录**：`$PI_SRC`。核心材料：`docs/cli-integration.md`、`json.md`、`rpc.md`、`sdk.md`、`tui.md`。
> **一句话主线**：**引擎只产生状态和事件；不同界面只是这些事件的不同消费者。**

## 一、为什么需要多种界面

同样是让 Agent 工作，不同用户要的东西完全不同：

- 人在终端里协作，需要看到流式文字、工具进度、确认框和可编辑输入；
- Shell 脚本只想要最后一段回答，方便放进管道；
- 监控程序想知道每一步工具调用、耗时和 token 用量；
- IDE 或桌面应用想双向控制一个长期运行的 Pi；
- Node 程序想把 Agent 直接嵌进自己的进程。

如果每种需求都复制一套循环、会话和工具逻辑，会很快失去一致性：某一种界面支持压缩，另一种不支持；某一种界面能中止，另一种不能。

Pi 的做法是：

```text
                  ┌── 交互 TUI
                  ├── print（最终文本）
同一 AgentSession ─├── JSON（结构化事件）
                  ├── RPC（双向命令与事件）
                  └── SDK（进程内 API）
```

外壳负责“怎样输入、怎样输出、进程活多久”，不负责重新实现 Agent。

---

## 二、五种形态先分清

### 2.1 对比表

| 形态 | 输入 | 输出 | 生命周期 | 最适合 |
| --- | --- | --- | --- | --- |
| 交互 TUI | 终端键盘 | 实时界面 | 直到用户退出 | 人直接和 Pi 协作 |
| print | 命令行参数/管道 | stdout 最终文本 | 一次运行 | 脚本、命令替换、一次性任务 |
| JSON | 命令行参数 | stdout 的 JSONL 事件 | 一次运行 | 程序需要结构化过程 |
| RPC | stdin 的 JSONL 命令 | stdout 的响应和事件 | 长驻 | 跨语言、IDE、自定义客户端、进程隔离 |
| SDK | TypeScript 方法 | 进程内事件与返回值 | 宿主控制 | Node/Bun 进程内嵌入 |

注意：**SDK 不是 CLI 模式**。TUI、print、JSON、RPC 都是启动 Pi 进程的方式；SDK 是把 Pi 的库直接嵌进你的进程。

### 2.2 怎么选

按这个顺序问自己：

1. **是人坐在终端前吗？** 是 → 交互 TUI。
2. **只关心最后回答吗？** 是 → print。
3. **要跟随一次运行的结构化过程吗？** 是 → JSON。
4. **宿主不是 Node/Bun，或需要进程隔离/长期双向控制吗？** 是 → RPC。
5. **宿主就是 Node/Bun，想直接拿完整 API 吗？** 是 → SDK。

一个常见判断：

```text
“我写个 PowerShell 脚本批量跑任务，只要结果”
  → print 或 JSON

“我在写 VS Code 插件，要显示工具进度并允许用户中途插话”
  → RPC

“我在写 Node 服务，想把 Agent 当成库调用”
  → SDK
```

---

## 三、一条事件怎样走到不同界面

### 3.1 三层事件

阶段 5 已经区分过三层事件：

```text
模型厂商流事件
    ↓ 由 provider 适配器翻译
模型层 AssistantMessageEvent
    ↓ 由 Agent 循环翻译
Agent / Session 事件
    ↓ 由界面适配器消费
TUI / print / JSON / RPC / SDK 订阅者
```

界面不直接解析 OpenAI 或 Anthropic 的 SSE。它只认 `agent_start`、`message_update`、`tool_execution_start` 这类统一事件。

### 3.2 事件是架构接口，不是日志副产物

同一个事件流同时支持：

- TUI 更新界面；
- JSON 模式输出 JSONL；
- RPC 转发给外部进程；
- SDK 回调给宿主程序；
- 测试断言执行顺序；
- 调试时还原系统做了什么。

所以“事件设计得好不好”会直接影响所有界面。把事件当 println 日志，会导致某个界面只能靠猜状态。

### 3.3 统一语义

所有形态共享几个关键语义：

- `message_update` 提供增量，最终以 `message_end` 为准；
- 一个 turn 是一次模型回复及其工具执行；
- `agent_end` 只是底层循环结束；
- `agent_settled` 才表示没有自动重试、压缩恢复或排队工作；
- 工具执行有开始、更新、结束，按 `toolCallId` 关联。

如果某种界面自己发明“结束”的定义，外部程序就会出现竞态。

---

## 四、print：最像 Unix 工具的形态

### 4.1 它做什么

```powershell
cd $PI_SRC
.\pi-test.ps1 --print "用一句话总结这个仓库"
```

输出只有最终助手文本，适合：

- 命令替换；
- 管道；
- 一次性批处理；
- 不需要中间过程的任务。

### 4.2 自动切换

当 stdin 或 stdout 被重定向，且没有显式选择 JSON/RPC 时，Pi 会自动用 print 模式。因此：

```powershell
Get-Content README.md | .\pi-test.ps1 "解释这段文档"
```

可以直接工作。

注意：`--mode text` 在终端里仍可能打开 TUI；要强制一次运行并退出，用 `--print`。

### 4.3 错误与退出码

print 模式的约定比较适合脚本：

- 错误写 stderr；
- 最终回答是 `error` 或 `aborted` 时，退出码非零；
- 被模型输出上限截断（`length`）时，可能仍打印部分文本，但 stderr 给出警告，退出码非零。

所以脚本判断成功与否，不能只看 stdout 有没有字，还要看退出码。

---

## 五、JSON：给程序看的过程

### 5.1 它输出什么

```powershell
.\pi-test.ps1 --mode json "检查这个仓库" > events.jsonl
```

第一行是会话头：

```json
{"type":"session","version":3,"id":"...","timestamp":"...","cwd":"..."}
```

后面是一条条事件，每行一个 JSON 对象：

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

这不是“最终结果的 JSON 包装”，而是一次运行的过程记录。

### 5.2 为什么 stdout 只能放协议记录

如果程序在读 JSONL，而 Pi 又往 stdout 打了一行普通日志：

```text
Connecting...
{"type":"agent_start"}
```

读取方就无法区分“日志”和“事件”。所以 JSON/RPC 模式必须遵守：

- stdout 只写协议记录；
- 日志、诊断、错误提示写 stderr；
- 每行恰好一个 JSON 对象；
- 以 LF 结束；
- 读取方按 LF 切分，不把字符串里的 Unicode 行分隔符当换行。

最后一条很容易踩坑：JSON 字符串里可以合法包含 `U+2028` / `U+2029`，某些通用行读取器却会把它们当换行，导致一条记录被切碎。

### 5.3 `message_update` 为什么是增量

如果每一帧都把“目前完整消息”发一遍，流的大小会随回复长度近似平方增长。Pi 的 JSON 事件里，`message_update` 只带增量和内容索引：

```json
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"你好"}}
```

实时显示时可以拼接这些增量；但最终要以 `message_end.message` 为权威结果，因为流式拼接可能遇到分片、工具参数或厂商修正。

### 5.4 什么时候算真正结束

看 `agent_settled`，不是只看 `agent_end`：

```text
agent_end       = 这一轮底层 Agent 循环结束
agent_settled   = 自动重试、压缩恢复、排队消息都处理完了
```

只等 `agent_end` 就退出程序，可能错过后续自动工作。

---

## 六、RPC：让另一个程序长期控制 Pi

### 6.1 协议长什么样

RPC 用 stdin 发命令，用 stdout 收响应和事件：

```text
你的程序 ── JSON 命令 ──→ Pi 子进程
你的程序 ←─ JSON 响应/事件 ─ Pi 子进程
```

适合：

- 非 Node 语言；
- IDE 或桌面客户端；
- 需要进程隔离；
- 要多次发任务、改模型、检查状态。

启动：

```powershell
.\pi-test.ps1 --mode rpc --no-session
```

### 6.2 命令与响应怎样对应

命令可以带一个 `id`：

```json
{"id":"req-1","type":"get_state"}
```

响应会带回同一个 ID：

```json
{"id":"req-1","type":"response","command":"get_state","success":true,"data":{...}}
```

命令处理是异步的，所以不要假设“响应一定按发送顺序回来”。并发发送时，用 ID 关联。

### 6.3 `prompt` 成功不等于任务完成

这是 RPC 最容易犯的错：

```json
{"id":"req-2","type":"prompt","message":"检查仓库"}
```

收到成功响应只表示：

- 提示词被接受；
- 或者被排队；
- 或者被扩展处理了。

它不表示模型已经回答完。真正的完成仍然要看事件流，直到 `agent_settled`。

因此：

1. 先订阅事件；
2. 再发送 prompt；
3. 等待 `agent_settled`；
4. 再决定关闭或继续下一轮。

如果先发 prompt 再订阅，快速完成的任务可能在你订阅之前就结束了。

### 6.4 RPC 和 JSON 的区别

事件形状大体相同，但：

- JSON 一次运行后退出；
- RPC 长驻，可反复下命令；
- JSON 有会话头，RPC 没有，需要查状态；
- RPC 还有命令响应和扩展 UI 子协议。

所以不要把 RPC 当成“能发多次 prompt 的 JSON 模式”那么简单；它是一个双向协议。

---

## 七、SDK：把 Agent 嵌进 Node/Bun

### 7.1 最小用法

```ts
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();

const unsubscribe = session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  await session.prompt("解释这个仓库");
} finally {
  unsubscribe();
  session.dispose();
}
```

这段代码体现了 SDK 的核心：

- 创建会话；
- 先订阅；
- 调用 `prompt()`；
- 用完 `dispose()`。

### 7.2 SDK 和 RPC 的取舍

| 维度 | SDK | RPC |
| --- | --- | --- |
| 语言 | TypeScript/JavaScript | 任意能读写 JSONL 的语言 |
| 进程 | 与宿主同进程 | 独立子进程 |
| 控制 | 直接方法调用 | JSON 命令 |
| 故障隔离 | 共享进程，风险更大 | 子进程可单独重启 |
| 部署 | 需要 Node/Bun 依赖 | 只需可执行文件 |

如果宿主就是 Node/Bun，SDK 少一层进程边界，通常更直接；如果要跨语言或隔离，RPC 更合适。

### 7.3 SDK 的会话边界

`SessionManager` 才拥有持久化会话和活动分支。直接改 `session.agent.state.messages` 不会自动改写持久化上下文。

需要内存会话时，可以显式传入：

```ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});
```

这类边界很重要：**界面层可以换，但会话树和投影仍由核心决定。**

---

## 八、TUI：事件的一个复杂消费者

### 8.1 TUI 不等于 Agent

交互界面做的是：

- 读取键盘和粘贴；
- 维护输入编辑器；
- 显示流式消息；
- 显示工具调用和结果；
- 显示确认框、状态栏和选择列表；
- 把用户输入交给 `AgentSession`。

它不负责决定模型何时调用工具，也不负责压缩上下文。

### 8.2 差分渲染为什么重要

如果每次有增量都把整屏重新输出：

- 数据量大；
- 终端闪烁；
- 滚动位置容易乱；
- 远程连接下明显卡顿。

差分渲染只重写发生变化的部分。你在屏幕上感觉“整块内容更新了”，实际发送的通常只是几行变化。

这是一个很典型的分层结果：Agent 产生细粒度事件，TUI 决定怎样便宜地画出来。

### 8.3 输入为什么要单独处理

在 raw mode 下，终端不再替你回显字符，也不能简单依赖 Ctrl+C 的默认信号行为。TUI 必须自己处理：

- 普通字符；
- 方向键和组合键；
- 粘贴；
- 鼠标；
- 提交与取消；
- 覆盖层和焦点。

这就是为什么 TUI 是一个独立包，而不是几十行 `console.log`。

---

## 九、实际观察与实验

### 实验 1：比较 print 与 JSON

```powershell
cd $PI_SRC
.\pi-test.ps1 --print "用两句话介绍这个仓库" > answer.txt
.\pi-test.ps1 --mode json "用两句话介绍这个仓库" > events.jsonl
```

对比：

- `answer.txt` 里是什么？
- `events.jsonl` 里有多少类事件？
- 最终文本对应哪条 `message_end`？
- `agent_end` 和 `agent_settled` 在哪里？

### 实验 2：统计工具调用

```powershell
Get-Content events.jsonl | ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object type -eq 'tool_execution_start' |
  Group-Object toolName |
  Select-Object Name, Count
```

再统计每次工具执行的 `durationMs`。这就是“用事件流做可观测性”的最小例子。

### 实验 3：跑通 SDK 最小例子

在仓库根目录运行：

```powershell
npx tsx packages/coding-agent/examples/sdk/01-minimal.ts
```

观察它是否：

- 先订阅事件；
- 输出流式文本；
- 在 `prompt()` 结束后释放会话。

### 实验 4：跑通 RPC 客户端

RPC 例子通常需要先构建 CLI：

```powershell
npm run build --workspace=@earendil-works/pi-coding-agent
npx tsx packages/coding-agent/examples/rpc-client.ts "用一句话介绍这个仓库"
```

观察客户端如何等待 `agent_settled`，而不是只看 prompt 的响应。

---

## 十、常见误区

| 误区 | 正确理解 |
| --- | --- |
| 每种界面都有一套自己的 Agent | 它们共享同一套 AgentSession、循环、工具和会话 |
| print 和 JSON 只是输出格式不同 | print 只给最终文本；JSON 给完整过程且要求协议纯净 |
| `agent_end` 就是任务结束 | 后面可能还有重试、压缩恢复和排队工作 |
| `prompt` 成功响应就是模型答完了 | 只表示提示词被接受、排队或处理，真正完成看 `agent_settled` |
| JSON 模式里模型报错一定退出非零 | 失败会出现在事件里，不一定直接改变退出码；要检查事件 |
| RPC 就是“多轮 JSON” | 它是双向长驻协议，有命令 ID、响应、事件和 UI 子协议 |
| SDK 和 RPC 只是写法不同 | SDK 同进程，RPC 跨进程；隔离、语言和部署边界不同 |
| TUI 自己决定 Agent 何时停止 | TUI 只是事件消费者，停止语义来自核心 |
| stdout 里多一行日志无所谓 | JSON/RPC 的 stdout 是协议通道，混入日志会破坏解析 |

---

## 十一、通关自检

请回答：

1. 为什么同一套引擎可以同时支持 TUI、print、JSON、RPC 和 SDK？
2. 什么场景应该选 print，什么场景必须选 JSON？
3. JSON 模式为什么要求 stdout 纯净？日志应该去哪里？
4. `message_update` 和 `message_end` 各是什么角色？
5. RPC 中 `prompt` 响应为什么不能当作完成信号？
6. SDK 与 RPC 的进程边界差别会带来什么取舍？
7. TUI 的差分渲染和 Agent 的事件流是什么关系？
8. 为什么 `agent_end` 和 `agent_settled` 必须区分？

建议产出：

- [ ] 一张五种形态的选型表；
- [ ] 一份 print 输出和一份 JSON 事件流；
- [ ] 一个统计工具调用次数/耗时的脚本；
- [ ] 一个能跑通的 SDK 或 RPC 最小客户端；
- [ ] 一段 3 分钟讲解，说明“界面只是事件的消费者”。

下一站是阶段 8：工程化。会写功能之后，还要学会让改动可测试、可检查、可回归。

---

*配套[学习路线](../learning-path/)阶段 7 · 基于 v1.3.0（`71023aec`）*
