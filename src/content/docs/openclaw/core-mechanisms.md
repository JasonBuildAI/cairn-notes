---
title: "OpenClaw 2026.10.9 源码课 · 02 核心机制"
description: "梳理循环、上下文、工具审批、模型与 harness、插件和 Gateway 协议。"
---

> 基线：`openclaw-2026.10.9`。路径相对 `$OPENCLAW_SRC`。
> 这一篇不再讲“一条消息怎么走”，而是拆开七个机制：循环、会话、上下文、工具、模型、扩展、界面/协议。
> 每个机制都只回答两件事：**它拥有什么状态？它为什么必须单独存在？**

## 一句话理解

OpenClaw 的核心不是某个“超级 Agent 类”，而是一组**边界清楚的机制**：

```text
                 ┌──────────────────────────────┐
                 │ Gateway / UI / Channels      │
                 │ 谁进来、谁出去、谁有权限      │
                 └──────────────┬───────────────┘
                                │
                 ┌──────────────▼───────────────┐
                 │ Session / Run / Writer       │
                 │ 归谁、谁先写、谁接管、谁恢复   │
                 └──────────────┬───────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Context       │     │ Agent Loop      │     │ Tools           │
│ 给模型看什么   │────▶│ 模型/工具/继续   │────▶│ 能做什么/谁批准  │
└───────────────┘     └────────┬────────┘     └─────────────────┘
                               │
                     ┌─────────▼─────────┐
                     │ Model / Harness   │
                     │ 用谁跑、失败怎么办 │
                     └─────────┬─────────┘
                               │
                     ┌─────────▼─────────┐
                     │ Plugins/MCP/Skills│
                     │ 能力怎样长出来     │
                     └───────────────────┘
```

七块之间靠三条硬约束连接：

1. **状态所有权唯一**：session 由 writer 写，路由由 Gateway 拥有，工具放行由 approval chain 拥有。
2. **协议合法**：tool call 与 tool result 必须成对；事件必须可重放/可恢复。
3. **可重建与不可重建分开**：视图可以从权威状态派生；幂等、writer、审批结果不能当缓存随便丢。

---

## 1. 循环机制：Agent Loop 到底在循环什么

### 1.1 两个入口

`packages/agent-core/src/agent-loop.ts` 提供：

- `runAgentLoop()`（`81`）：带初始 prompt 启动；
- `runAgentLoopContinue()`（`118`）：从已有 context 继续，不再提交 prompt。

两者最后都进入 `runLoop()`（`140` 起的内部函数）。

### 1.2 一个 Turn 的完整形状

源码里的 turn 不是“一次模型调用”，而是：

```text
turn_start
  ├─ 注入 pending / steering
  ├─ 可选 prepareContinuation（换 systemPrompt/tools）
  ├─ streamAgentResponse
  │    ├─ 文本增量事件
  │    ├─ tool_call 增量事件
  │    └─ 工具批次执行
  ├─ 处理未执行的 terminal tool calls
  ├─ 计算 hasMoreToolCalls
  ├─ turn_end
  └─ prepareNextTurn / abort / error / terminate 判定
```

关键行：

- 内层循环条件：`agent-loop.ts:218`
- 模型流：`269`
- 工具批：`276`
- `turn_end`：`344`
- `prepareNextTurn`：`390`
- follow-up：`446`
- `agent_end`：`457`

### 1.3 为什么需要两层循环

内层循环解决“这一轮还没结束”：

```text
hasMoreToolCalls || pendingMessages.length > 0
```

外层循环解决“这一轮结束后，是否还有用户/系统追加的消息”：

```text
getFollowUpMessages()
```

如果没有外层，模型刚说“完成”，用户紧接着发来的补充消息就只能新开一个 run；有了外层，它可以作为同一逻辑执行的一部分继续推进。

### 1.4 工具批次不是简单 for 循环

`executeToolCalls()` 在 `461` 行，核心步骤：

1. `beforeToolBatch` 做批次级准入；
2. 解析每个 tool call 对应哪个工具；
3. 决定并行还是串行；
4. 执行；
5. 生成 tool result；
6. 处理 steering 跳过的未启动工具；
7. 返回批次结果、终止标记、steering 消息。

并行/串行判定：

- 配置 `toolExecution === "sequential"` 时全串行；
- 否则如果任一工具声明 `executionMode === "sequential"`，整批转串行；
- 见 `agent-loop.ts:514-531`。

