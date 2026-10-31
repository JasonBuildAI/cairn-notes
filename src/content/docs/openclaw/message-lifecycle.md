---
title: "OpenClaw 2026.10.9 源码课 · 01 一条消息的一生"
description: "追踪一条渠道消息从准入、Agent Loop、工具审批到 transcript 与回复的主线。"
---

> 基线：`openclaw-2026.10.9` 发布归档。本文路径都相对 `$OPENCLAW_SRC`。
> 本文只追一条真实执行主线：**一条外部消息怎样变成一次 Agent Run，最后又怎样回到原渠道或 UI。**
> 读完后你应该能回答：入口在哪里分叉？谁拥有 Session？谁有资格写 transcript？循环何时停？失败后怎样恢复？

## 一句话理解

OpenClaw 的一条消息不是“直接扔给模型”，而是经过一条有明确所有权边界的流水线：

```text
渠道 / WebChat / TUI / Node
        │
        ▼
入口适配：finalize 输入上下文 或 chat.send 准入
        │
        ▼
Agent ingress：恢复所有权 → 解析模型/会话 → 选 harness
        │
        ▼
Session writer fence：同一 session 只允许一个活跃写者
        │
        ▼
Agent Loop：模型流 → 工具批次 → steering → 下一轮
        │
        ▼
transcript commit / terminal outcome
        │
        ▼
ReplyDispatcher → 原渠道 / UI 事件
```

这条线里最重要的一句话是：**入口可以很多，但“Run 的语义”只有一套。**

## 0. 先看五道边界

理解 OpenClaw，不要从目录开始，而要从一条消息穿过的五道边界开始：

| 边界 | 要解决的问题 | 典型代码 |
| --- | --- | --- |
| 入口边界 | 消息从哪个渠道来？带什么身份、回复目标、附件？ | `src/auto-reply/dispatch.ts`、`src/gateway/server-methods/chat-send-handler.ts` |
| 准入边界 | 这次请求是否重复？是否该排队？谁能取消？ | `chat-send-admission.ts`、`agent-command.ts` |
| 会话边界 | 归哪个 sessionKey / sessionId？谁是当前 writer？ | `session-bootstrap.ts`、`runs.ts` |
| 执行边界 | 用哪个模型、哪个 harness、哪些工具、怎样循环？ | `run-entry.ts`、`harness/selection.ts`、`agent-loop.ts` |
| 结算边界 | 何时算 run 结束？回复怎样送达？失败怎样记录？ | `agent-runner-execution-outcome.ts`、reply dispatcher |

后面所有源码都能挂到这五道边界上。挂不上去的细节，先不要背。

## 1. 入口其实有三类

### 1.1 渠道入口

WhatsApp、Telegram、Slack、Discord、Signal、iMessage 等渠道把入站消息整理成 `MsgContext`，然后调用：

```ts
dispatchInboundMessage({ ctx, cfg, dispatcher, ... })
```

位置：`src/auto-reply/dispatch.ts:222`。

这条路径关心的是：**渠道消息怎样变成一次回复，并通过 `ReplyDispatcher` 按渠道节奏发出去。**

### 1.2 Gateway 程序入口

Control UI、WebChat、移动端、外部程序通过 Gateway WebSocket 发：

```json
{ "type": "req", "id": "...", "method": "chat.send", "params": { ... } }
```

处理入口在 `src/gateway/server-methods/chat-send-handler.ts`，准入在 `chat-send-admission.ts`。

这条路径关心的是：**请求幂等、即时 ACK、会话绑定、事件推送和断线恢复。**

### 1.3 CLI / TUI 入口

`openclaw tui`（别名 `terminal`、`chat`）有两条路：

- 不带 `--local`：连接已有 Gateway，和 WebChat 一样走 `chat.send` 一类的 RPC；
- 带 `--local`：在 TUI 进程内启动本地 runtime，并持有本地 state lock。

入口：`src/cli/tui-cli.ts:26`、`src/tui/tui.ts:604`。

所以 TUI 不是“另一个 agent”，它只是另一种前端。**界面差异不应该改变 Run 的核心语义。**

## 2. 渠道入口：先把输入变成“可执行上下文”

