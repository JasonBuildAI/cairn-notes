---
title: "00 · 全局地图：先建立不会迷路的坐标系"
description: "建立 Hermes 多前端、常驻宿主、Agent 核心和 SessionDB 的全局地图。"
---

> 基线：发布归档 `hermes-agent-0.22.5`（`v0.22.5`，发布日 `2026.9.24`）。归档不含 `.git`，不声称 commit/tag。
> 本篇不追细节，只回答四件事：Hermes 是什么、由谁拥有执行、代码放在哪里、一次输入会穿过哪些层。

## 1. 先从一个失败场景开始

假设你只想做“一个能聊天的 CLI”：

```text
用户输入 → 调模型 → 有工具就执行 → 把结果再发给模型 → 打印答案
```

这个模型在单进程、单用户、短任务下没问题。但 Hermes 要面对的是另一种现实：

- 同一套 Agent 要同时服务经典 CLI、TUI、Desktop、Telegram、Discord、Slack 等入口；
- 用户可能在手机上发一条消息，然后在电脑上继续同一个会话；
- 一次 turn 可能跑几十分钟，期间进程会重启、网络会断、模型会限流；
- 后台任务完成、定时任务触发、子 Agent 回报，都会产生“不是人发的新输入”；
- 两个进程可能同时想操作同一个 session；
- 工具可能删文件、发消息、改远端仓库，失败后必须知道副作用有没有发生；
- 上下文会超窗，压缩又会改变历史字节，直接影响 prompt cache 和成本。

如果把这些都塞进“CLI 主循环”，系统会迅速变成一堆只对当前进程有效的内存状态。Hermes 的选择是：**把执行从入口里拿出来，交给一个拥有会话和账本的宿主。**

## 2. 三种运行形态，一张拓扑

Hermes 不是一个进程，而是三种宿主形态共享同一个 Agent 核心：

```text
┌──────────────────────────── 入口层 ────────────────────────────┐
│ 经典 CLI            TUI / Desktop          消息平台           Dashboard / API │
│ (prompt_toolkit)    (Ink / Electron)       (Telegram, ...)    (web / serve)   │
└──────┬───────────────────┬──────────────────────┬──────────────────┬─────────┘
       │ GatewayAgent      │ JSON-RPC / WS        │ adapter          │ PTY / RPC
       ▼                   ▼                      ▼                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              宿主层                                           │
│  Gateway 进程（gateway/run.py）          tui_gateway Python 后端              │
│   ├─ SessionAuthority                   ├─ 构建真实 AIAgent                    │
│   ├─ durable FIFO                       ├─ session registry / event replay     │
│   ├─ TurnRunner                         ├─ slash worker / server requests      │
│   └─ adapter delivery                   └─ 可绑定 canonical session authority   │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                               Agent 层                                        │
│  AIAgent（run_agent.py）                                                      │
│   ├─ TurnFacade：durable turn lease / relay / accounting scope                │
│   ├─ conversation_loop：同步 turn 循环                                        │
│   ├─ turn_context：历史、system prompt、压缩、钩子                             │
│   ├─ turn_api_*：请求、流式、重试、fallback                                    │
│   ├─ turn_tool_round / tool_executor：工具轮次                                 │
│   └─ turn_finalizer：收尾、持久化、memory/skill review                         │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                               持久层                                          │
│  SessionDB（SQLite WAL）                                                      │
│   messages / sessions / system_prompts / admissions / leases / locks / ...    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 经典 CLI：代理，不是执行者

`hermes` 的经典 REPL（`cli.py::HermesCLI`）在第一次需要 Agent 时调用 `_init_agent()`，而它导入的是：

```python
from hermes_cli.gateway_agent import GatewayAgent as AIAgent
```

`GatewayAgent.run_conversation()` 只做三件事：

1. 把用户消息、历史、作者信息、持久化元数据打包成 `prompt.submit`；
2. 在调用线程上消费 Gateway 的 `event` 流，把 `message.delta`、工具进度、审批请求等翻译回 CLI 回调；
3. 等到本 admission 的 `message.complete`，拼出与 `AIAgent.run_conversation()` 同形状的 result。

因此 CLI 进程**不构建真实 agent、不执行工具、不写 `state.db`**。它是一块“远程终端”，不是执行引擎。

### 2.2 消息平台：一个 Gateway 服务多个平台

`gateway/run.py` 是 facade，启动、adapter、入站、turn、busy、goal、通知、关闭分别拆在 `run_*.py`。`gateway/platforms/` 下是各平台 adapter，根文档描述为约 20 个内建平台。

一条平台消息的路径是：

```text
adapter 收到消息
  → 解析来源、身份、chat/session key
  → 检查 active session 的 pending queue
  → SessionAuthority.submit(...)
  → 写入 session_admissions（durable FIFO）
  → drain 领取，TurnRunner 组织 turn
  → 真实 AIAgent.run_conversation(...)
  → 事件/流式输出 → adapter 回复原渠道