这不是性能细节，而是正确性细节：有副作用的工具不能被并行乱序执行。

### 1.5 steering 的“安全插队”

steering 只能在这些点生效：

- 一轮开始前；
- 工具批次执行前；
- 批次结束后；
- 下一轮模型调用前。

已经开始执行的工具不会被打断。尚未启动的工具会通过 `completeUnstartedToolCall()`（`1331`）生成：

- 一个 synthetic error 结果，或
- 一个 `status: "skipped"` 的结果。

原因只有一个：**transcript 必须保持 tool call/result 配对。**

### 1.6 终止原因必须分类

不要把所有结束都叫“完成”。源码至少区分：

| 原因 | 语义 |
| --- | --- |
| 自然无工作 | 没有工具调用、没有 pending/follow-up |
| abort | 用户/上层取消 |
| provider error | 模型调用失败 |
| tool loop terminate | 重复错误/工具循环保护 |
| strategy stop | `prepareNextTurn().stop` 或 `shouldStopAfterTurn()` |
| superseded | 被新 writer 接管（在 session 层终止） |

排障时先分类，再找对应 owner。

---

## 2. 会话机制：Session / Run / Writer / Lane

### 2.1 身份模型

| 身份 | 所有者 | 作用 |
| --- | --- | --- |
| `sessionKey` | Gateway / session store | 路由到哪段对话 |
| `sessionId` | session store / agent DB | 持久化记录身份 |
| `runId` | 当前执行 | 一次执行的身份 |
| `clientRunId` | 客户端 | 幂等重试键，通常直接成为 `runId` |
| `lifecycleGeneration` | 运行时 | 防止旧生命周期继续操作 |

### 2.2 准入与幂等

`chat.send` 的准入口在 `src/gateway/server-methods/chat-send-admission.ts:75`。它同时处理：

- 上传/附件准入；
- 会话绑定；
- 幂等缓存；
- abort controller 注册；
- 工作准入（gateway work admission）；
- 重试比较。

幂等键是 `chat:${clientRunId}`（`442`）。重复请求不会重新开一条 run，而是返回 `in_flight` 或已有结果。

### 2.3 writer fence

`claimAgentSessionWriter()` 在 `src/agents/embedded-agent-runner/run/session-bootstrap.ts:523`。

它做了：

1. 读当前 session 快照；
2. 确认 `sessionId` 没变；
3. CAS 写入 `activeWriterRunId = 当前 runId`；
4. 如果旧 writer 不同，调用 `supersedeEmbeddedAgentRunByRunId()`；
5. 旧 run 以 `superseded` 终止。

这解决三类问题：

- 同一 session 并发输入；
- 新 run 合法接管旧 run；
- 重启恢复时旧 writer 不能继续写。

### 2.4 lane 与并发预算

`src/agents/embedded-agent-runner/lanes.ts`：

- `resolveSessionLane()`（`10`）：`session:<key>`，串行化同一 session；
- `resolveGlobalLane()`（`15`）：全局/子 agent/cron 的资源 lane。

特殊规则：

- cron 内层操作使用 `cron:nested`，避免和外层 cron 死锁；
- subagent lane 绑定到父 owner，避免 orchestrator 等子任务时占满自己需要的容量。

### 2.5 recovery owner

`agentCommandFromIngressInternal()` 用：

```ts
runWithAgentCommandRecoveryOwner(..., mode: "claim", ...)
```

位置：`src/agents/agent-command.ts:603`。

它保证“恢复/接管”只有一个 owner。Gateway 还有专门的 `agentCommandFromGatewayIngress()`（`665`）用于恢复被拒绝的 restart-recovery admission。

### 2.6 detached run

`sessionPersistence === "detached"` 时：

- 不写持久 session 元数据；
- 不 claim 外层 deferral；
- 使用 in-memory session manager（`run-orchestrator.ts:154-158`）。

这不是“临时任务”的模糊说法，而是明确的所有权选择：**这次 run 不影响长期会话。**

---

## 3. 上下文机制：稳定前缀、bootstrap、压缩、裁剪

### 3.1 system prompt 是分层拼装的

`buildAgentSystemPrompt()` 在 `src/agents/system-prompt.ts:284`。输入包括：