### 2.1 finalize 不是格式美化

`dispatchInboundMessage()` 第一件正事是：

```ts
const finalized = finalizeInboundContext(params.ctx);
```

位置：`src/auto-reply/dispatch.ts:253`。

`finalizeInboundContext()` 在 `src/auto-reply/reply/inbound-context.ts`。它把渠道原始上下文补齐成后续代码可以依赖的规范形状，例如会话键、发送者、回复目标、消息标识等。

这一步的意义不是“清洗字符串”，而是**建立后续所有阶段共享的事实源**。如果每个下游模块都自己猜 sessionKey 或 reply target，系统很快会出现“同一句话被分到两个会话”的问题。

### 2.2 群/线程先走专用路径

真正 dispatch 时：

```ts
return (await dispatchGroupThread(request, dispatch)) ?? (await dispatch(request));
```

位置：`src/auto-reply/dispatch.ts:289`。

顺序很重要：

1. 先判断是不是群聊/线程消息；
2. 如果是，先走 `dispatchGroupThread()`；
3. 它不接管时，才走普通的 `dispatchReplyFromConfig()`。

这样群聊里的“是否该回复、回复到哪个 thread”不会污染普通私聊路径。

### 2.3 ReplyDispatcher 是回复的所有者

`withReplyDispatcher({...})` 包住整次 dispatch，位置 `src/auto-reply/dispatch.ts:273`。

它负责三件事：

- 给本次 run 建立回复队列和发送生命周期；
- 在 agent 产生分段回复时按顺序投递；
- 在 run 结束时 settle，确保没有“agent 已结束但回复还没发完”的悬空状态。

不要把 `ReplyDispatcher` 当成简单回调。它是**输出侧的并发与顺序所有者**。

## 3. Gateway 入口：先准入，再分离执行

### 3.1 为什么 `chat.send` 不是同步等待模型

WebChat 不能等模型跑完再返回，否则连接一断、页面一刷新，请求和状态就全丢了。OpenClaw 的做法是：

1. 校验参数和会话权限；
2. 做幂等/去重准入；
3. 尽快 ACK；
4. 把真正的 agent dispatch 交给一个 detached 任务；
5. 后续通过事件流推送进度和结果。

`chat-send-handler.ts` 顶部的注释写得很直白：**chat.send owns admission, ACK timing, and detached dispatch handoff.**

### 3.2 幂等键是 `chat:${clientRunId}`

在 `chat-send-admission.ts`：

- 去重缓存写入 `chat:${clientRunId}`，见 `src/gateway/server-methods/chat-send-admission.ts:442`；
- 如果同一 run 仍在执行，会返回 `status: "in_flight"`，见同文件 `458`、`489` 行附近。

这意味着 `clientRunId` 不是日志装饰，而是**客户端重试的幂等身份**。同一个 `clientRunId` 重复发送，不应该产生两条并行 transcript。

### 3.3 ACK 之后谁拥有这次 turn

`startChatDispatch()` 在 `chat-send-agent-dispatch.ts:62`。它最终调用：

```ts
dispatchInboundMessageWithProjectedDispatcher({ ... })
```

见 `src/gateway/server-methods/chat-send-agent-dispatch.ts:315`。

所以渠道入口和 Web 入口不是两套 agent，而是：

- 渠道：直接构造 `MsgContext` 调 `dispatchInboundMessage()`；
- Gateway：`chat.send` 先做请求级准入，再构造同一类 dispatch 请求。

差异只在“输入从哪来、回复往哪送”，核心 Run 仍然汇合。

### 3.4 断线重连靠事件与快照，不靠重跑模型

Gateway 的响应是 `res` 帧，执行过程是 `event` 帧。客户端断线重连后，可以重新读 `chat.history` / `chat.startup` 一类快照，再订阅后续事件。

这就是为什么 `chat.send` 必须把“请求受理”和“执行完成”分开：

- 受理结果可以立即持久化/广播；
- 执行过程可以慢慢产生事件；
- 客户端不需要靠“再发一次”来恢复 UI。

## 4. 两条入口在 agent ingress 汇合

### 4.1 统一入口

两条路径最终都会进入：

```ts
agentCommandFromIngress(opts, runtime, deps)
```

