---
title: "阶段 2：入口与 Agent Loop"
description: "阶段 2：入口与 Agent Loop。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：OpenClaw 源码课 · 阶段卷
> 前置：阶段 1
> 对应总览：`message-lifecycle.md` 的执行部分
> 本阶段目标：看清渠道 ingress 如何汇合，以及循环的模型轮、工具批次、steering 与 follow-up。

## 1. 本阶段解决什么

进入 runner 后，系统仍然面对不同入口：Telegram 消息、WebChat、TUI、自动任务。入口差异不能改变执行语义。本阶段回答：

- 渠道上下文在哪里归一化？
- 渠道入口与 `chat.send` 在哪里汇合？
- 一次 turn 何时继续、何时结束？
- 工具批次怎样并行/串行？
- steering 到达时，已启动工具怎么办？
- follow-up 为什么能属于同一逻辑执行？

## 2. 先记住一个判断

**Agent Loop 不是 `while(true) call model`，而是“模型轮 + 工具批次 + 安全边界”的两层循环。**

内层处理当前 turn 的工具/pending，外层处理 turn 结束后的 follow-up；任何一层都不能绕过 writer/transcript 的所有权。

## 3. 源码主线

1. `dispatchInboundMessage()` 在 `src/auto-reply/dispatch.ts:222` 接收渠道上下文。
2. `finalizeInboundContext()` 补齐 sessionKey、发送者、回复目标等共享事实。
3. 群/线程先走专用 dispatch，再进入 `dispatchReplyFromConfig()`；回复由 `ReplyDispatcher` 拥有。
4. 渠道路径与 `chat.send` 路径在统一 agent command/embedded runner 汇合。
5. `runAgentLoop()` 在 `packages/agent-core/src/agent-loop.ts:81` 启动；`runAgentLoopContinue()` 在 `118` 继续已有 context。
6. 两者进入 `runLoop()`（`140`）：模型流、工具批次、`prepareNextTurn()`、follow-up、`agent_end`。
7. `executeToolCalls()`（`461`）与 `executeToolCallGroups()`（`567`）处理批次准入、并行/串行、steering 跳过和 tool result 配对。

## 4. 关键对象与合同

| 对象 | 作用 | 失败风险 |
| --- | --- | --- |
| `ctx` / finalized context | 归一化渠道事实 | 每个下游自己猜 sessionKey |
| `ReplyDispatcher` | 分段回复的顺序与 lifecycle | 模型结束但回复未送达 |
| `runLoop` | 一次逻辑执行的循环 | 无界工具循环 |
| `pendingMessages` | steering 注入 | 与已执行工具冲突 |
| `getFollowUpMessages()` | turn 结束后的补充 | 被误当新 run |
| tool batch | 一次模型调用的多个工具 | 并发冲突/配对缺失 |
| `prepareNextTurn()` | 下一轮 system prompt/tools 调整 | 破坏身份或策略 |

### 内层与外层

```text
内层：hasMoreToolCalls || pendingMessages.length > 0
外层：getFollowUpMessages()
```

内层解决“这一轮还没完”；外层解决“这一轮结束后，用户/系统又补了话”。

### steering 的边界

`steer` 在安全点注入当前 run：已经进入执行边界的工具继续完成；尚未启动的调用可生成成对的 skipped/synthetic error result。它不创建第二个 run，也不强行中断已产生副作用的工具。

## 5. 一条可观察链路

```text
渠道 ctx / chat.send
  → finalized context
  → agent command
  → runAgentLoop
  → stream model
  → tool calls
  → beforeToolBatch / policy
  → executeToolCallGroups
  → tool results
  → prepareNextTurn
  → 内层继续 / 外层 follow-up / agent_end
```

## 6. 实验

### 实验 A：追踪入口汇合

从 `dispatchInboundMessage` 和 `chat.send` 分别追到 `runAgentLoop`。参考验收：能指出两者独有步骤与共享 runner，不把渠道层当 Agent。

### 实验 B：制造工具循环

让模型连续调用两个需要结果才能继续的工具。参考验收：内层在工具结果后继续模型轮；达到终止条件才退出，不无限循环。

### 实验 C：中途 steering

在工具批次执行中注入 steering。参考验收：已启动工具完成；未启动调用跳过并补配对 result；不出现孤立 tool call。

### 实验 D：follow-up

在 turn 自然结束后追加一条消息。参考验收：外层通过 `getFollowUpMessages()` 继续同一逻辑执行，而不是立即新开 run。

### 实验参考答案

1. 渠道 `dispatchInboundMessage` 与 `chat.send` 各有自己的准入/载荷步骤，但最终汇入共享 runner 和 `runAgentLoop`。
2. 工具结果写入后，内层模型轮继续；只有达到终止条件、预算或错误才结束，不能把一次工具返回当最终答案。
3. 已启动工具正常完成；未启动调用补 skipped/error result，保持 call/result 配对，不产生孤立 tool call。
4. 自然结束后追加消息可由外层 `getFollowUpMessages()` 继续同一逻辑运行，而不是立刻新建 run。

## 7. 失败与恢复

| 现象 | 根因 | 恢复 |
| --- | --- | --- |
| 模型一直调工具 | 无终止/预算边界 | 触发 loop terminate，记录终态 |
| steering 后历史断裂 | 未补 skipped result | 为每个未执行 call 配对结果 |
| follow-up 丢失 | 只读一次队列 | 在外层边界重新取消息 |
| 回复未送达 | agent_end 当投递完成 | settle ReplyDispatcher |
| 并发工具冲突 | 未按 sequential 决策 | 批次层串行/拒绝 |
| pending 注入错 run | 所有权未校验 | 绑定 runId，非法注入拒绝 |

## 8. 通关自测

1. 内层和外层循环各自的继续条件是什么？
2. 为什么工具批次需要批次级准入？
3. steering 为什么不强行中断已启动工具？
4. `agent_end` 之后还可能发生什么？
5. `prepareNextTurn()` 可以改变什么，不能改变什么？
6. 渠道入口与 `chat.send` 在哪里汇合？

### 参考答案

1. 内层看当前 turn 是否还有工具调用或 pending/steering 消息；外层看 turn 结束后是否还有 follow-up。前者维持当前轮，后者维持同一逻辑执行。
2. 批次级策略能看到整批工具：能否并行、是否有 sequential 工具、累计权限/预算、重复冲突，以及 steering 后哪些调用需要 skipped result。单工具校验无法保证整批一致。
3. 已启动工具可能已经产生外部副作用，强制中断会留下半执行状态。steering 在安全点生效，让已启动工具完成，未启动调用补配对结果。
4. 还要记录 terminal outcome、提交/重写 transcript、settle reply dispatcher、投递回复、更新元数据并释放资源。
5. 可以调整下一轮的 system prompt、工具集合或继续配置；不能重写 run identity、绕过权限/审批、伪造已提交历史或把旧 writer 的写权恢复。
6. 两者在统一 agent command/embedded runner 汇合，之后进入同一个 `runAgentLoop()` 与 Session/Run 语义。

## 9. 源码坐标

- `src/auto-reply/dispatch.ts`
- `src/auto-reply/reply/inbound-context.ts`
- `src/auto-reply/reply/dispatch-from-config.ts`
- `src/gateway/server-methods/chat-send-handler.ts`
- `packages/agent-core/src/agent-loop.ts`
- `packages/agent-core/src/agent-loop-steering.ts`
- `src/agents/embedded-agent-runner/runs.ts`

## 10. 下一步

进入阶段 3：循环每轮都要给模型上下文。prompt、workspace、compaction 与 pruning 各自改什么？