```

Gateway 有两道“忙碌时消息守卫”：

- adapter 层的 `_pending_messages`；
- runner 层对 `/stop`、`/new`、`/queue`、`/status`、`/approve`、`/deny` 的内联拦截。

新命令如果必须在 Agent 阻塞时到达（例如审批），必须同时绕过这两道守卫，不能走后台消息处理路径。

### 2.3 TUI / Desktop：共享 Python 后端

`hermes --tui` 的进程模型是：

```text
Node (Ink)  ──stdio JSON-RPC──  Python (tui_gateway)
   │                                  └─ AIAgent + tools + sessions
   └─ 只负责渲染 transcript / composer / 交互
```

TypeScript 只拥有屏幕；Python 拥有 session、工具、模型调用和 slash 逻辑。Desktop 通过 `apps/shared` 的 `JsonRpcGatewayClient` 连同一个后端（WebSocket），而不是在 React 里重写 Agent。

`tui_gateway/agent_factory.py` 会直接 `from run_agent import AIAgent` 并构建实例。所以 TUI/Desktop 这条路上，AIAgent 就在 Python 后端进程（或它的 compute-host 子进程）里，不需要经过 Gateway 的 `GatewayAgent` 代理。

Dashboard 又是另一种：`web/` 的 `/chat` 通过 PTY 嵌入真正的 `hermes --tui`，不是第二套聊天 UI。Desktop 与 Dashboard 的差别是：Desktop 是独立原生聊天面，Dashboard 是浏览器里的真 TUI 容器。

### 2.4 三条路为什么仍是一个系统

因为它们最终都落到同一组合同：

- 同一个 `AIAgent.run_conversation()` 形状；
- 同一个 `agent/turn_*.py` 阶段划分；
- 同一个 `SessionDB` transcript 与 schema；
- 同一套 `toolsets` / `model_tools` / `providers`；
- 同一套 durable lease、压缩、审批和事件语义。

入口可以不同，**执行不变量必须相同**。这就是 Hermes 能在多端之间保持一致的原因。

## 3. 四层职责

| 层 | 拥有什么 | 不拥有什么 | 典型源码 |
| --- | --- | --- | --- |
| 客户端 | 输入、渲染、本地交互状态、slash 补全 | Agent 构建、工具执行、transcript 权威 | `cli.py`、`ui-tui/`、`apps/desktop/`、`gateway/platforms/` |
| 宿主 | session 生命周期、admission/FIFO、turn 调度、事件、审批往返、投递 | 具体模型协议细节、工具实现 | `gateway/`、`tui_gateway/` |
| Agent | 一轮 turn 的上下文、模型请求、工具轮次、压缩、收尾 | 跨进程排队、平台投递、UI 渲染 | `run_agent.py`、`agent/` |
| 持久层 | transcript、system prompt、admission、lease、锁、usage、恢复元数据 | 业务决策、模型选择策略 | `hermes_state*.py` |

一条重要推论：**“谁拥有状态”比“状态存在哪里”更重要。** 客户端可以有自己的一份缓存，但涉及其他端也能改的状态，权威必须在宿主或 `SessionDB`。

## 4. 目录地图

| 路径 | 职责 | 先看什么 |
| --- | --- | --- |
| `run_agent.py` | `AIAgent` 门面与 mixin 组装 | 类定义、`__init__` 参数、mixin 列表 |
| `agent/` | turn 循环、上下文、压缩、工具执行、模型传输、持久化 facade | `AGENTS.md`、`conversation_loop.py`、`turn_*.py` |
| `cli.py` / `hermes_cli/` | 经典 CLI、配置、认证、命令、GatewayAgent | `hermes_cli/AGENTS.md`、`cli_agent_setup_mixin.py` |
| `gateway/` | 消息网关、adapter、session authority、turn runner、投递 | `gateway/AGENTS.md`、`run.py`、`session_authority.py` |
| `tui_gateway/` | TUI/Desktop 的 Python JSON-RPC 后端 | `tui_gateway/AGENTS.md`、`server.py`、`agent_factory.py` |
| `hermes_state*.py` | SQLite 会话账本、FTS、压缩锁、admission、修复 | `hermes_state_common.py` 的 schema、`hermes_state.py` 的 docstring |
| `tools/` | 工具实现、审批、连接器、委派、浏览器、终端 | `tools/AGENTS.md` |
| `toolsets.py` / `model_tools.py` | toolset 解析、schema 生成、工具路由 | `_HERMES_CORE_TOOLS`、`resolve_toolset()`、`handle_function_call()` |
| `providers/` | provider profile 注册与发现 | `providers/base.py`、`providers/__init__.py` |
| `plugins/` | 插件加载器与内建插件种类 | `plugins/AGENTS.md`、`plugin_loader.py` |
| `skills/` | 内置技能与技能规范 | `skills/AGENTS.md` |
| `cron/` | 定时任务与 kanban 多 Agent 队列 | `cron/AGENTS.md` |
| `web/` / `apps/desktop/` / `ui-tui/` | Dashboard、Desktop、Ink TUI | 各自的 `AGENTS.md` |
| `pm/` / `pyproject.toml` / `uv.lock` | 依赖、工具链、哈希锁定 | `pm/AGENTS.md` |

## 5. 七块框架

### 循环

核心是 `agent/conversation_loop.py:1785` 的同步 `run_conversation()`。每轮迭代按固定阶段推进：

```text
begin_iteration → prepare_iteration → assemble_api_request
→ run_preflight_gate → announce_api_call → API retry loop
→ apply_retry_restarts → normalize_model_response
→ tool round 或 finish_text_response
→ finalize_turn
```

循环的停止条件不是“模型说了 stop”这么简单：还有迭代预算、运行预算、用户中断、压缩阻塞、工具守卫、持久化失败、流式超时和空响应恢复。

### 上下文

`build_turn_context()` 负责一轮的输入准备；`build_api_messages()` 负责生成真正发往 provider 的副本。历史消息回放 `api_content` sidecar，system prompt 按 `stable → context → volatile` 三层组装，每 session 只构建一次，之后原样重放。压缩是唯一允许改变这段字节的地方。

### 工具

`toolsets.py` 定义静态 toolset 和核心工具；`model_tools.py` 把 toolset 解析成 schema，并路由每次调用；`agent/tool_executor.py` 负责并发/串行/分段执行、审批、心跳、结果持久化和中断补偿。

### 模型接入

`ProviderProfile` 是声明式的：auth 类型、base URL、models URL、流式支持、vision 能力、请求 quirk、错误分类、模型别名都写在 profile 里。真正的 client 构造、凭据轮换和流式处理仍在 `AIAgent`/transport 层。

### 扩展

Hermes 的核心是“窄腰”：每个模型工具都会在每次 API 调用中发送，所以新增核心工具的门槛很高。新能力优先放到 CLI + skill、service-gated tool、plugin、MCP 或独立仓库。

### 界面

经典 CLI 是代理；TUI/Desktop 是共享 Python 后端；Dashboard 嵌入真 TUI；消息平台通过 adapter。所有界面共享 slash 语义、审批/澄清请求和事件形状。

### 工程

prompt cache 不变量、profile scope、exact pin、行为契约测试、代码健康棘轮和 `scripts/check` 共同构成“改动不会悄悄破坏系统”的防线。

## 6. 四条纵线

### 6.1 事实纵线：transcript 与 projection

```text
SessionDB.messages（canonical transcript）
   ├─ 读模型：CLI/TUI/Desktop 的 history
   ├─ 写模型：AIAgent._flush_messages_to_session_db
   ├─ 压缩：parent_session_id 旋转 / active/compacted 标记
   └─ 搜索：FTS5（可选外部内容布局）
