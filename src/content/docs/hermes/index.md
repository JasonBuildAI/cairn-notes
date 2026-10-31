---
title: "Hermes Agent 0.22.5 源码课 · 导读"
description: "Hermes Agent 0.22.5 源码课导读：多前端、宿主、单一 Agent 核心与持久会话账本。"
---

:::note[独立学习笔记]
这是基于 [Hermes Agent](https://github.com/NousResearch/Hermes-Agent) 版本 v0.22.5 发布归档源码与公开文档整理的独立学习笔记，不是官方文档。本站不包含上游源码或归档；下文以 $HERMES_SRC 表示你自己的本地源码目录。
:::

> 基线：发布归档 `hermes-agent-0.22.5`（发布版本 `v0.22.5`；`hermes_cli/__init__.py` 记录发布日 `2026.9.24`）。
> 归档不含 `.git`，因此本文不声称 commit 或 git tag；所有结论以该发布包的源码符号、配置默认值和目录结构为准。
> 本文所有路径都相对 `$HERMES_SRC`。
> 旧版讲义不在本仓库中；本课只以 v0.22.5 发布归档为准，旧版结论不再作为依据。
> 注意：`pyproject.toml` 里的 `version = "0.0.0"` 是构建占位，不是发布版本。

## 一句话理解 Hermes

**Hermes 是一个“多前端 + 常驻宿主 + 单一 Agent 核心 + 持久会话账本”的个人 Agent 平台：客户端只负责输入和呈现，Gateway / TUI 后端拥有会话与执行，`AIAgent` 用同步循环完成一轮 Turn，`SessionDB` 则把 transcript、排队输入、turn 租约、压缩锁和跨进程恢复状态统一记在 SQLite 里。**

把它想成一家 24 小时营业的事务所：

```text
经典 CLI ──GatewayAgent──┐
Telegram / Discord / ... ─┤
TUI / Desktop ────────────┼──► 宿主（Gateway 或 tui_gateway）
Dashboard / API ──────────┘        │
                                   ├─ SessionAuthority：谁可以提交、排队、领取
                                   ├─ TurnRunner：组织一次 turn 的上下文与回调
                                   ▼
                             AIAgent（同一套核心）
                               TurnFacade → durable lease
                               conversation loop
                               provider / tools / compressor
                                   │
                                   ▼
                             SessionDB（WAL）
                               messages / admissions / leases / locks
                                   │
                                   ▼
                             事件流 / 流式输出 / 渠道回复
```

这张图最重要的不是“有几个入口”，而是**入口不拥有执行**。入口只把一次输入变成一个有身份的提交；真正执行 turn 的宿主必须持有会话、租约和持久化责任。

## 七块总表

| 部件 | 要回答的问题 | Hermes 的答案 | 主要源码 |
| --- | --- | --- | --- |
| 循环 | 一轮怎样推进，何时停？ | 同步 `conversation_loop`，每轮经过上下文、请求、重试、响应、工具、收尾六个阶段 | `agent/conversation_loop.py`、`agent/turn_*.py` |
| 上下文 | 模型这次看到什么，超窗怎么办？ | 三层 system prompt + `api_content` 字节稳定回放 + 压缩/旋转 session | `agent/turn_context.py`、`agent/system_prompt.py`、`agent/context_compressor.py` |
| 工具 | 模型能做什么，结果怎样回流？ | toolset 过滤 → schema 生成 → 审批/守卫 → 并发或串行执行 → 持久化结果 | `toolsets.py`、`model_tools.py`、`agent/tool_executor.py` |
| 模型接入 | 怎样统一多厂商、多协议、多凭据？ | 声明式 `ProviderProfile` + transport 分支 + credential pool + fallback | `providers/base.py`、`agent/chat_completion_helpers.py`、`agent/credential_pool.py` |
| 扩展 | 核心之外怎样长能力？ | plugin、skill、MCP、subagent、cron、kanban；核心保持窄腰 | `plugins/`、`skills/`、`cron/`、`tools/delegate_tool*` |
| 界面 | 人、程序、IM 怎样使用同一引擎？ | 经典 CLI 代理到 Gateway；TUI/Desktop 共用 Python 后端；Dashboard 嵌入真 TUI | `hermes_cli/gateway_agent.py`、`tui_gateway/`、`apps/desktop/`、`web/` |
| 工程 | 为什么改动不会把系统弄坏？ | prompt cache 不变量、profile scope、exact pin、行为契约测试、健康棘轮 | `AGENTS.md`、`pyproject.toml`、`scripts/check`、`tests/AGENTS.md` |

三条纵线贯穿每一块：

1. **事实归属**：transcript 和 admission 在 `SessionDB`；内存里的 `messages` 只是本轮工作副本。
2. **权限边界**：客户端能提交什么、宿主能领取什么、工具能改什么，分别由 admission、lease、approval/guardrail 约束。
3. **成本边界**：prompt cache、上下文压缩、辅助模型、credential pool 和 fallback 共同决定一次 turn 的真实成本。

## 先记住四个边界

### 1. 客户端不拥有 Agent

经典 CLI 的 `_init_agent()` 明确把 `GatewayAgent` 当成 `AIAgent` 的替身：

```python
from hermes_cli.gateway_agent import GatewayAgent as AIAgent  # the gateway runs the turn
```

`GatewayAgent` 的模块注释写得更直接：**CLI 进程不构建真实 agent、不跑工具、不写 `state.db`**。它只提交 `prompt.submit`，然后在调用线程上回放 Gateway 的事件流，最后拼出一个与 `AIAgent.run_conversation()` 同形状的 result dict。

但这句话不能外推到所有前端：

- **消息平台**：Gateway 进程内持有真实 `AIAgent`，由 adapter 把消息交给 session authority。
- **TUI / Desktop**：共享的 Python `tui_gateway` 后端自己构建 `AIAgent`，也可以走 canonical gateway transport 绑定 session authority。
- **Dashboard**：通过 PTY 嵌入真正的 `hermes --tui`，不是另写一套聊天 UI。

所以正确说法是：**“执行属于宿主，不属于渲染层”**，而不是“所有前端都走同一个 Gateway 进程”。

### 2. Gateway 是会话权威，不只是消息转发器

`gateway/session_authority.py` 的模块注释说得很清楚：它拥有“live sessions 和 canonical durable FIFO scheduling”；只有持有 profile ownership 的运行时 bootstrap 才能初始化它。一次提交会先经过 principal 鉴权、session 提交权限、payload 规范化，然后写入 `session_admissions`，由 drain 按 `seq` 领取。

这解决的是多进程现实：CLI、Desktop、Gateway、后台通知可能同时想操作同一个 session。只靠内存锁不够，必须有一个跨进程的持久队列。

### 3. Agent 是同步 Turn，不是常驻协程

`AIAgent` 由十几个 mixin 组成，`run_conversation()` 先经过 `TurnFacadeMixin` 拿 durable lease，再进入 `agent/conversation_loop.py` 的同步循环。循环里没有“后台思考线程”；模型调用、工具执行、压缩和持久化都在同一条 turn 主线上推进。异步只出现在宿主层（Gateway 的 asyncio、TUI 的 JSON-RPC、工具线程池）。

### 4. 唯一允许中途改上下文的是压缩

根 `AGENTS.md` 把 **per-conversation prompt caching** 列为最高不变量：不得改历史消息、不得中途换 toolset、不得重载 memory、不得重建 system prompt。唯一例外是 context compression。

因此你会看到很多看似“绕”的设计：`api_content` sidecar、三层 prompt、frozen workspace snapshot、压缩后 session 旋转。它们都在服务同一件事：**让同一段历史在每次 API 调用中保持字节稳定，除非系统明确决定压缩。**

## 阅读顺序

| 顺序 | 文档 | 你会得到什么 |
| --- | --- | --- |
| 0 | [全局地图](overview/) | 产品定位、进程拓扑、四层职责、目录与术语 |
| 1 | [一次 Turn 的一生](turn-lifecycle/) | 从输入提交到 lease、上下文、API、工具、收尾、投递的完整主线 |
| 2 | [核心机制](core-mechanisms/) | 循环、上下文、工具、模型、持久层、扩展、界面七块深挖 |
| 3 | [工程实战](engineering/) | 调试路径、源码实验、失败矩阵、扩展配方与毕业练习 |

## 阶段课（源码深入）

总览之后，按 [阶段导读](learning-path/) 从阶段 0 走到阶段 9。`00`～`03` 负责建立全局与机制直觉；阶段卷沿真实源码拆开 ownership、状态迁移、失败恢复和可观察实验，每篇自测与练习均附参考答案。

## 最容易混淆的五件事

1. **`GatewayAgent` 不是 `AIAgent`**：前者是 CLI 侧代理，负责提交和回放事件；后者是真正跑 turn 的核心。
2. **Session 不是 Turn**：Session 是跨轮账本；Turn 是其中一次有 admission、lease、开始和终点的执行。
3. **压缩不是“删消息”**：它会保留受保护的头尾、总结中间段、处理孤儿 tool pair，并可旋转出新的 child session。
4. **Memory / Skill 不是当前上下文**：它们影响下一轮 prompt 的 volatile 层；当前这轮看到的是已经组装好的 API 副本。
5. **Queue 不是 Steer**：`queue` 是排到下一轮；`steer` 是在当前 turn 的工具边界注入一条用户消息，二者在 admission intent 和投递时机上不同。

## 学习完成标准

读完后应能不看文档回答：

- 一条经典 CLI 输入为什么不会在 CLI 进程里执行？它最终在哪里变成 `AIAgent.run_conversation()`？
- `session_admissions` 的 `queued / started / unknown / terminal` 各自意味着什么？
- durable turn lease 的 TTL、刷新间隔和丢失后的行为是什么？
- system prompt 的三层分别放什么，为什么 workspace snapshot 要冻结？
- 压缩触发阈值、受保护头尾、session 旋转和 `compression_locks` 如何配合？
- 为什么工具调用必须先持久化再执行？持久化失败时为什么不能“先跑了再说”？
- API fallback 为什么必须回到 preflight 重算上下文，而不是直接换 provider 继续？
- plugin、skill、MCP、subagent、cron、kanban 各自扩展的是哪一层？

### 学习完成标准参考答案

1. **因为经典 CLI 只是渲染/提交代理。** 输入经 `HermesCLI.chat()` 交给 `GatewayAgent.run_conversation()`，后者通过 `connection.call("prompt.submit", ...)` 提交到 Gateway；真正的 admission、`TurnRunner`、durable lease、`AIAgent.run_conversation()`、模型和工具都在 Gateway 进程执行。TUI/Desktop 可以由自己的宿主后端执行，但原则仍是“执行属于宿主，不属于渲染层”。
2. **`queued`** 是已持久化、尚未开始；**`started`** 是 worker 已接手执行；**`unknown`** 是提交/启动边界不确定，必须 readback/reconcile；**`terminal`** 是已有明确终态。把 unknown 当 queued 会重复执行，当 terminal 会丢工作或错误宣布完成。
3. durable lease 默认 TTL 300 秒、等待上限 1800 秒、正常约 60 秒刷新。**租约丢失后，当前 turn 必须中断并停止写 transcript/终态**，由新 owner 在租约过期和 reconcile 后接管；watchdog 还要发现“进程活着但事件循环、刷新协程或 DB 阻塞”的情况，否则这 300 秒内旧 owner 仍可能被误认为有效。
4. **stable** 放身份、指导、coding brief 和固定 skills 指引；**context** 放调用方 system message、项目上下文文件和 workspace snapshot；**volatile** 放 skills index、memory、profile、时间戳和 runtime hints。workspace snapshot 按 session 冻结，是为了同一轮多次 API 调用不会因 cwd 或文件变化重写前缀，破坏 prompt cache 和对话字节稳定性。
5. 默认压缩阈值 0.50、保护前 3 条和后 20 条，摘要目标约 0.20，tail mode 为 lean；小窗口可能把阈值抬到约 0.75。压缩由 `compression_locks` 保证同一 session 只有一个压缩者，失败有 cooldown；需要改写历史时旋转出 child session，并用 `parent_session_id` 保留原 transcript，避免把压缩结果覆盖到旧账本。
6. **先持久化 tool-call，再执行副作用。** 这样崩溃后至少能证明“这次 turn 打算调用什么”。如果 canonical append 失败，Hermes 会以 `session_persistence_failed` 结束 turn，而不是先跑再补账：因为账本没有调用记录时，既无法证明副作用是否发生，也不能把内存结果当作可信事实送回模型；对删除文件这类不可逆操作尤其危险。
7. **因为 fallback 后的 context window、token 估算、API mode、消息形状、工具 schema 和压缩状态都可能不同。** 直接换 provider 继续发会溢出窗口、发送不支持字段、留下孤儿 tool pair 或破坏缓存前缀；正确做法是 `restart_with_rebuilt_messages`，回到 preflight 重新构建 system prompt/wire copy、重算预算和压缩。
8. **plugin** 扩展进程内能力注册（provider/channel/tool/hook）；**skill** 扩展知识、流程和资源包；**MCP** 扩展外部工具协议；**subagent** 扩展受控子任务与并发；**cron** 扩展 durable 定时调度；**kanban** 扩展 durable 多 Agent 工作队列。它们分别改变不同层，不能用“多装一个工具”互相替代。

> **一句话总结：Hermes 的核心不是“让模型多轮调用工具”，而是把一次 Agent 执行变成一个有身份、有租约、有账本、可恢复、可审计的 Turn。**