位置：`src/agents/agent-command.ts:651`。

内部调用 `agentCommandFromIngressInternal()`（同文件 `585`），它做三件关键事：

1. 要求显式给出 `allowModelOverride`，防止 ingress 路径悄悄绕过模型策略；
2. 在 `withAgentRunLifecycleGeneration()` 下执行，绑定本次 run 的生命周期代号；
3. 通过 `runWithAgentCommandRecoveryOwner(..., mode: "claim", ...)` 取得这次执行的恢复所有权。

“claim”不是可选项。它保证同一 session 的恢复/接管不会出现两个 owner 同时认为自己该继续执行。

### 4.2 然后进入统一 agent command

准备好的参数进入：

```ts
agentCommandInternal(prepared, { kind: "api", boundary: "agent-command.from-ingress" }, ...)
```

位置：`src/agents/agent-command.ts:617`。

在这里会完成：

- session / agent / workspace 解析；
- 模型选择与 thinking 解析；
- 会话准入；
- 调用 `runEmbeddedAgentAttempt()`（`agent-command.ts:464`）；
- 处理 fallback、compaction 记账、session 持久化。

注意：`runEmbeddedAgentAttempt()` 是“尝试层”，它内部再进入 `runEmbeddedAgentEntry()`。不要把所有层都叫“runner”，否则读代码时很容易失去层次。

## 5. Session、Run、Writer：三个身份不要混

### 5.1 三个身份

| 身份 | 回答什么 | 生命周期 |
| --- | --- | --- |
| `sessionKey` | 这段对话在路由上属于谁？ | 长期，跨多个 run |
| `sessionId` | 这次对话的持久化记录是哪一份？ | 较长，可能因 compaction/重写变化 |
| `runId` | 这一次执行是哪一次？ | 一次输入到终止 |

`chat.send` 里 `clientRunId` 直接作为 `runId` 使用，但 `sessionId` 可能来自已有会话绑定。不要把三者当成同义词。

### 5.2 writer fence：同一 session 只有一个写者

`prepareEmbeddedRunSession()` 在 `src/agents/embedded-agent-runner/run/session-bootstrap.ts:265` 准备会话身份；真正抢写者资格的是：

```ts
claimAgentSessionWriter(params)
```

位置：`session-bootstrap.ts:523`。

关键步骤：

1. 校验当前 sessionId 没变；
2. 读取旧的 `activeWriterRunId`；
3. CAS 式写入 `{ activeWriterRunId: params.runId }`；
4. 如果旧 writer 存在且不是自己，调用 `supersedeEmbeddedAgentRunByRunId()`；
5. 旧 run 以 `superseded` 终止。

这解决的是“用户又发了一条，新 run 应该接管”以及“重启恢复后旧 run 不能继续写”的问题。

**没有 writer fence，两个 run 都可能把自己的工具结果写进同一条 transcript，历史会自相矛盾。**

### 5.3 两道 lane

`runEmbeddedAgentForSession()` 里：

```ts
const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
const globalLane = resolveGlobalLane(params.lane, params);
```

位置：`src/agents/embedded-agent-runner/run-orchestrator.ts:160`。

`resolveSessionLane()` 在 `src/agents/embedded-agent-runner/lanes.ts:10`，保证同一 session 的工作串行化；`resolveGlobalLane()` 在 `15` 行，负责全局资源/子 agent/cron 的并发预算。

两者不是重复：

- session lane 防止同一对话内并发写；
- global lane 防止整个进程被无限并发拖垮。

### 5.4 detached 模式

有些 run 是 detached 的：它不写持久 session 元数据，也不 claim 外层 deferral。见 `run-orchestrator.ts:164` 附近。

这不是“低优先级执行”，而是**明确选择不拥有持久会话生命周期**。读代码时看到 `sessionPersistence === "detached"`，要先问：这次 run 到底该不该影响长期会话？

## 6. 模型与 harness：先解析，再选执行器

### 6.1 逻辑模型 ref 不是厂商 URL

`resolveModelAsync()` 在 `src/agents/embedded-agent-runner/model.ts:84`。它负责把逻辑 provider/model 引用解析成可执行模型，并准备 auth storage、model registry 等。