```

`SessionDB` 不是简单聊天日志。它还保存 `session_admissions`（排队输入）、`session_turn_leases`（跨进程 turn 租约）、`compression_locks`（压缩互斥）、`worker_executions` / `worker_receipts`（后台工作回执）、`conversation_generations`（会话代际）和 `gateway_heartbeats`（后端存活）。

### 6.2 事件纵线：live stream 与 durable transcript

事件流负责“现在正在发生什么”：`message.delta`、工具开始/结束、审批请求、状态更新、`message.complete`。transcript 负责“已经发生了什么”。二者不能混为一谈：

- 断线重连靠 transcript 和 event replay；
- 实时 UI 靠事件流；
- 审批/澄清是 server→client request，需要客户端明确应答；
- 后台任务完成通过 `admit_internal_event` 进入同一 durable FIFO，而不是偷偷插一条消息。

### 6.3 权限纵线：谁能提交、谁能执行、谁能改

```text
Principal / capability
   → SessionAuthority.authorize(submit)
   → admission row
   → turn lease
   → approval / guardrail
   → tool effect
```

每一层都不是装饰：客户端不能伪造 owner；lease 防止两个进程同时写同一 session；approval 防止危险命令；guardrail 防止工具越界；profile scope 防止一个 profile 的设置泄漏到另一个 profile。

### 6.4 成本纵线：上下文、缓存、辅助模型

一次 turn 的成本由至少五件事决定：

1. system prompt 是否字节稳定（prompt cache 命中率）；
2. 历史是否被无谓改写（cache 前缀断裂）；
3. 是否触发压缩，压缩用哪个辅助模型；
4. 工具结果是否被截断/落盘；
5. provider fallback、credential 轮换和 reasoning 参数是否造成额外调用。

Hermes 把“prompt cache 神圣”写成硬不变量，是因为在多轮 Agent 里，缓存失效往往比多调一次工具更贵。

## 7. 关键术语

| 术语 | 含义 | 关键源码 |
| --- | --- | --- |
| Session | 跨轮会话账本，有 source、model、system_prompt、parent_session_id | `sessions` 表 |
| Turn | 一次 `run_conversation()`，有 admission、lease、开始/终点 | `turn_facade.py` |
| Admission | 一次被持久接纳的输入，按 `seq` 排队 | `session_admissions` |
| Lease | 跨进程“会话房卡”，同一 session 同时只允许一个 turn 持有 | `session_turn_leases` |
| Transcript | canonical 消息历史，`messages` 表 | `hermes_state.py` |
| `api_content` | 某条消息实际发往 provider 的字节副本，用于 cache 稳定回放 | `messages.api_content` |
| Compression | 对历史做有损压缩，可旋转 child session | `context_compressor.py` |
| Toolset | 工具的逻辑分组，可 include 其他 toolset | `toolsets.py` |
| Profile | 一套独立的 `HERMES_HOME`、配置、凭据和插件 | `hermes_cli`/`pm` |
| GatewayAgent | 经典 CLI 侧的 AIAgent 代理，不执行 turn | `hermes_cli/gateway_agent.py` |

## 8. 读源码的三遍法

### 第一遍：只追一条线

```text
CLI/消息/TUI
  → prompt.submit
  → SessionAuthority
  → TurnRunner
  → AIAgent.run_conversation
  → TurnFacade lease
  → build_turn_context
  → conversation_loop
  → finalize_turn
  → SessionDB / 事件 / 回复
```

不要在第一遍打开 `chat_completion_helpers.py`。它很大，但它是“传输细节”，不是主线。

### 第二遍：追问三个归属

- 这个字段的事实源是谁？内存、transcript、admission 还是 UI 缓存？
- 谁有资格修改它？客户端、宿主、Agent 还是某个工具？
- 失败后哪条记录能证明“已经做到哪一步”？

### 第三遍：做最小实验

- 打印一次 `prompt.submit` 的 admission receipt；
- 在 `build_api_messages()` 前后对比 `api_content`；
- 手动触发一次压缩，观察 `parent_session_id` 和 `compression_locks`；
- 在工具执行前杀掉进程，重启后看 transcript 是否留下 tool-call block；
- 让 provider 返回 429，观察 retry、fallback 和 preflight 重算。

## 9. 一句话心智模型

> **Session 是账本，Turn 是事务，Admission 是排队号，Lease 是房卡，Transcript 是已发生事实，Event 是正在发生的事实。**
>
> 读 Hermes 时，先问“这件事归谁拥有”，再问“失败后谁能证明它发生过”。把这两个问题答清楚，代码结构就会变得非常顺。
