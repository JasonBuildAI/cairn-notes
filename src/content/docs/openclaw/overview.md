---
title: "00 · 全局地图"
description: "从进程、会话和源码视角建立 OpenClaw 2026.10.9 的全局地图。"
---

> 目标：先回答“OpenClaw 到底是什么、由哪些常驻部件组成、消息从哪里进、状态由谁拥有”。
> 基线：`openclaw-2026.10.9`。后文用“Gateway / Agent / Session / Run / Channel / Harness”这些词时，含义以本文为准。

## 一、一句话理解

**OpenClaw 不是“一个模型客户端”，而是一个长期在线的个人 Agent 网关：它持续拥有多个消息渠道、多个设备与多个前端连接，把每条输入路由到某个 Agent 的某个 Session，再接纳成一次有边界的 Run，交给可替换的 Agent Harness 执行。**

它的关键选择是“**中心化拥有，边缘化适配**”：

- 中心：Gateway 拥有连接、会话、路由、幂等、事件、审批和生命周期。
- 边缘：Channel、Provider、Sandbox、CLI backend、MCP server、Skill 都是以合同接入的能力。
- 执行：内建 `openclaw` harness 是默认 Agent Loop；也可以选择插件 harness（如 `codex`）或 CLI backend。

## 二、系统拓扑

```text
┌────────────────────── 外部世界 ──────────────────────┐
│ Telegram  Slack  Discord  WhatsApp  Signal  iMessage │
│ WebChat  TUI  移动端  CLI   Node 设备   Cron/Webhook │
└──────────────────────────┬───────────────────────────┘
                           │ 渠道适配 / WS RPC / CLI
┌──────────────────────────▼───────────────────────────┐
│                     Gateway 进程                     │
│  鉴权 · 设备配对 · 路由 · Session/Run admission      │
│  HTTP/WS · Control UI 静态资源 · 事件 · 审批 · Cron   │
└──────────────────────────┬───────────────────────────┘
                           │ 统一 ingress
┌──────────────────────────▼───────────────────────────┐
│                 Agent 执行层                         │
│  agentCommand → embedded runner → harness selection  │
│  session writer · lanes · fallback · abort/recovery   │
└───────────────┬──────────────────────┬───────────────┘
                │                      │
       ┌────────▼────────┐    ┌────────▼────────┐
       │  Agent Loop     │    │  Tool runtime   │
       │ model ↔ tools   │    │ policy/approval │
       │ steering/stop   │    │ sandbox/MCP     │
       └────────┬────────┘    └────────┬────────┘
                │                      │
       ┌────────▼──────────────────────▼────────┐
       │ transcript / session store / events    │
       │ SQLite state · workspace bootstrap     │
       └────────────────┬───────────────────────┘
                        │
                 ReplyDispatcher
                        │
              原渠道 / WebChat / TUI
```

这张图里最重要的一点是：**Gateway 和 Agent Loop 是两个不同层级**。Gateway 可以接纳、排队、取消、转发事件，但不负责“模型下一步想不想调工具”；Agent Loop 负责循环，但不拥有渠道连接。

## 三、核心对象

| 对象 | 它拥有什么 | 不要混淆 |
| --- | --- | --- |
| Gateway | 进程生命周期、连接、鉴权、会话路由、RPC、事件、审批传输 | 不是 Agent Loop |
| Channel | 某个消息平台的账号、收发适配、群/线程语义 | 不是 Session |
| Agent | 配置身份、workspace、模型/工具策略、人格与 bootstrap | 不是一次执行 |
| Session | 长期会话身份与 transcript 所有权 | 不是单次 Run |
| Run | 一次被接纳的执行，带 runId、abort、终态和事件 | 不是 Session |
| Transcript | 会话事实账本；writer 才能追加/改写 | 不是 prompt 投影 |
| Harness | 执行一次模型-工具循环的运行时合同 | 不是 Provider |
| Node | 受 Gateway 管理的远端能力设备，也用同一 WS 协议 | 不是普通 Web 客户端 |
| Plugin | 进程内能力注册者，可拥有 channel/provider/tool/hook | 不是 MCP Server |
| MCP Server | 外部工具/资源/提示协议端 | 不绕过工具策略 |

### 3.1 Session 与 Run