解析顺序大致是：

1. 显式/配置指定模型；
2. 静态模型目录；
3. provider 动态目录；
4. 结合 auth profile、路由、workspace 约束。

失败信息会明确指出是“provider 未认证”“模型不在目录”“配置绑定到某个 runtime”等，而不是笼统报“模型不存在”。

### 6.2 候选链与失败决策

`resolveModelCandidateChain()` 在 `src/agents/model-fallback-candidates.ts:155`。

真正决策在 `src/agents/embedded-agent-runner/run/failover-policy.ts:103`，结果是三种之一：

- `rotate_profile`：换认证 profile；
- `fallback_model`：换模型；
- `surface_error`：把错误暴露给调用方。

`runEmbeddedAgentEntry()`（`run-entry.ts:161`）只让“被接受的赢家”推进会话；失败候选不会把半截 transcript 当成最终结果。

### 6.3 harness 是“执行器”，不是“模型”

`selectAgentHarness()` 在 `src/agents/harness/selection.ts:77`。内建 harness 是 `openclaw`，见 `src/agents/harness/builtin-openclaw.ts:84`；它的 `runAttempt` 调到 `runEmbeddedAttempt()`。

运行时 id 还有：

- `openclaw`：内建 embedded runner；
- `codex`：通过 `codex-app-server` 接入的外部 harness；
- `auto`：按配置/模型/账号选择。

这一步的意义：**模型接入和 agent 执行器是两件事。** 同一个模型可以被不同 harness 驱动；同一个 harness 也可以服务多个 provider。

## 7. Agent Loop：真正的推进器

主循环在 `packages/agent-core/src/agent-loop.ts`。

### 7.1 入口

```ts
runAgentLoop(prompts, context, config, emit, signal, streamFn, runtime)
```

位置：`agent-loop.ts:81`。

它先把 prompt 消息提交到 context，再进入 `runLoop()`（`118` 行之后的内部函数）。`runAgentLoopContinue()`（`118`）则从已有 context 继续，不重复提交初始 prompt。

### 7.2 双层循环

外层 `while (true)` 在 `215` 行；内层：

```ts
while (hasMoreToolCalls || pendingMessages.length > 0)
```

位置：`218` 行。

这两个条件分别代表：

- 还有工具调用/模型要求继续；
- 还有排队消息或 steering 需要注入。

只有两者都为空，才可能退出内层，再去取 follow-up（`446` 行）。

### 7.3 一轮里发生什么

按源码顺序：

1. **abort 检查**（`219`）；
2. **提交 pending / steering**（`230-237`）；
3. **prepareContinuation**：允许下一轮替换 systemPrompt/tools（`243-254`）；
4. **注入内部 steering 队列**（`256-265`）；
5. **`streamAgentResponse()`** 调模型并流式产出（`269`）；
6. **工具批执行**（`276`，最终到 `executeToolCalls()` `461`）；
7. **处理未执行的 terminal tool calls**（`299-322`）；
8. **计算 `hasMoreToolCalls`**（`329-334`）；
9. **发 `turn_end`**（`344`）；
10. **abort / terminate / provider failure 分支**（`350-388`）；
11. **`prepareNextTurn()`** 可替换 model/thinking/context，并决定是否停（`390`）；
12. **follow-up drain**（`446`），没有才 `agent_end`（`457`）。

### 7.4 steering 的边界

steering 不是“随时强行打断工具”。源码里的规则是：

- 在执行前/批次边界检查 steering；
- 已经开始执行的工具不会被中途掐断；
- 尚未开始的工具可以跳过，并生成成对的 synthetic error / skipped result，保证 tool call 与 tool result 仍然配对。

相关实现：`executeToolCalls()` 的批次逻辑，以及 `completeUnstartedToolCall()`（`agent-loop.ts:1331` 附近）。

这条设计很重要：**模型看到的 transcript 必须保持协议合法。** 不能出现“工具调用没有结果”这种半截历史。

### 7.5 什么时候停

至少五类终止：