- workspace / runtime cwd；
- 可见工具与可用工具；
- skills prompt；
- context files；
- bootstrap mode；
- model aliases；
- runtime info；
- sandbox 信息；
- provider 覆盖段。

它输出的不是一整块随便拼的文本，而是有“稳定前缀 / 易变后缀”的边界。

### 3.2 为什么要稳定前缀

源码在 `system-prompt.ts:605` 用一串稳定输入计算 `stablePrefixCacheKey`，并用缓存复用稳定前缀。注释在 `835-849` 说明：

- 日期/时区变化放在易变后缀；
- channel/session 特定指导放在 cache boundary 之后；
- 大块 workspace 上下文保持在字节级稳定的前缀里。

原因是 **prompt-prefix reuse**：同一个会话每轮都重写前缀，会破坏 provider 的缓存命中，长期成本会显著上升。

### 3.3 bootstrap 文件的注入规则

`resolveBootstrapContextForRun()` 在 `src/agents/bootstrap-files.ts:397`。默认文件名来自 `workspace-bootstrap-policy.ts`：

- `AGENTS.md`
- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- `BOOTSTRAP.md`（新工作区）
- `MEMORY.md`

预算：

- 单文件 `20000` 字符；
- 总计 `60000` 字符；
- 见 `src/config/schema.help.models.ts:152-155`。

超限截断，并在 prompt 里加 notice；预算诊断在 `src/agents/bootstrap-budget.ts:122`。

子 agent 默认只注入 `AGENTS.md`，这是“上下文预算按角色分配”的体现。

### 3.4 compaction：改写历史

`packages/agent-core/src/harness/compaction/compaction.ts`：

- 默认配置：`enabled: true`、`reserveTokens: 16384`、`keepRecentTokens: 20000`（`179-182`）；
- `estimateContextTokens()`（`243`）优先使用 provider usage；
- `shouldCompact()`（`276`）：`contextTokens > contextWindow - reserveTokens`；
- `findCutPoint()`（`407`）：保留最近约 `keepRecentTokens`，必要时切开一个过大的 turn；
- `compact()`（`815`）：生成摘要并形成可提交的 compaction artifact；
- `compactWithoutSummary()`（`895`）：摘要失败时保留近期原文，并明确记录删掉了多少条早期消息。

摘要不是“无损压缩”。它是有损的，所以源码会：

- 尽量保留最近原文；
- 迭代更新旧摘要；
- 在摘要失败时退化为“无摘要但保留尾部”；
- 明确告知模型/用户有消息被省略。

### 3.5 cache-TTL pruning：只改投影

`src/agents/embedded-agent-runner/tool-result-truncation.ts`：

- 默认 TTL `5 * 60_000`（5 分钟）；
- `hardClear` 默认 `true`；
- placeholder 默认 `[Old tool result content cleared]`；
- soft prune 保留首尾各 `1500` 字符（`167`）；
- 当上下文压力 ≥ 50% 且可回收 ≥ 50,000 字符时，hard clear（`264-283`）。

关键区别：

| 机制 | 改什么 | 是否改磁盘 transcript |
| --- | --- | --- |
| compaction | 历史结构 | 是，写入摘要 |
| cache-TTL pruning | 本次 prompt 投影 | 否 |

所以看到“工具结果变短了”时，先判断是哪一种，不要直接去 transcript 里找丢失的原文。

---

## 4. 工具机制：装配、批次、审批、沙箱

### 4.1 装配链

`assembleOpenClawCodingTools()` 在 `src/agents/agent-tools.ts:97`，是一个 generator：

1. 计算 capability profile；
2. 计算 workspace/sandbox policy；
3. 加入 core coding tools；
4. 加入 OpenClaw 工具；
5. 加入 plugin tools；
6. 加入 channel tools；
7. 做最终 authorization。

core tools 在 `src/agents/core-coding-tools.ts:202`。

### 4.2 工具为什么有两份上下文成本

一次请求里，模型至少看到：

- **工具目录/说明**：system prompt 里的工具文本；
- **工具 JSON schema**：provider 请求里的函数定义。

所以“多一个核心工具”不是只多一个函数，而是长期增加每轮上下文成本。这就是根 `AGENTS.md` 强调 **small core, capable plugins** 的原因。

### 4.3 批次执行