- **Session 是“哪段对话”**。它由来源路由决定：DM、群、房间、Cron、Webhook 的默认策略不同；`chat.send` 会显式带 `sessionKey`。
- **Run 是“这次执行”**。同一个 session 可以有很多 run；同一 session 默认串行，避免两个 writer 同时改历史。
- **Run 结束不代表 Session 结束**。subagent 也是“child run 结束，但可选 session 保留”的模型。

### 3.2 Gateway 是会话事实的所有者

`docs/concepts/session.md` 的源码与文档一致：UI 客户端查询 Gateway 的会话数据。Control UI、TUI、移动端不是各自维护一份“主会话”，而是通过 Gateway RPC 读写同一个会话视图。

这带来两个结果：

1. 渠道切换不会天然丢失上下文，只要路由到同一 session。
2. 多客户端看到的是同一条事实链，但各自的 UI 缓存、草稿和未发送状态仍可能不同。

## 四、目录职责

| 目录 | 主要职责 | 典型入口 |
| --- | --- | --- |
| `src/gateway/` | HTTP/WS 服务、握手、RPC、Session/Run admission、事件、审批、Control UI 托管 | `server.ts`、`server/connection.ts`、`server-methods/chat*.ts` |
| `src/auto-reply/` | 渠道入站后的最终上下文、群/线程分流、回复 dispatcher | `dispatch.ts` |
| `src/agents/` | Agent 命令、embedded runner、工具、模型、harness、session、subagent、sandbox | `agent-command.ts`、`embedded-agent-runner/` |
| `packages/agent-core/` | 与产品解耦的 Agent Loop、消息、compaction、harness 合同 | `agent-loop.ts`、`agent.ts` |
| `src/plugins/` | 原生插件加载、能力注册、hook、runtime | `runtime/`、`loader-*.ts` |
| `src/mcp/` | OpenClaw 对外提供 MCP、以及部分 MCP 运行入口 | `tools-stdio-server.ts`、`channel-server.ts` |
| `src/skills/` | 技能发现、加载、prompt 目录、资源与生命周期 | `loading/`、`runtime/` |
| `src/tui/`、`ui/src/` | 终端 UI 与浏览器 Control UI | `tui.ts`、`main.ts`、`app-routes.ts` |
| `src/state/` | SQLite 状态库合同、启动、迁移与 schema 版本 | `openclaw-state-db-contract.ts` |
| `src/config/` | 配置 schema、session store、类型与运行配置 | `sessions/`、`zod-schema.*` |
| `scripts/` | 检查、构建、发布、测试编排 | `check.mts`、`build-all.mts` |

## 五、状态到底存在哪里

OpenClaw 不是把所有东西都塞进一个 JSON 文件。它至少有三类状态：

| 状态 | 作用 | 关键点 |
| --- | --- | --- |
| Gateway 全局状态 | 连接、设备、配置发布、插件/技能快照等 | `src/state/openclaw-state-db-contract.ts` 定义 schema 版本 `20` |
| Agent/Session 状态 | session 元数据、transcript、run 相关事实 | `src/state/openclaw-agent-db-contract.ts` 定义 schema 版本 `25` |
| Workspace 文件 | `AGENTS.md`、`SOUL.md`、`USER.md`、`MEMORY.md` 等 bootstrap 与技能 | 每轮按预算读取，不是无限制塞入 prompt |

此外还有**运行中的内存状态**：abort controller、session lanes、dedupe cache、WebSocket 连接、事件订阅。它们不是“可重建就无所谓”的缓存：dedupe 和 writer fence 直接决定并发正确性。

## 六、一次输入的高层路径

```text
渠道/客户端
  → 鉴权与路由
  → SessionKey
  → Run admission（查重、排队、取消/接管）
  → Agent command / embedded runner
  → system prompt + transcript + tools
  → Agent Loop（模型/工具回合）
  → transcript commit + terminal outcome
  → ReplyDispatcher
  → 原渠道或 UI 事件
```

两个常见入口：

- **渠道入口**：`dispatchInboundMessage()` 先 `finalizeInboundContext()`，再走 `dispatchReplyFromConfig()`。
- **Web/程序入口**：Gateway RPC `chat.send`，由 `src/gateway/server-methods/chat-send-*.ts` 负责参数校验、幂等、session 准入和 agent dispatch。

它们最终都会落到 `agentCommandFromIngress()` / `runEmbeddedAgent()` 一侧；差异主要在“谁提供输入上下文”和“谁消费回复”。

## 七、信任边界

OpenClaw 的默认安全模型不是“模型说什么就做什么”，而是多层边界：