| 终止原因 | 触发点 |
| --- | --- |
| 自然停止 | 没有更多工具调用、没有 pending，`getFollowUpMessages()` 为空 |
| 用户 abort | `stopIfAborted()` / `stopReason === "aborted"` |
| provider 失败 | `message.stopReason === "error"`，`385` 行 |
| 工具循环恢复终止 | `executedToolBatch.terminateRun`，`362` 行 |
| 下一轮策略停止 | `prepareNextTurn().stop` 或 `shouldStopAfterTurn()`，`418-443` |

“模型说完了”只是其中一种，不是唯一条件。

## 8. 上下文不是一份字符串

一次模型请求的上下文至少由四层拼成：

1. **system prompt**：身份、规则、工具目录、技能目录、runtime 信息；
2. **workspace bootstrap**：`AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`BOOTSTRAP.md`、`MEMORY.md`；
3. **transcript**：历史消息与工具结果；
4. **本轮动态注入**：steering、系统更新、compaction 摘要。

system prompt 构建在 `src/agents/system-prompt.ts:284`；bootstrap 在 `src/agents/bootstrap-files.ts:397`。

### 8.1 bootstrap 有硬预算

配置说明在 `src/config/schema.help.models.ts:152-155`：

- 单文件默认最多 `20000` 字符；
- 所有 bootstrap 文件合计默认最多 `60000` 字符。

超出会截断，并由 `src/agents/bootstrap-budget.ts:122` 生成预算诊断。子 agent 默认只注入 `AGENTS.md`，避免把主 agent 的全部人格文件复制给每个子任务。

### 8.2 compaction 与 pruning 不是一回事

- **compaction**：当上下文逼近窗口时，把旧历史总结成摘要，并写回 transcript；实现 `packages/agent-core/src/harness/compaction/compaction.ts`。
- **cache-TTL pruning**：只裁剪“发给模型的投影”，不改磁盘 transcript；实现 `src/agents/embedded-agent-runner/tool-result-truncation.ts`。

这个区分是读 OpenClaw 上下文机制的关键。前者改变历史，后者只改变本次视图。

## 9. 工具：装配、准入、审批、执行

### 9.1 工具是装配出来的

`assembleOpenClawCodingTools()` 在 `src/agents/agent-tools.ts:97`，它按以下层次组合：

- capability / tool profile；
- workspace 与 sandbox policy；
- core coding tools（`createCoreCodingTools()`，`src/agents/core-coding-tools.ts:202`）；
- OpenClaw 自有工具；
- plugin tools；
- channel tools；
- 最终 authorization。

`createOpenClawCodingToolsInternal()` 在 `agent-tools.ts:630`，异步版本在 `642`。

**工具不是静态列表。** 同一句“读文件”，在不同 surface、不同 sandbox、不同审批策略下，可能是不同实现。

### 9.2 before_tool_call 的顺序是行为

`src/agents/agent-tools.before-tool-call.policy.ts` 文件头明确写了顺序：

1. loop admission；
2. owner probes；
3. voice confirmation；
4. trusted policies；
5. approvals；
6. normal hooks；
7. final owner approval。

这不是“代码风格”，而是安全语义。把审批放到 hook 后面，恶意/错误 hook 就可能先改参数再骗过审批。

### 9.3 审批模式

`resolveBeforeToolCallApprovalOutcome()` 在 `agent-tools.before-tool-call.approval.ts:470`，支持：

- `defer`：把审批推迟到执行边界；
- `report`：只报告，不阻塞；
- `deny`：直接拒绝；
- `request`：立即请求人工审批。

非交互 surface 可能直接 deny，而不是无限等待。这是“渠道能力不同，但安全底线相同”的体现。

## 10. 结算：run 结束不等于回复送达

### 10.1 统一记录 terminal outcome

`runAgentTurnWithOutcome()` 在 `src/auto-reply/reply/agent-runner-execution-outcome.ts:96`。

它做三件事：

1. 用 `withExecRequestTurn()` 绑定 `runId/sessionKey/sessionId/agentId`（`110`）；
2. 执行真正的 turn；
3. 记录 `recordAgentTurnExecutionOutcome()`（`125`），并发布 terminal event（`127`）。

异常路径也会记录一次失败 outcome（`130-133`），避免“run 消失了但没有终止事实”。

### 10.2 两层“结束”

- **Agent Run 结束**：`agent_end` 事件、terminal outcome 持久化；
- **Reply 送达结束**：`ReplyDispatcher` settle、渠道发送完成。

两者不能混。一个 run 可能已经 `agent_end`，但回复还在队列里等待发送；也可能回复发送失败，但 agent 已正常结束。排障时要先判断卡在哪一层。

## 11. 失败矩阵

| 现象 | 最可能的位置 | 先看什么 |
| --- | --- | --- |
| 同一请求重复产生两条 turn | `chat.send` 幂等 | `clientRunId` 是否稳定、`chat:${clientRunId}` 是否命中 |
| 新消息把旧 run 顶掉 | writer fence | `activeWriterRunId`、`superseded` 事件 |
| 模型报错但没有 fallback | failover 决策 | `resolveRunFailoverDecision()`、候选链是否为空 |
| 工具一直等审批 | approval 链 | `approvalMode`、surface 是否可交互、超时 |
| agent 结束但 UI 没消息 | reply dispatcher | `runAgentTurnWithOutcome()` 后的 terminal event、dispatcher settle |
| 重启后旧任务继续写 | 恢复所有权 | recovery owner 的 claim、lifecycle generation |
| 上下文突然变短 | compaction | 摘要是否写回、cut point 在哪 |
| 工具结果消失但 transcript 还在 | cache-TTL pruning | 当前 prompt 投影，不是磁盘历史 |

## 12. 调试 recipe

在源码根目录执行：

```powershell
rg -n "chat\.send|admitChatSend|chat:\$\{clientRunId\}" src/gateway
rg -n "claimAgentSessionWriter|activeWriterRunId|superseded" src/agents
rg -n "agentCommandFromIngress|runEmbeddedAgentAttempt|runEmbeddedAgentEntry" src/agents
rg -n "streamAgentResponse|prepareNextTurn|agent_end" packages/agent-core/src/agent-loop.ts
rg -n "recordAgentTurnExecutionOutcome|terminal" src/auto-reply
```

建议按这个顺序读日志：

1. 先找 `clientRunId`：确认是不是同一次请求；
2. 再找 `sessionKey/sessionId`：确认有没有串会话；
3. 再找 `activeWriterRunId`：确认有没有被接管；
4. 再找 `provider/model` 与 fallback step：确认模型是否切换；
5. 最后找 `turn_end` / `agent_end` / reply settle：确认卡在循环还是输出。

## 13. 常见误解

**误解 1：渠道消息直接进入模型。**
错。先 finalize 输入上下文，再走 reply 配置、会话准入、工具/模型装配。

**误解 2：`chat.send` 返回成功就代表模型跑完了。**
错。它先 ACK 受理，真正执行是 detached dispatch，结果靠事件流和快照。

**误解 3：`sessionKey` 和 `sessionId` 是一回事。**
错。前者是路由身份，后者是持久化记录身份；compaction/重写可能改变后者。

**误解 4：writer fence 只是防重复写入。**
不只是。它还定义“新 run 接管旧 run”的合法方式，旧 run 必须以 `superseded` 终止。

**误解 5：compaction 和 pruning 都在删历史。**
只有 compaction 改写 transcript；pruning 只改本次 prompt 投影。

**误解 6：工具审批是插件 hook 的一部分。**
审批链在普通 hook 之前，且有独立的 owner/最终放行阶段。

## 14. 自测与练习

### 自测

1. 画出渠道入口和 `chat.send` 入口的汇合点，并标出各自独有的步骤。
2. 解释 `clientRunId`、`sessionKey`、`sessionId`、`runId` 的区别。
3. 为什么 `chat.send` 要先 ACK？如果不这样，断线重连会怎样？
4. writer fence 发现旧 writer 时，为什么必须让旧 run 以 `superseded` 结束，而不能静默忽略？
5. Agent Loop 的内层循环有哪两个继续条件？分别由谁填充？
6. steering 到达时，为什么不能强行中断已经执行的工具？
7. compaction 与 cache-TTL pruning 分别改变什么？各自的所有者是谁？
8. `agent_end` 之后还可能发生什么？

### 练习

- 在 `chat-send-admission.ts` 里找到 `in_flight` 的所有返回点，画一张“重复请求状态机”。
- 在 `session-bootstrap.ts` 里跟踪一次 writer 接管，写出旧 run 的终止路径。
- 在 `agent-loop.ts` 里给每个 `return newMessages` 标注终止原因。
- 选一个工具，从 `agent-tools.ts` 追到实际执行函数，标出它经过的 policy/approval 层。
- 人为构造一个 provider 错误，观察 fallback 事件与最终 session 是否只推进一次。

---

### 自测参考答案

1. **渠道入口**：`dispatchInboundMessage` → `finalizeInboundContext` → 群/线程专用分支 → `dispatchReplyFromConfig` → 统一 agent command；独有的是渠道上下文归一化和 `ReplyDispatcher` 输出。**Gateway 入口**：`chat.send` → 参数/权限/幂等准入 → ACK → detached dispatch → 统一 agent ingress；独有的是 WebSocket 连接、事件推送和断线恢复。两条线在 agent command/embedded runner 汇合，Session 仍由 Gateway 拥有。
2. `clientRunId` 是客户端重试的幂等身份；`sessionKey` 是 Gateway 的路由身份，决定消息落到哪段对话；`sessionId` 是持久化记录身份，compaction/重写后可能变化；`runId` 是一次执行的身份，通常可由 `clientRunId` 派生，但语义不同。
3. 因为模型执行可能很久，连接断开/页面刷新不能把请求一起丢掉。先 ACK 把请求变成可恢复的已接纳事实，执行 detached 继续；客户端用事件和快照恢复。若同步等待模型，断线后既没有稳定受理凭据，重试还可能重复执行。
4. 旧 writer 必须显式以 `superseded` 终止，才能让“单一 writer”成为可审计事实：旧 run 不得再追加 transcript，资源可以按终态释放。静默忽略会让旧进程继续写、造成交错或重复副作用，也无法判断谁拥有最终状态。
5. 内层：`hasMoreToolCalls || pendingMessages.length > 0`，由工具批次和待注入消息填充；外层：`getFollowUpMessages()`，由用户在 run 结束边界追加的 follow-up 填充，使补充消息仍属于同一逻辑执行。
6. 已启动的工具可能已经产生外部副作用，强行中断会留下半执行状态；steering 只在安全检查点生效，让已启动工具完成，尚未启动的调用生成 `skipped`/synthetic error，从而保持 tool call/result 配对。
7. **compaction** 改写历史结构并写摘要，所有者是 harness/`packages/agent-core` 的 compaction 机制；**cache-TTL pruning** 只改下一次请求的 tool result 投影，所有者是 embedded-agent runner 的 truncation 层，磁盘 transcript 不变。
8. `agent_end` 之后还有：terminal outcome 记录、transcript commit、ReplyDispatcher settle/发送、session/lifecycle 元数据更新与资源释放。模型停止只表示循环结束，不表示回复已经送达。

### 练习参考做法

- **`in_flight` 状态机**：无去重记录 → 准入并进入 in-flight；同 `clientRunId` 在 in-flight → 直接返回 in-flight，不再创建 run；终态记录存在 → 返回原结果；记录过期/缺失 → 才允许重新准入。验收点是同一幂等键最多产生一份执行和一份 transcript。
- **writer 接管**：读旧 `activeWriterRunId` → 条件 CAS 写入新 runId；CAS 失败说明 session 已变或有并发 claim，应重新读取后重试或返回冲突，不能无条件覆盖。成功后对旧 run 调用 supersede，旧 run 以 `superseded` 收尾。
- **`return newMessages` 标注**：至少区分自然无工作、abort、provider error、tool-loop terminate、strategy stop、superseded；每种都要说明由哪一层负责终态和清理。
- **工具追踪**：从 `agent-tools` 装配点记录 capability/profile → tool policy/approval → sandbox/executor，最后断言拒绝、跳过、成功三种结果都能变成匹配的 tool result。
- **provider fallback**：观察是 `rotate_profile` 还是 `fallback_model`；失败候选的 assistant error 不得污染最终 transcript；只有被接受的候选才能推进 session。


*OpenClaw 2026.10.9 · 一条消息的一生*