- 批次级准入：`beforeToolBatch`；
- 参数校验：`validateToolCallForBatchAdmission()`；
- 并行/串行：按配置和工具声明；
- 失败：生成合法的 tool result，而不是让 call 悬空。

### 4.4 before_tool_call 顺序

`src/agents/agent-tools.before-tool-call.policy.ts` 文件头：

```text
loop admission
→ owner probes
→ voice confirmation
→ trusted policies
→ approvals
→ normal hooks
→ final owner approval
```

为什么顺序不可换：

- loop admission 先挡住重复/危险循环；
- owner probe 确认调用者身份；
- voice 确认只对语音 surface 生效；
- trusted policy 是宿主可信策略；
- approval 才是“问人”；
- normal hook 是插件扩展点；
- final owner approval 是最后一道放行。

### 4.5 审批模式

`resolveBeforeToolCallApprovalOutcome()` 在 `agent-tools.before-tool-call.approval.ts:470`：

| 模式 | 行为 |
| --- | --- |
| `request` | 立即请求审批 |
| `defer` | 推迟到执行边界 |
| `report` | 只报告，不阻塞 |
| `deny` | 直接拒绝 |

非交互渠道可能直接 deny。不是“渠道不支持就不安全”，而是“不能问人时默认不放行”。

### 4.6 sandbox 是执行边界

`src/agents/sandbox/` 提供执行隔离。system prompt 里会明确区分：

- host workspace；
- sandbox workspace；
- `exec` 在容器里执行；
- 子 agent 默认不获得 elevated/host access。

见 `system-prompt.ts:487-501`、`776-789`。

工具策略决定“能不能做”，sandbox 决定“在哪里做、能碰到什么”。两者不能互相替代。

---

## 5. 模型机制：解析、认证、候选、harness

### 5.1 解析

`resolveModelAsync()` 在 `src/agents/embedded-agent-runner/model.ts:84`：

- 解析逻辑 provider/model；
- 准备 auth storage 和 model registry；
- 先看显式/配置模型；
- 再看静态 catalog；
- 再看 provider 动态 catalog；
- 结合 auth profile、route、workspace。

失败信息会区分“legacy provider”“模型不在 catalog”“模型绑定到某个 runtime”等情况。

### 5.2 候选链

`resolveModelCandidateChain()` 在 `src/agents/model-fallback-candidates.ts:155`。

候选不是随便追加，而是根据：

- 主模型；
- fallback 配置；
- provider 可用性；
- auth profile；
- 运行时约束

生成有序链。

### 5.3 failover 决策

`resolveRunFailoverDecision()` 在 `src/agents/embedded-agent-runner/run/failover-policy.ts:115`：

- `rotate_profile`：同模型换认证；
- `fallback_model`：换模型；
- `surface_error`：向上暴露。

`runEmbeddedAgentEntry()`（`run-entry.ts:161`）只让最终被接受的候选推进 session。失败候选的 assistant error transcript 会被清理/隔离，避免污染最终历史。

### 5.4 harness 选择

`selectAgentHarness()` 在 `src/agents/harness/selection.ts:77`。它决定由谁执行：

- 内建 `openclaw` harness（`builtin-openclaw.ts:84`）；
- `codex` 外部 harness；
- `auto` 按配置/模型选择。

`runAgentHarnessAttempt()`（`selection.ts:182`）是统一尝试入口。

### 5.5 CLI backend

`runEmbeddedAgentViaCliBackendIfEligible()` 在 `src/agents/embedded-agent-runner/cli-backend-dispatch.ts:21`。

某些 provider/auth 组合需要走 CLI backend。此时：

- 仍然经过同一套 session admission、placement、concurrency gate；
- 但真正的模型循环由外部 CLI 负责；
- compaction/manual compaction 能力可能不同。

见 `run-orchestrator.ts:245` 的注释与调用。

---

## 6. 扩展机制：Plugin、MCP、Skills、Subagent

### 6.1 原生 Plugin 是能力注册，不是“改核心”

`docs/plugins/architecture.md` 的能力表包括：

- text inference；
- CLI inference backend；
- embeddings；
- speech / realtime transcription / realtime voice；
- media understanding；
- image/music/video generation；
- web fetch/search；
- channel；
- gateway discovery；
- migration。

插件还可以注册 tool、hook、command、service、HTTP route。

加载管线：

1. manifest + discovery；
2. enablement + validation；
3. runtime loading；
4. surface consumption。

