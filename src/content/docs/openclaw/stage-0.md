---
title: "阶段 0：环境与源码地图"
description: "阶段 0：环境与源码地图。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：OpenClaw 源码课 · 阶段卷
> 前置：无
> 对应总览：`00-全局地图.md`
> 本阶段目标：建立版本、目录、进程和身份地图，避免把渠道、Gateway、Agent 与 transcript 混成一件事。

## 1. 本阶段解决什么

OpenClaw 仓库很大，入口很多。如果从 `src/` 逐文件读，很容易记住零散模块却不知道一条消息在哪里转弯。本阶段只建立四张地图：

- 运行环境与版本基线；
- 进程/职责拓扑；
- 源码目录职责；
- 一次 Run 的六个核心身份。

## 2. 先记住一个判断

**Channel 不是 Session，Gateway 不是 Agent，ACK 不是 Reply，Transcript 不是 Prompt。**

这四组区分能解释后面绝大多数“为什么这里还要再包一层”的问题。

## 3. 源码主线

1. `package.json` 声明 `2026.10.9`、Node 版本与 `pnpm@12.15.0`。
2. `packages/agent-core/src/agent-loop.ts` 是模型/工具循环的共享核心。
3. `src/gateway/` 负责 RPC、鉴权、Session/Run admission、事件与控制方法。
4. `src/auto-reply/` 把渠道入站归一化为 dispatch 与 ReplyDispatcher 流程。
5. `src/agents/` 包含 embedded runner、session、tool、harness、subagent 与 transcript。
6. `src/plugins/`、`src/mcp/`、`src/skills/` 提供扩展面；`ui/src/` 与 `src/tui/` 是前端。
7. `src/state/` 保存 SQLite schema、迁移、lease、snapshot 与运行状态。

## 4. 关键对象与合同

### 目录职责

| 路径 | 主要职责 | 不应混淆 |
| --- | --- | --- |
| `src/gateway/` | RPC、路由、admission、事件、权限 | 不执行模型循环 |
| `src/auto-reply/` | 渠道上下文、dispatch、回复分发 | 不拥有 transcript |
| `packages/agent-core/` | 可复用的 loop/compaction 核心 | 不拥有 Gateway 路由 |
| `src/agents/` | embedded runner、工具、harness、session、transcript | 不是纯 UI 层 |
| `src/plugins/` | 原生 capability、hook、provider/channel 注册 | 不是外部 MCP server |
| `src/mcp/` | 外部工具协议与运行时 | 工具仍要过 policy/approval |
| `src/state/` | 数据库、迁移、快照、lease | 不是模型上下文 |
| `ui/`、`src/tui/` | Control UI/WebChat/TUI | 不是第二套 Agent |

### 六个核心身份

| 身份 | 回答什么 | 生命周期 |
| --- | --- | --- |
| `clientRunId` | 客户端这次请求的幂等键是什么 | 可跨重试 |
| `sessionKey` | 消息应落到哪段对话 | 长期路由 |
| `sessionId` | 当前持久化记录是哪一段 | 可因重写/分支变化 |
| `runId` | 这次执行是哪一次 | 单次 Run |
| `writerRunId` | 谁当前有 transcript 写权 | 接管时变化 |
| `transcript entry` | 已提交历史中的哪一条 | 持久化 |

这些身份不能互相替代。尤其是 `sessionKey` 不等于 `sessionId`，`runId` 也不等于 `clientRunId`。

## 5. 一条可观察链路

```text
外部入口
  → Gateway 或 auto-reply normalize
  → sessionKey 路由
  → sessionId 绑定
  → admission + runId
  → lane / writer fence
  → embedded runner
  → agent loop
  → transcript
  → reply
```

## 6. 实验

### 实验 A：核对版本与工具链

```powershell
node --version
pnpm --version
rg -n '"version"|"engines"|"packageManager"' package.json
```

参考验收：Node 满足 `>=24.22.1 <25 || >=26.12.1`，pnpm 为 `12.15.0`，版本为 `2026.10.9`；不要从归档中猜 commit。

### 实验 B：找共享循环

```powershell
rg -n "export async function runAgentLoop|function runLoop|executeToolCallGroups" packages\agent-core\src\agent-loop.ts
```

参考验收：能指出共享循环入口、内外层继续条件与工具批次执行点。

### 实验 C：画身份图

从 `chat-send-handler.ts`、`chat-send-admission.ts`、`embedded-agent-runner/run/session-bootstrap.ts` 中各找一次身份绑定。参考验收：能写出 `clientRunId → runId` 与 `sessionKey → sessionId` 的不同阶段。

### 实验参考答案

1. 版本应为 `2026.10.9`，Node/pnpm 满足 `package.json` 的工具链约束；归档没有 Git 身份时不能编 commit。
2. 应定位 `runAgentLoop`、内外层继续条件与 `executeToolCallGroups`，并能说明共享循环不因渠道不同而复制。
3. `clientRunId` 在准入/去重阶段映射为 `runId`；`sessionKey` 在 bootstrap/运行阶段解析为 `sessionId`。两层身份不能混用。

## 7. 失败与恢复

| 误区 | 后果 | 修正 |
| --- | --- | --- |
| 把 channel 当 session | 同一对话跨渠道断裂 | 用 Gateway 路由身份 |
| 把 Gateway 当 Agent | 在错误层找模型循环 | 进 `src/agents` 与 agent-core |
| 把 ACK 当完成 | 断线重试重复执行 | 用 run 事件/终态恢复 |
| 把 transcript 当 prompt | 以为 pruning 改历史 | 区分 canonical 与投影 |
| 用归档猜 git 版本 | 版本结论不可复现 | 只引用发布包版本 |

## 8. 通关自测

1. Gateway 与 Agent Harness 的职责边界是什么？
2. `sessionKey`、`sessionId`、`runId`、`clientRunId` 各解决什么问题？
3. 为什么 `packages/agent-core` 适合作为共享循环？
4. `src/state` 与如果 transcript 是两套事实吗？
5. 为什么归档版课程不能虚构 commit？

### 参考答案

1. Gateway 负责入口、鉴权、路由、admission、事件和生命周期；Agent Harness 负责模型、工具、上下文与循环。Gateway 不直接“思考”，Harness 不拥有全局路由。
2. `sessionKey` 定位逻辑对话，`sessionId` 标识持久化记录，`runId` 标识一次执行，`clientRunId` 支持客户端重试幂等。四者生命周期和用途不同。
3. 它把模型流、工具批次、steering、follow-up 与 compaction 做成与入口解耦的可复用核心，内建和插件 harness 都能共享同一套执行语义。
4. 不是。`src/state` 保存数据库、快照、lease、迁移等运行事实；transcript 是会话历史事实的一部分，prompt 又是从 transcript 和上下文规则生成的本轮投影。
5. 归档没有 `.git`，无法验证 commit/tag。可信结论只能来自发布包 `package.json`、源码符号与目录；虚构版本会破坏可复现性。

## 9. 源码坐标

- `package.json`
- `packages/agent-core/src/agent-loop.ts`
- `src/gateway/server-methods/chat-send-handler.ts`
- `src/gateway/server-methods/chat-send-admission.ts`
- `src/auto-reply/dispatch.ts`
- `src/agents/embedded-agent-runner/run/session-bootstrap.ts`
- `src/agents/embedded-agent-runner/runs.ts`
- `src/state/`

## 10. 下一步

进入阶段 1：一条 `chat.send` 怎样被接纳、绑定 session、串行执行并取得 transcript 写权。