1. **传输边界**：Gateway WS 首帧必须 `connect`；需要设备签名、nonce、scope 与配对审批。
2. **调用者边界**：operator 与普通渠道发送者权限不同；有些工具只对 owner 开放。
3. **工具边界**：工具装配先经过 capability/profile、workspace/sandbox policy、最终 authorization。
4. **执行边界**：`before_tool_call` 的 loop admission、可信策略、审批、hook、最终 owner approval 顺序固定。
5. **写入边界**：同一 session 只有一个 active writer；新 writer 接管会让旧 run 以 `superseded` 终止。
6. **扩展边界**：原生插件等价于进程内代码；MCP 是外部进程/服务，但仍走工具策略。

## 八、三条设计原则

项目根 `AGENTS.md` 把优先级写得很直接，这三条比目录结构更值得记住：

### 8.1 One owner per responsibility

一个责任只能有一个“做决定/改权威状态”的所有者。Adapter 只翻译合同，cache/projection 只从 owner 派生。于是：

- Session 路由归 Gateway；
- transcript 写入归当前 writer；
- provider 语义归 provider capability；
- 工具放行归 policy/approval chain。

### 8.2 Small core, capable plugins

核心新增一个“模型可见工具”会增加长期 context 成本。可选能力应放边缘；核心提供通用合同。新集成本身不构成再加一个核心 tool/manager 的理由。

### 8.3 Stable conversation context

重建过去上下文会破坏 prompt-prefix reuse。生成的 prompt/tool/context 增补必须**有界、确定、稳定**；只有 compaction 可以改写历史。技能/工具/记忆的刷新要走明确的失效合同。

## 九、全局地图自测

不看文档回答：

1. Gateway、Agent、Session、Run、Harness 各自拥有什么？
2. 为什么 Control UI 和 Telegram 可以共享会话，但不能共享“连接身份”？
3. 哪两类持久状态分别由 schema 20 和 schema 25 管？
4. 为什么“把渠道消息直接交给模型”是错误理解？
5. `AGENTS.md` 的三条 design priorities 分别防止什么退化？

练习：画一张只有五个方框的图，把 `chat.send`、`dispatchInboundMessage`、`runEmbeddedAgent`、`runAgentLoop`、`ReplyDispatcher` 放在正确层级，并标出“谁拥有 Session”。

---

### 自测参考答案

1. **Gateway** 拥有进程生命周期、连接/鉴权、渠道到 session 的路由、RPC、事件、审批传输和恢复入口；**Agent** 拥有配置身份、workspace、模型/工具策略与人格；**Session** 拥有长期会话身份和 transcript 所有权；**Run** 是一次被接纳的执行，拥有 runId、abort、终态和事件；**Harness** 是执行模型—工具循环的运行时合同/适配器，不是模型 provider 本身。
2. 二者可以通过同一个 `sessionKey` 落到同一 Session，因为 Session 表达“哪段对话”；但连接身份包含 transport、设备、role/scope、配对与审批能力。Telegram 连接不能替 Control UI 设备证明身份，也不能共享它的 operator scope。
3. **schema 20** 管 Gateway 全局状态：连接、设备、配置发布、插件/技能快照等；**schema 25** 管 Agent/Session 状态：session 元数据、transcript、run 相关事实与索引。
4. 渠道消息必须先 `finalizeInboundContext`、判断群/线程、建立 session/run 准入、选定 writer、组装 prompt/工具并经过 policy/approval。直接交给模型会绕过身份、去重、lane、writer fence、审批和回复路由。
5. **One owner per responsibility** 防“双写者/第二事实源”；**Small core, capable plugins** 防核心工具与上下文无限膨胀；**Stable conversation context** 防每轮重排 prompt 导致前缀缓存失效和上下文不可解释。

### 练习参考图

```text
渠道：dispatchInboundMessage → finalize → 群/线程分支 → agent command ┐
                                                                       ├→ runEmbeddedAgent → runAgentLoop
Gateway：chat.send → admission/ACK → detached dispatch → agent command ┘

Session 所有者：Gateway/session store（writer 仅获得 transcript 追加权）
输出所有者：ReplyDispatcher（渠道） / Gateway event stream（UI）
```

验收点：两条入口在统一 agent command/embedded runner 汇合；Session 仍归 Gateway；`ReplyDispatcher` 在输出侧，不在循环内部；`chat.send` 返回只代表已接纳。


*OpenClaw 2026.10.9 · 全局地图*