原生插件在进程内加载，**等价于任意代码执行**。所以插件信任边界不是“沙箱”，而是“你是否信任这段代码”。

### 6.2 Channel plugin

`src/plugins/runtime/runtime-channel.ts:127` 的 `createRuntimeChannel()`，在 `139-145` 提供 `dispatchInbound`。

`src/plugins/loader-channel-runtime.ts:219` 的 `api.registerChannel(...)` 把渠道能力注册进 runtime。

所以“新增一个聊天渠道”不是改 Gateway 的 if/else，而是注册一个 channel capability，让它把入站消息翻译成统一合同。

### 6.3 MCP

MCP 是外部工具来源，不是绕过策略的后门。

- 配置在 `mcp.servers`；
- transport 支持 Streamable HTTP、SSE、Stdio；
- 连接后工具仍走 tool profile 和 tool policy；
- server 失联时保留最后成功的工具目录，但执行仍报 unavailable；
- 启动失败按 `30s → 10min` 指数退避（`docs/tools/mcp.md`）。

源码目录：`src/mcp/`、`src/agents/agent-bundle-mcp-*`。

### 6.4 Skills

Skills 不是工具本身，而是“可读的说明/资源目录”。

- `loadSkills()` 在 `src/skills/loading/session.ts:191`；
- `formatSkillsForPrompt()` 在 `180`；
- skills 是否进入 prompt 取决于是否有读取能力：`system-prompt.ts:512-525`；
- `skills_read` / `read` / CLI backend 等 surface 影响可见性。

Skills 可以来自 workspace、plugin、bundled、remote；`src/skills/security/` 提供扫描/审计。

### 6.5 Subagent

Subagent 是“另一个 session + 另一条 run”，不是同一个循环里的函数调用。

- child session 默认形如 `agent:<agentId>:subagent:<uuid>`；
- 有 depth policy；
- 默认不获得 session/message 管理工具；
- 支持 announce 回传、restart recovery、cascade stop；
- 父 run 结束时，child session 不一定结束。

源码：`src/agents/subagents/spawn/`、`completion/`、`registry/`。

---

## 7. 界面与协议：Gateway 是控制面

### 7.1 Gateway 启动

`startGatewayServer()` 在 `src/gateway/server.ts:24`：

1. 懒加载 `server-start`；
2. 初始化 SQLite runtime；
3. 准备数据库 schema contract；
4. 获取 gateway lock；
5. 进入 `startGatewayServerCore()`。

默认端口 `18789`，见 `src/config/paths.ts:297`。

### 7.2 WebSocket 首帧

`ConnectParamsSchema` 在 `packages/gateway-protocol/src/schema/frames.ts:31`：

- 协议版本范围；
- client 信息；
- role；
- scopes；
- device 证明；
- auth token/password/deviceToken。

服务器连接建立后先发 `connect.challenge`，带随机 nonce，见 `src/gateway/server/connection.ts:329-331`。

设备证明校验在 `src/gateway/server/ws-connection/connect-device-proof.ts:15`：

- 公钥派生 device id 必须匹配；
- `signedAt` 必须在允许 skew 内；
- nonce 必须匹配；
- 签名必须有效。

配对审批在 `connect-device-pairing.ts`。

### 7.3 三种帧

- `req`：`{ type, id, method, params }`（`frames.ts:187`）
- `res`：`{ type, id, ok, payload|error }`（`196`）
- `event`：`{ type, event, payload, seq?, stateVersion? }`（`205`）

`seq` 让客户端发现事件缺口；`stateVersion` 让客户端判断快照是否过期。

### 7.4 权限

方法授权不是“连上就能调”。`src/gateway/server-methods/request-authorization.ts` 和 method descriptors 共同决定：

- 方法需要什么 scope；
- 是否 operator；
- 是否 session owner；
- 是否允许创建/跨会话。

例如 `chat.send` 需要 `operator.write`，见 `src/gateway/methods/core-descriptors.ts:382`。

### 7.5 UI

- TUI：`src/cli/tui-cli.ts:88` 注册 `tui`，别名 `terminal`/`chat`；
- TUI 主体：`src/tui/tui.ts:604`；
- Control UI：`ui/src/main.ts` 浏览器入口；
- 路由：`ui/src/app-routes.ts:157`；
- 聊天页：`ui/src/pages/chat/chat-page.ts:61`。

WebChat 使用 Gateway WS RPC：`chat.history`、`chat.send`、`chat.inject`、`chat.message.get`、`chat.startup`。

---

## 8. 设计取舍：为什么不是更简单的架构

### 8.1 单 Gateway 拥有路由

好处：

- 所有渠道共享 session/run 语义；
- 幂等、权限、事件、恢复只实现一次；
- UI 和渠道看到同一份状态。

代价：

- Gateway 成为长生命周期进程；
- 需要 lock、schema migration、健康检查、重启恢复；
- 单点故障必须靠恢复机制解决。

### 8.2 writer fence 而不是“最后写入赢”

如果只按时间戳覆盖：

- 旧 run 可能在新 run 之后写入工具结果；
- transcript 会出现交错；
- 恢复后可能重复执行。

writer fence 让“接管”成为显式事件，旧 run 必须终止。

### 8.3 稳定 prompt 前缀而不是“每轮全量重排”

好处：

- 提高 provider prefix cache 命中；
- 降低长期 token 成本；
- 让上下文变化可解释。

代价：

- 动态信息必须放到边界之后；
- 修改 prompt 结构时要考虑缓存键；
- 不能随意把 session 特定内容塞进稳定前缀。

### 8.4 只裁剪 tool result 的投影

好处：

- 不破坏 transcript 的可恢复性；
- 重启后可以从原文重新派生；
- 不会让 compaction 摘要与工具结果互相污染。

代价：

- 需要维护 projection key；
- 必须区分“磁盘历史”和“本次请求视图”。

### 8.5 插件进程内信任

好处：

- 能力注册简单；
- provider/channel/tool 都能深度集成；
- 不需要跨进程协议开销。

代价：

- 恶意插件等于任意代码执行；
- 兼容性要靠 SDK 合同和检查，而不是进程隔离。

---

## 9. 常见误解

1. **“Gateway 只是 WebSocket 服务器。”**
   它还拥有路由、权限、幂等、事件、恢复、UI 静态资源和 session 绑定。

2. **“Session 就是一个 JSON 文件。”**
   OpenClaw 有 Gateway state DB（schema 20）和 agent DB（schema 25），涉及 session、transcript archive、FTS、媒体等。

3. **“工具越多越强。”**
   工具会增加 system prompt 文本和 JSON schema 两份上下文成本，还会扩大攻击面。

4. **“审批是 hook 的一种。”**
   审批链在普通 hook 之前，且有最终 owner approval。

5. **“MCP 连接成功就绕过工具策略。”**
   不会。MCP 工具仍走 tool profile/tool policy。

6. **“Subagent 就是同一个 Agent 的递归调用。”**
   它是独立 session/run，有自己的 writer、lane、depth policy 和生命周期。

7. **“compaction 失败就丢历史。”**
   `compactWithoutSummary()` 会保留近期原文，并明确记录省略数量。

8. **“TUI 是另一套 Agent。”**
   TUI 只是前端；local 模式复用同一 runtime，gateway 模式复用同一 RPC。

---

## 10. 自测与练习

### 自测

1. Agent Loop 的内层和外层循环分别解决什么问题？
2. 为什么工具批次需要 `beforeToolBatch`，而不是只做单工具校验？
3. writer fence 的 CAS 写入了哪个字段？旧 writer 怎样终止？
4. session lane 和 global lane 分别防止什么？
5. system prompt 的稳定前缀包含哪些输入？为什么日期要放在后缀？
6. compaction 和 cache-TTL pruning 的所有者分别是谁？
7. before_tool_call 的七步顺序中，哪一步不能放到 hook 后面？为什么？
8. MCP server 失联后，为什么还能看到工具目录但不能执行？
9. 子 agent 的 child session key 长什么样？父 run 结束会怎样？
10. Gateway 的 `seq` 和 `stateVersion` 分别解决什么问题？

### 练习

- 在 `agent-loop.ts` 里把所有终止路径画成状态机。
- 在 `session-bootstrap.ts` 里复现一次 writer 接管，写出 CAS 失败时的分支。
- 对比一次 compaction 前后的 transcript 和一次 pruning 前后的 prompt 投影。
- 找一个工具，从 assembly 追到 approval，再追到 sandbox 执行。
- 读 `docs/plugins/architecture.md`，把一个 provider plugin 的注册链画出来。
- 人为让 MCP server 不可达，观察 30 秒退避和工具目录保留行为。
- 修改 system prompt 的一个动态字段，观察它是否破坏 stable prefix；说明应该放在哪一侧。

---

### 自测参考答案

1. **内层**解决“当前 turn 还没结束”：只要还有工具调用或 pending 消息，就继续模型—工具循环。**外层**解决“turn 自然结束后，是否还有同一逻辑执行的 follow-up”；有则继续，没有再 `agent_end`。
2. 因为批次级策略要回答单工具看不到的问题：整批能否并行、是否含 `sequential` 工具、累计预算/权限、重复或冲突调用、steering 到达后哪些未启动调用要补 skipped result，以及批次是否有终止标记。单工具校验无法保证整批的一致性。
3. CAS 在确认 `sessionId` 未变后写入 `activeWriterRunId = 新 runId`；若旧 writer 存在且不是自己，调用 `supersedeEmbeddedAgentRunByRunId()`，旧 run 以 `superseded` 终止。
4. **session lane** 防同一会话并发写导致 transcript 交错；**global lane** 防整个进程被无限并发拖垮，并约束全局资源、子 Agent、cron 等跨 session 负载。
5. 稳定前缀包含：workspace/runtime 身份、工具目录与 schema 的稳定部分、skills、bootstrap/context files、model aliases、sandbox/provider 的说明等不随每轮变化的内容。日期/时区是随运行时刻变化的动态字段，必须放在 cache boundary 之后的易变后缀，否则每次都会让整个前缀失效。
6. **compaction** 归 harness/`packages/agent-core` 的 compaction 模块；**cache-TTL pruning** 归 embedded-agent runner 的 tool-result truncation 模块。前者能改写 transcript，后者只能改投影。
7. **审批链不能放到普通 hook 后面**。`approvals` 必须在 `normal hooks` 之前；否则插件 hook 可以先修改参数或补造证据，再让审批看到“被洗过”的调用。`final owner approval` 是最后的独立所有者放行，不等于普通 hook。
8. 失联后保留的是上一次发现得到的工具目录/元数据；执行需要活的 MCP 连接。连接不可用时工具仍可能可见，但调用会返回 unavailable，并按退避重连，不能拿目录存在证明执行可用。
9. child session 默认形如 `agent:<agentId>:subagent:<uuid>`。父 run 结束不必然结束 child；child 是独立 session/run，有自己的 writer、lane、depth policy、announce 与恢复生命周期。
10. `seq` 解决增量事件的顺序与缺口检测：客户端发现跳号就重同步；`stateVersion` 解决快照新旧判断：快照版本与服务端当前版本不匹配时，不能用旧快照覆盖增量状态。

### 练习参考答案

- **终止路径状态机**：至少画出 `natural`、`abort`、`provider_error`、`tool_loop_terminate`、`strategy_stop`、`superseded` 六类；每类标注“谁产生、是否发 terminal outcome、回复是否仍需 settle”。
- **writer CAS 失败分支**：重新读取 session；若 `sessionId` 已变化，返回冲突/重新绑定，不能写旧 session；若只是并发 claim，按策略重试或让新 run 接管。验收点是绝不无条件覆盖 `activeWriterRunId`。
- **compaction vs pruning 对比**：compaction 前后 transcript 会多出摘要/减少早期原文；pruning 前后磁盘 transcript 完全一致，只有本次 prompt 里的旧 tool result 变成 placeholder，重启后可从原文重建。
- **工具全链路**：装配 profile → policy/approval → sandbox/executor；记录拒绝、skipped、成功三种结果都生成一对一 result。
- **provider plugin 注册链**：plugin 注册 provider capability/catalog → 认证与模型元数据 → API adapter → 模型解析/候选链 → failover；验收点是 provider 语义由 provider 层拥有，核心循环只消费统一合同。
- **MCP 不可达实验**：期望先看到目录可读、执行 unavailable；退避约 30 秒起步、最长 10 分钟；server 恢复或显式 reload 后清除退避。不能把“目录还在”误判成“工具可执行”。
- **动态 prompt 字段**：修改后比较 `stablePrefixCacheKey` 与稳定前缀字节；若两者变化，说明放错侧。日期、连接状态、session 特定提示应放在 cache boundary 之后，并加测试防止回流。


*OpenClaw 2026.10.9 · 核心机制*
