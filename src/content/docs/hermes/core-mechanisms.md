---
title: "Hermes Agent 0.22.5 核心机制"
description: "梳理同步循环、上下文压缩、工具执行、凭据池、恢复与扩展平台。"
---

> 基线：`hermes-agent-0.22.5` 发布归档，`hermes_cli/__init__.py` 的 `__release_date__ = "2026.9.24"`。归档不含 `.git`，所以本文不虚构 tag/commit；`pyproject.toml` 里的 `version = "0.0.0"` 是构建占位，不是发布版本。
> 本文所有源码路径都相对 `$HERMES_SRC`。
> 先读 `overview.md` 和 `turn-lifecycle.md`，再看这一篇。

## 0. 一页总模型

Hermes 最容易读错的地方，是把它当成“一个 CLI 调模型”。更准确的心智模型是：

```text
客户端：CLI / TUI / Desktop / Telegram / Discord ...
   │  prompt.submit / slash / event
   ▼
Gateway：adapter → durable admission FIFO → TurnRunner
   │
   ▼
AIAgent：TurnFacade → durable lease → conversation loop
   │                 │              │
   │                 │              ├─ context compressor
   │                 │              ├─ provider / tools
   │                 │              └─ SessionDB / event stream
   │                 └─ liveness watchdog
   ▼
事件流 / transcript / 最终回复 → 客户端
```

一句话：

> **Session 是账本，Turn 是事务，Admission 是排队号，Lease 是房卡，Transcript 是已经发生的事实，Event 是正在发生的事实。**

| 对象 | 拥有什么事实 | 最容易混淆成什么 |
| --- | --- | --- |
| Session | 跨轮 transcript、模型配置、system prompt、父子会话关系 | 一条消息 / 一个运行中的协程 |
| Turn | 一次执行的身份、租约、迭代、工具轮次、终态 | Session 本身 |
| Admission | 输入是否被接纳、排队顺序、queue/steer/redirect 意图 | 内存队列 |
| Lease | 当前哪个进程/持有者有权推进该会话 | 永久锁 |
| Transcript | canonical 消息与工具调用/结果配对 | 本次 prompt 投影 |
| Event | 流式进度、工具事件、状态通知 | durable 历史 |
| Compression | 把旧上下文变成摘要并可能旋转 session | 简单删消息 |

读这一篇时始终问三件事：

1. 这条事实由谁写？是 projection 还是 canonical state？
2. 进程在这里崩溃，下一任 owner 能从哪里恢复？
3. 这个改动会不会让同一段历史在两次 API 调用中产生不同字节，破坏 prompt cache？

---

## 1. 循环：一次 Turn 从哪里开始，到哪里结束

### 1.1 问题

Agent loop 的难点不是“while 有 tool_call 就继续”，而是：

- 谁来保证同一 session 只有一个 writer？
- 模型调用、工具副作用、transcript 写入按什么顺序发生？
- 预算、取消、fallback、压缩、持久化失败怎样收尾？
- 进程崩溃后，下一任怎么知道上一次做到哪里？

Hermes 的答案不是把这些问题塞进一个大循环，而是把一次 turn 做成有前置准入、执行体和收尾的事务。

### 1.2 心智模型：Turn 是一笔有房卡的会话事务

```text
输入已持久化
  → 取得/等待 session turn lease
  → 构建本轮上下文（system prompt 只构建一次）
  → preflight compression
  → API call
  → 工具轮次（先记账，再执行）
  → normalize / finalize
  → 持久化 transcript / usage / 事件
  → 释放 lease、scope、watchdog
```

lease 不是“性能优化”，而是跨进程的所有权事实。TTL 默认 300 秒，等待上限 1800 秒，正常刷新间隔 60 秒；刷新失败会中断 turn，而不是继续写一个自己已经不拥有的 transcript。liveness watchdog 处理的是“进程还在、事件循环卡住、刷新协程也停了”的情况。

### 1.3 源码主线

**执行核心**：

- `run_agent.py:214`：`class AIAgent`，通过 mixin 组合能力。
- `run_agent.py:241`：`max_iterations: int = sys.maxsize`。注意：这是内核默认值，不代表宿主一定无限运行；Gateway/TUI 会传入更小的预算，例如 TUI 的 `_cfg_max_turns(cfg, 500)`。
- `agent/turn_facade.py:22`：`TurnFacadeMixin.run_conversation()`，负责准入、lease、relay/accounting/portal scope 和最终清理。
- `agent/conversation_loop.py:1785`：`run_conversation()`；真正的 turn 主体在 `_run_conversation_turn()`（约 `:1623`）。
- `agent/turn_facade_lease.py:26-27`：`LEASE_TTL_SECONDS = 300.0`、`LEASE_WAIT_SECONDS = 1800.0`。
- `agent/turn_facade_lease.py:34`：`DurableTurnLease`；`:297`：`admit_durable_turn_lease()`。

**Gateway 侧**：

- `gateway/run.py:3339`：`GatewayRunner`。
- `gateway/run_turn.py:1165`：构造 `TurnRunner`。
- `gateway/run_turn_runner.py:175`：`TurnRunner`。
- `gateway/run_turn_runner.py:998`：调用真正的 `agent.run_conversation(...)`。

**主循环的关键阶段**（`conversation_loop.py`）：

```text
begin_iteration
  → prepare_iteration
  → assemble_api_request
  → run_preflight_gate
  → announce_api_call
  → _run_api_retry_loop
  → apply_retry_restarts
  → normalize_model_response
  → run_tool_round 或 finish_text_response
  → finalize_turn
```

对应代码约在 `:1727-1774`。这是一个“阶段化”的循环：每个阶段可以返回 `continue`、`break` 或完整 result，而不是让所有逻辑都在一个大 `try` 里互相覆盖状态。

### 1.4 停止条件不是一个布尔值

一次 turn 可能因为以下原因结束：

- 纯文本响应通过 stop gates；
- `api_call_count` 或 `iteration_budget` 耗尽；
- 用户中断 / lease 丢失 / liveness watchdog；
- 压缩超时或阻塞；
- 工具 guardrail halt；
- transcript 持久化失败；
- provider 终态错误、重试耗尽、fallback 失败；
- 空响应、重复输出等恢复路径仍失败。

不要把所有这些都记录成 `error` 或 `success`。可靠系统必须保留**结束原因**，否则恢复策略会把“预算停止”当成“模型失败”，或把“持久化失败”当成“可以安全重试”。

### 1.5 设计取舍

- **内核默认无限迭代，宿主设置预算**：便于子 Agent/批处理复用，但要求宿主真正负责成本上限。
- **同步 turn、不是常驻协程**：简化 transcript 顺序和 lease 生命周期，代价是长工具调用占用 worker。
- **阶段化循环**：每个阶段可测试、可恢复，代价是状态字段和返回协议更多。

### 1.6 常见误解

| 误解 | 事实 |
| --- | --- |
| `run_conversation()` 是 AIAgent 里一个大函数 | 它是 facade，真正的 loop 在 `agent/conversation_loop.py` |
| `max_iterations` 默认 500 | 代码默认是 `sys.maxsize`；500 是某些宿主传入的策略值 |
| lease 只是数据库锁 | 它还决定中断、失权后能否继续持久化，以及新 owner 何时能接管 |
| 模型停止输出，turn 就结束了 | 还要 finalize、持久化、事件投递和资源清理 |

---

## 2. 上下文：模型看到的不是 `messages` 原样

### 2.1 问题

同一段会话在每一轮 API 调用中都要满足三个相互冲突的目标：

1. 让模型看到足够的历史和工具结果；
2. 不撑爆上下文窗口；
3. 尽量让前缀字节稳定，命中 provider 的 prefix cache。

Hermes 的解法是把“显示历史”“API 回放历史”“本次 wire copy”拆开，并在压缩时显式改变会话边界。

### 2.2 心智模型：三层 prompt + 三份消息

**system prompt 三层**（`agent/system_prompt.py:736`）：

- `stable`：身份、指导、coding brief、固定 skills 指引等；
- `context`：调用方 `system_message`、项目上下文文件、workspace snapshot；
- `volatile`：skills index、memory、用户 profile、外部 memory、profile 行、时间戳、runtime hints。

越不稳定的内容越靠后，这样 stable 前缀可以复用；只有压缩会触发 `invalidate_system_prompt()`（`:814`）重建。

**消息的三份形态**：

| 形态 | 存哪里 | 用途 |
| --- | --- | --- |
| `content` | SessionDB `messages` | 显示/审计的 canonical 内容 |
| `api_content` | SessionDB `messages` sidecar | provider 回放用的稳定 API 形状 |
| wire copy | 本次请求内存 | 压缩、预算、hook、provider 适配后的实际请求副本 |

`build_api_messages()` 在 `agent/turn_context.py:1243`。它不会直接把 DB 行原样发出去，而是按本轮上下文重新组装 wire messages；但历史前缀必须与持久化回放保持一致，否则 resume 会在中途出现字节分歧。

### 2.3 源码主线

**Turn context**：

- `agent/turn_context.py:1036`：`build_turn_context()`。
- 顺序非常重要：**先构建 system prompt，再创建/绑定 DB session row**。如果反过来，session row 可能记录 `system_prompt=NULL`，下一轮无法复用同一份 prompt，造成 cache miss 或缺少约束。
- workspace snapshot 按 session 冻结，缓存 key 包含 cwd；这样同一轮多次 API 调用不会因为工作目录变化而重写前缀。

**上下文文件**：

- `agent/prompt_builder.py:41`：`_CONTEXT_FILE_READ_TIMEOUT_SECS = 5.0`。
- `CONTEXT_FILE_MAX_CHARS = 20_000`。
- 动态上限约为上下文窗口的 6%，最高 500,000 字符。
- 读取超时会降级并产生诊断，不应无限阻塞 turn。

**压缩**：

- `agent/context_engine.py:48`：`ContextEngine` 基类默认 `0.75 / protect_first_n=3 / protect_last_n=6`，仅当插件引擎没有覆盖时使用。
- `agent/context_compressor.py:2152`：`ContextCompressor`。
- `__init__` 默认 `threshold_percent=0.50`、`protect_first_n=3`、`protect_last_n=20`、`summary_target_ratio=0.20`。
- `hermes_cli/config_defaults.py` 的默认值同样是 `threshold 0.50 / target_ratio 0.20 / protect_last_n 20 / protect_first_n 3 / tail_mode lean`。
- 小窗口有一个 raise-only 的阈值下限（约 0.75），避免窗口很小时过早触发；它是“只抬高、不降低用户显式设置”。
- `should_compress()` 在 `context_compressor.py:3002`，`compress()` 在 `:5447`。

**压缩后的会话旋转**：

压缩可以沿 `parent_session_id` 旋转出一个 child session。这样旧 session 的 transcript 不动，新 session 从摘要 + 保留尾部的上下文继续。

- `compression_locks` 表保证同一 session 同时只有一个压缩者；
- 压缩失败有 cooldown，避免每个 API call 都重复失败；
- 压缩成功会 invalidate system prompt 并重建；
- 若压缩未真正调用 provider，API call 预算需要 refund。

### 2.4 Preflight gate：每次 API 调用前的闸门

`agent/turn_preflight.py:57` 的 `run_preflight_compression()` 会先判断：

```text
compression_enabled?
消息数 > 1?
本轮压缩尝试未超上限?
没有 review fork 的首次请求 pending?
没有 failure cooldown?
should_compress(pressure)?
```

满足后才尝试压缩。流程是：

1. 对受管的本地 llama.cpp 先尝试扩大窗口（last resort）；
2. 否则压缩消息；
3. 压缩后重新测量，`continue` 回主循环；
4. 没真正到达 provider 的压缩要 refund API call；
5. provider 已经证明 overflow 时，不能无限重试；必要时 fail closed。

### 2.5 设计取舍

- **稳定前缀优先**：牺牲“每轮塞入最新环境”的即时性，换取 cache 命中和可解释性。
- **压缩是有损的**：保留头尾、总结中间、修复 orphan tool pair；不能承诺完整恢复每一句原文。
- **session 旋转而不是原地删历史**：增加父子会话和投影复杂度，但保留可审计的原始 transcript。

### 2.6 常见误解

| 误解 | 事实 |
| --- | --- |
| `content` 就是发给模型的文本 | 还有 `api_content` 和本次 wire copy |
| 压缩就是删掉旧消息 | 它生成摘要、保护头尾、修复工具配对，可能旋转 session |
| 默认阈值固定 75% | 内置 compressor 默认 50%；小窗口才可能被抬到约 75% |
| memory/skill 是当前上下文 | 它们影响 prompt 的 volatile 层；当前请求看到的是已组装 wire copy |
| system prompt 可以每轮重算 | 只在会话建立或压缩后重建，否则破坏 prefix cache |

---

## 3. 工具：从注册到执行，每一层都要有所有权

### 3.1 问题

工具系统要同时解决：

- 工具太多，prompt/schema 成本爆炸；
- 哪些工具在当前 session/platform 可用；
- 模型生成的 tool call 是否合法、是否有权限；
- 工具副作用与 transcript 的顺序；
- 并发执行时结果如何保持原顺序；
- 审批、guardrail、取消、持久化失败如何收尾。

### 3.2 心智模型：工具面是“装配出来的”

```text
工具定义/注册
  → toolsets.resolve_toolset()
  → model_tools.get_tool_definitions()
  → schema cache / tool search / connectors
  → 模型选择 tool call
  → run_tool_round: validate/cap/dedupe
  → 先持久化 assistant(tool_calls)
  → 执行（并发或串行）
  → 结果配对、预算、checkpoint
  → 持久化为 role=tool
  → 回到下一轮 API
```

“工具存在”不等于“本轮可用”；“本轮可用”也不等于“这次调用被允许”。这三层必须区分。

### 3.3 源码主线

**工具集**：

- `toolsets.py:11`：`_HERMES_CORE_TOOLS`。
- `toolsets.py:74`：`TOOLSETS`。
- `toolsets.py:366`：`resolve_toolset()`，递归处理 `includes`，对 cycle/diamond 安全，并带 registry generation 缓存。
- `"all"` / `"*"` 会跳过 session-platform gated 的 toolset，不会无条件把所有平台工具暴露给所有会话。

**工具定义**：

- `model_tools.py:215`：`get_tool_definitions()`。
- `model_tools.py:500`：`_compute_tool_definitions()`。
- `model_tools.py:873`：`handle_function_call()`。
- schema cache 最多保留 8 个 warm 组合；工具搜索桥、connectors、middleware、hooks、approvals、guardrails、`transform_tool_result` 都在这一层汇合。

**工具轮次**（`agent/turn_tool_round.py:49`）：

1. validate、cap、dedupe；
2. **在任何副作用之前持久化 tool-call turn**；
3. 执行工具；
4. 处理 guardrail / persistence failure；
5. 工具结果后再次压缩。

关键不变量：

- canonical DB append 失败 → 结束 turn，标记 `session_persistence_failed`；
- tool result 无法 canonical persist → 不把内存结果送回模型；
- 混合 batch 中 invalid tool call 也生成匹配 tool result，只是不 dispatch；
- guardrail halt 产生受控 halt response；
- 只有 `execute_code` 单独成批时 refund iteration budget；
- 工具结果后还要做 post-tool compression。

**执行器**（`agent/tool_executor.py`）：

- `_MAX_TOOL_WORKERS = 8`（`:134`）。
- `_DEFAULT_CONCURRENT_TOOL_TIMEOUT_S = 420.0`。
- `_START_ORDER_GATE_TIMEOUT_S = 120.0`。
- `_AUTHORIZATION_GATE_LOCK_TIMEOUT_S = 360.0`。
- `execute_tool_calls_concurrent()`（`:1585`）、`execute_tool_calls_sequential()`（`:1865`）、`execute_tool_calls_segmented()`（`:1935`）。
- 并发结果按原始 tool call 顺序回填，不能按完成时间重排。
- interrupt 后为未执行调用补 skipped result。
- file mutation 工具做 checkpoint。

### 3.4 设计取舍

- **persist-before-execute**：多一次 DB 写，换来崩溃后可审计、可恢复的副作用边界。
- **并发上限和顺序回填**：牺牲一点调度自由度，保护 transcript 和结果协议。
- **工具面延迟发现**：模型先看到核心工具和搜索入口，减少 schema/token 成本，但多一步发现。

### 3.5 常见误解

| 误解 | 事实 |
| --- | --- |
| 工具调用先执行，再补日志 | 必须先持久化 tool-call turn，再执行 |
| 工具失败可以不写结果 | call/result 必须配对；invalid 调用也要有匹配结果 |
| 并发完成顺序就是结果顺序 | 结果按原始调用顺序回填 |
| 工具越多模型越强 | 工具文本 + JSON schema 是双重上下文成本，还会扩大误选/攻击面 |
| guardrail 只是提示模型 | 它可以产生受控 halt，结束本轮 |

---

## 4. 模型接入：provider 是合同，不是散落的 if/else

### 4.1 问题

不同 provider 在认证、API 形状、streaming、tool message、prompt cache、token 计数、错误语义和 fallback 上都不一样。如果把这些差异写进 Agent loop，主循环会变成不可维护的分支树。

### 4.2 心智模型

```text
ProviderProfile（声明式元数据）
  → 认证/凭据池
  → API mode adapter（chat/responses/messages/converse/gemini）
  → request builder
  → streaming accumulator / error classifier
  → retry / rotate credential / fallback
  → normalized response
```

核心原则：**provider 语义归 provider 层，循环只消费统一合同。**

### 4.3 源码主线

- `providers/base.py:42`：`ProviderProfile`。
  - 声明 `name/api_mode/aliases/env_vars/base_url/models_url/auth_type/streaming/vision/tool-message/prompt-cache-key/model aliases/default headers/temperature/token quirks/aux model/model capabilities`。
  - 可选覆盖 `prepare_messages/build_extra_body/build_api_kwargs_extras/create_client`。
  - `auth_type` 支持 `api_key`、`oauth_device_code`、`oauth_external`、`copilot`、`aws_sdk`、`external_process`。
- `providers/__init__.py`：发现顺序包括 bundled plugins、`$HERMES_HOME/plugins/model-providers/`、pip entry points、旧式 `providers/*.py`；lazy discovery；用户插件可覆盖 bundled；多 profile home layer 必须显式绑定。
- `agent/credential_pool.py`：
  - `STATUS_OK`、`STATUS_EXHAUSTED`、`STATUS_DEAD`；
  - terminal OAuth 失败进入 DEAD，不是普通 exhausted；
  - 策略 `fill_first / round_robin / random / least_used`；
  - TTL：401 约 5 分钟、429/default 约 1 小时。
- `agent/chat_completion_helpers.py`：统一处理 `chat_completions`、`codex_responses`、`anthropic_messages`、`bedrock_converse`、native Gemini，以及 streaming accumulator、SSE error、stream fallback、watchdog。

### 4.4 Retry 与 fallback 的顺序

- `agent/turn_api_error.py:52`：`handle_api_error()`。
- `agent/turn_retry_state.py`：`TurnRetryState`。
- `agent/turn_response_intake.py:120`：`normalize_model_response()`。
- `agent/turn_final_response.py:56`：`finish_text_response()`。

错误先分类，再决定：

1. 是否 retry；
2. 是否 rotate credential；
3. 是否压缩/overflow recovery；
4. 是否 fallback model/provider；
5. 是否直接终态失败。

fallback 必须设置 `restart_with_rebuilt_messages`，回到 preflight 重算上下文，不能拿旧 wire messages 直接换 provider 继续。否则窗口、prompt、工具 schema、压缩状态和 provider 专用字段都可能不一致。

### 4.5 设计取舍

- **声明式 provider**：新增 provider 不需要改核心循环，但 profile 字段和 adapter 合同更复杂。
- **凭据池轮换**：提高可用性，代价是必须区分临时 429 与永久 OAuth 失败，并防止同一 entry 反复刷新。
- **fallback 回 preflight**：多一次上下文构建，换取正确的窗口/缓存/消息形状。

### 4.6 常见误解

| 误解 | 事实 |
| --- | --- |
| 换 provider 就是换 base_url | 还要换 API mode、消息形状、认证、工具/缓存语义 |
| 429 和 OAuth 失效一样 | 前者通常可恢复/冷却，后者可能是 DEAD |
| fallback 后可以沿用旧 messages | 必须重建 wire messages 并重跑 preflight |
| provider profile 是用户 prompt | 它是机器合同，不应把密钥或私有推理写进 public projection |

---

## 5. SessionDB：不只是聊天记录，而是跨进程会话权威

### 5.1 问题

如果 `state.db` 只保存聊天文本，那么下面这些问题都没有答案：

- 两个进程同时收到同一 session 的输入，谁先执行？
- 进程崩溃后，某个请求是“还没开始”还是“已经开始但没写完”？
- cron/child/kanban worker 执行到哪一步？
- 哪个进程正在压缩这个 session？
- 旧 backend 的心跳是否还在，能否安全清扫它的 orphan session？
- 新 owner 会不会复用已经退休的 prompt-cache affinity？

Hermes 的 SessionDB 同时承担 transcript、admission、lease、worker receipt、压缩锁和 generation fence。

### 5.2 心智模型：五类表，五种事实

```text
transcript 事实：sessions / messages / system_prompts / usage
准入事实：session_admissions
执行事实：worker_executions / worker_receipts
所有权事实：session_turn_leases / compression_locks / gateway_heartbeats
身份与代际事实：runtime_epoch / conversation_generations / async_delegations
```

### 5.3 源码主线

- `hermes_state_common.py:289`：`SCHEMA_VERSION = 32`。
- `:312`：`FTS_STORAGE_VERSION = 3`。
- `:452+`：`SCHEMA_SQL`。
- `hermes_state.py` 模块文档说明：SQLite、WAL（并发 reader + 单 writer）、压缩通过 `parent_session_id` 链切 session、source tag 例如 `cli` / `telegram`。

关键表：

| 表 | 回答什么问题 |
| --- | --- |
| `sessions` | 这是哪段会话、模型/配置、system prompt、父子关系、用量、压缩状态、cwd/git |
| `messages` | 已发生的消息、tool call/result、`api_content`、显示元数据、UID、active/compacted |
| `system_prompts` | prompt 字节按 hash 去重，供 session 复用 |
| `session_admissions` | 输入是否被接纳、排队顺序、queue/steer/redirect、started/unknown/terminal |
| `session_model_usage` | 按模型/计费维度累计 API call 与 token |
| `worker_executions` | cron/child/compute/kanban 执行身份与状态 |
| `worker_receipts` | 每次 worker 输出的序号、digest、结果 |
| `compression_locks` | 同一 session 当前压缩者与过期时间 |
| `session_turn_leases` | 同一 conversation 当前 turn 持有者与过期时间 |
| `gateway_heartbeats` | 后端进程是否仍活着，供 orphan 清扫判断 |
| `conversation_generations` | 单调 generation，防止 prompt-cache affinity 的 ABA 复用 |
| `async_delegations` | 后台委派的状态、结果、投递与 owner fence |

`session_admissions` 的关键约束：

```text
intent ∈ queue | steer | redirect
status ∈ queued | started | unknown | terminal
UNIQUE(principal_id, target_session_id, request_id)
```

`UNIQUE` 让同一 principal、同一 session、同一 request id 只能有一条 admission；`unknown` 则给“提交/启动边界不确定”留下合法状态，要求 reconcile 而不是猜。

`SessionAuthority` 在 `gateway/session_authority.py:121`，`submit()` 在 `:636`，`_submit()` 在 `:656`。后台完成通知通过 `admit_internal_event` 进入同一 durable FIFO，不绕开准入。

### 5.4 为什么这些表不能合并

它们的变化频率、锁粒度和恢复语义不同：

- transcript 是追加/压缩，强调历史可回放；
- admission 是 FIFO + 去重，强调顺序和幂等；
- lease 是短 TTL 所有权，强调失效；
- worker receipt 是执行序号，强调 resume；
- generation 是永不复用计数器，不能被 prune。

合并会让“清理旧消息”顺手删掉所有权事实，或让“UI 看似空闲”覆盖 canonical 状态。

### 5.5 设计取舍

- **SQLite + WAL**：部署简单、单机可靠，代价是跨机器/高并发需要额外架构。
- **多表 + 事务**：边界清晰、可恢复，代价是 schema/迁移和跨表不变量更复杂。
- **unknown 状态**：允许系统承认不确定性，避免重复或丢失，代价是必须有 reconcile 逻辑。

### 5.6 常见误解

| 误解 | 事实 |
| --- | --- |
| `state.db` 只是聊天记录 | 它还是 admission/lease/receipt/compression/generation 的权威 |
| 事务提交失败就当没发生 | 外部副作用可能已经发生，需要 readback/幂等 |
| `unknown` 可以随便归入 queued | 会重复执行；归 terminal 会丢工作 |
| 压缩只是 DB 更新 | 它还要锁、session 旋转、event/transcript 一致性和 prompt 重建 |
| 多 profile 共用一个进程没关系 | 必须显式绑定 profile/home scope，否则会串状态 |

---

## 6. 扩展：plugin、skill、MCP、subagent、cron、kanban 各扩展哪一层

### 6.1 一张表先分清

| 扩展面 | 扩展什么 | 不扩展什么 | 主要源码 |
| --- | --- | --- | --- |
| Plugin | 进程内能力注册：provider/channel/tool/hook/context engine 等 | 不是进程隔离沙箱 | `plugins/plugin_loader.py` |
| Skill | 方法、流程、模板、脚本等可按需加载的知识包 | 不是工具执行权限 | `skills/`、`optional-skills/` |
| MCP | 外部工具/资源/提示协议 | 不是绕过 policy/approval 的后门 | `tools/mcp_*`、`optional-mcps/` |
| Subagent / delegation | 同一进程内的受控子任务执行 | 不是跨重启 durable 工作队列 | `tools/delegate_tool*`、`agent/delegation_*`、`agent/subagent_lifecycle.py` |
| Cron | 持久化定时任务和 gateway ticker | 不是一次性聊天 turn | `cron/scheduler.py` 及 `scheduler_*` |
| Kanban | durable 多 Agent 任务队列/看板 | 不是只读 UI projection | `plugins/kanban/`、相关工具 |

### 6.2 Plugin

`plugins/plugin_loader.py` 的加载逻辑有几个工程细节：

- 按目录加载插件，使用合成 package，让相对 import 工作；
- 支持 `register(ctx)`，也支持 ABC subclass fallback；
- 检测跨线程加载死锁；
- 有 bounded load wait，避免一个插件把整个 agent build 卡死；
- 用户插件可覆盖 bundled 实现，但覆盖顺序必须明确。

内建插件包括 browser、computer_use、context_engine、cron_providers、delegation、image_gen、kanban、memory、model-providers、platforms、web、video_gen 等。插件是**进程内信任**：它能注册能力，也意味着能执行任意 Python；不要把“插件系统”误当成安全沙箱。

### 6.3 Skill

- `skills/` 是内置技能；`optional-skills/` 是按需安装。
- skills index 进入 system prompt 的 volatile tier，所以技能变化不应破坏 stable 前缀。
- `SOUL.md` 是 persona，不等于技能。
- Skill 通常通过 `skill_view` 等工具读取；它扩展“怎么做”，不自动授予“能做什么”。

### 6.4 MCP

- MCP 连接、工具发现和调用在 `tools/mcp_*`。
- `optional-mcps/` 提供按需配置。
- MCP 工具仍要经过 tool policy、approval、schema 校验和结果预算。
- 连接失败时，目录可能保留但执行 unavailable；恢复要按退避和显式 reload。

### 6.5 Subagent / delegation

- 相关实现分布在 `tools/delegate_tool*`、`agent/delegation_*`、`agent/subagent_lifecycle.py`。
- 子 Agent 有独立 session/生命周期，但共享父级进程和一套受控资源。
- **background delegation 是 process-local**：进程重启后不能假设还能继续。
- 需要跨重启的持久工作，应使用 cron 或 `terminal(background=True, notify_on_complete=True)` 这类有 durable 语义的路径。
- 父 turn 结束不必然结束 child；要显式处理 announce、cascade stop 和 orphan。

### 6.6 Cron

- `cron/scheduler.py` 是 facade，具体拆在 `scheduler_*`。
- job 持久化在 SQLite；gateway 内有 dispatcher/ticker。
- inactivity watchdog 默认约 600 秒。
- 支持 catch-up 和 per-home tick lock；headless tick 不能随便 spawn。
- cron 的关键不是“定时器”，而是 claim、heartbeat、dead-owner reclaim 和幂等 fire。

### 6.7 Kanban

Kanban 是另一种 durable 多 Agent 队列：卡片/任务状态必须翻译成 canonical transition，不能把 UI 拖动直接当事实。它适合长任务协作，不适合当作“subagent 的另一个名字”。

### 6.8 设计取舍

- **进程内插件**：集成深、延迟低，代价是信任边界弱。
- **Skill 外置**：上下文按需加载，代价是发现和版本管理。
- **Subagent process-local**：简单，代价是不能天然跨重启。
- **Cron/Kanban durable**：可靠性高，代价是 claim、receipt、恢复和数据库 schema 复杂。

### 6.9 常见误解

| 误解 | 事实 |
| --- | --- |
| 插件等于沙箱 | 插件是进程内代码执行 |
| Skill 是工具权限 | Skill 是知识/流程，权限仍由工具 policy 决定 |
| MCP 连上就可直接执行 | 仍要过统一工具链和审批 |
| Subagent 一定能跨重启继续 | background delegation 是 process-local |
| 定时任务就是 `sleep` 后调用 | 还有持久 job、claim、heartbeat、catch-up 和 dead-owner reclaim |

---

## 7. 界面：TypeScript 只负责屏幕，Python 负责语义

### 7.1 三种界面共用一套后端

```text
经典 CLI
  └─ GatewayAgent ── prompt.submit ── Gateway 进程（真实 AIAgent）

TUI
  └─ Node/Ink ── stdio JSON-RPC ── tui_gateway（Python）── AIAgent

Desktop
  └─ WebSocket JSON-RPC ── 同一 tui_gateway / Gateway 后端

Dashboard
  └─ PTY 嵌入真 TUI，不另写一套 Agent
```

`tui_gateway/AGENTS.md` 写得很明确：

```text
hermes --tui
  └─ Node (Ink) ──stdio JSON-RPC── Python (tui_gateway)
                          └─ AIAgent + tools + sessions
```

### 7.2 源码主线

- `tui_gateway/agent_factory.py:637`：`from run_agent import AIAgent`。
- `:655`：构造 `AIAgent(...)`。
- TUI 的 RPC 方法按主题拆在 `methods_<topic>.py`，例如 config、complete、browser、bot relay 等。
- wire contract 在 Python 定义并生成 TypeScript，避免前后端各写一套 schema。
- server→client request 用于 approval、clarify、sudo、secret、vault、connection 等；客户端可以拒绝或超时，Python 端必须 fail closed。
- Desktop 通过同一 WebSocket 连接；Dashboard 通过 PTY 嵌入 TUI。

### 7.3 关键边界

- TypeScript 不拥有 session、tool、model、slash logic；它只是渲染和收集输入。
- Python 不拥有屏幕布局；它通过 event/RPC 表达状态。
- 新增 RPC 方法应新建或扩展 `methods_<topic>.py`，并同步协议生成/测试。
- 一个进程服务多 profile 时，每个 RPC 必须显式绑定 profile scope；否则会读到另一个 home 的 session/model。

### 7.4 设计取舍

- **stdio JSON-RPC**：简单、可测试、适合 Ink，代价是跨语言协议维护。
- **WebSocket Desktop**：可远程、可多客户端，代价是权限、重连和快照一致性。
- **Classic CLI 代理到 Gateway**：保证与平台一致，代价是多一次进程/协议跳转。

### 7.5 常见误解

| 误解 | 事实 |
| --- | --- |
| TUI 是另一套 Agent | 它只是前端，后端仍是 Python `AIAgent` |
| 前端可以直接改 transcript | transcript 归 SessionDB/writer，前端只能发命令 |
| RPC 方法只改 Python 就行 | 还要同步 wire contract、TypeScript client 和测试 |
| 多 profile 只影响显示 | 会影响 session/model/tool/home scope，必须显式绑定 |

---

## 8. 工程：可靠性来自顺序和不变量

### 8.1 六条最重要的不变量

1. **输入先持久化**：admission 是 durable FIFO，不是内存队列。
2. **执行先拿 lease**：失权后停止写 transcript，而不是“尽量多写一点”。
3. **工具先记账**：tool-call turn 在副作用前落盘。
4. **结束先收尾**：finalize、持久化、事件、lease/scope 清理顺序不能反。
5. **fallback 先重建上下文**：换 provider 必须重跑 preflight。
6. **压缩才改历史**：普通轮次不能重排 stable prefix。

### 8.2 依赖与检查

- `pyproject.toml`：直接依赖几乎全部 exact pin `==X.Y.Z`。
- `requires-python = ">=3.11,<3.15"`；实际主目标是 3.14，3.11 主要服务旧 updater 桥。
- `uv.lock` 参与 hash-verified PM 安装。
- `ruff.toml`：line length 88，target py311。
- `justfile`：`ruff check` 加各 JS/TS workspace 的 ESLint。
- `lefthook.yml`：pre-commit lint。
- `scripts/check`：blocking lint 总入口。
- 测试用 `scripts/run_tests.sh`，不要 bare pytest；测试时把 `HERMES_HOME` 指向临时目录，防止污染真实状态。

### 8.3 根 `AGENTS.md` 的几条硬规则

- prompt cache 神圣，不能随意改 stable prefix；
- narrow waist：核心工具门槛高，能力外置到 CLI+skill / service-gated tool / plugin / MCP；
- 一个进程服务多 profile 时必须显式绑定 profile scope；
- 依赖 exact pin；
- 写行为契约测试，不写 change-detector；
- 不用 argv substring 判断 process identity；
- 不硬编码 `~/.hermes`。

### 8.4 常见故障的“第一现场”

| 症状 | 先看 |
| --- | --- |
| turn 一直等 | lease 等待、admission、session lane |
| 工具执行了但 UI 没有结果 | tool result 持久化、event stream、transcript tail |
| fallback 后上下文溢出 | 是否重跑 preflight、窗口是否更新 |
| 压缩反复失败 | compression lock、cooldown、summary provider |
| 重启后 session 状态错 | admission unknown、lease、heartbeat、generation |
| prompt cache 命中下降 | system prompt 是否被非压缩路径重建、volatile 字段是否混入 stable |
| 多 profile 串数据 | profile/home scope 是否显式绑定 |

---

## 9. 自测与练习

### 自测

1. 经典 CLI 的 `AIAgent.run_conversation()` 到底在哪个进程执行？
2. `session_admissions` 为什么需要 `unknown`？
3. TTL 300 秒、刷新 60 秒，为什么还需要 liveness watchdog？
4. system prompt 的三层分别放什么？为什么必须先构建 prompt 再建 session row？
5. `content`、`api_content`、wire copy 的区别是什么？
6. 压缩的默认阈值和保护头尾是什么？为什么要 session 旋转和 `compression_locks`？
7. 工具为什么必须先持久化再执行？持久化失败时为什么不能把内存结果发给模型？
8. fallback 后为什么必须回到 preflight？
9. `toolsets.resolve_toolset()` 如何处理 include、循环和平台门禁？
10. provider 的发现顺序是什么？凭据池的三种状态和常见策略是什么？
11. plugin、skill、MCP、subagent、cron、kanban 各扩展哪一层？
12. TUI/Desktop/Classic CLI 的职责边界是什么？多 profile 时最容易出什么错？

### 参考答案

1. 在 Gateway 进程。经典 CLI 只运行 `GatewayAgent`，它提交 `prompt.submit`、回放事件、渲染结果；真正的 `TurnRunner` 和 `AIAgent` 在 Gateway。
2. 因为提交/启动边界可能崩溃或无法确认。把它当 queued 会重复执行，当 terminal 会丢工作；`unknown` 要求 readback/reconcile，承认不确定性。
3. TTL 只能处理“持有者停止续期”；watchdog 还能发现进程活着但事件循环/刷新协程卡死、DB/网络阻塞，从而更早中断，避免 stale owner 继续写。
4. `stable` 放身份、指导、coding brief 等稳定内容；`context` 放调用方 system message、项目上下文文件、workspace snapshot；`volatile` 放 skills index、memory、profile、时间戳、runtime hints。先构建 prompt 再建 row，才能把同一份 prompt/hash 绑定到 session；反过来可能写入 `NULL`，导致 cache miss 或缺少约束。
5. `content` 是显示/审计的 canonical 内容；`api_content` 是 provider 回放用的稳定 sidecar；wire copy 是本次请求经过压缩、预算、hook、provider 适配后的临时副本，不写回 transcript。
6. 内置 compressor 默认 `threshold=0.50`、`protect_first_n=3`、`protect_last_n=20`、`summary_target_ratio=0.20`、`tail_mode=lean`；小窗口可能把阈值抬到约 0.75。旋转用 `parent_session_id` 保留原始 transcript，`compression_locks` 保证同一 session 只有一个压缩者，失败 cooldown 防止反复撞同一故障。
7. 先持久化 tool-call turn，才能在副作用前留下 canonical 意图；崩溃后能定位未完成调用。若 canonical append 失败，transcript 就无法证明这次调用存在，内存结果不可信，不能送给模型，也不能假装副作用没发生。
8. 因为 fallback 后的窗口、API mode、消息形状、prompt/tool schema 和压缩状态都可能变；不重跑 preflight 会溢出、发错字段或破坏缓存。必须 `restart_with_rebuilt_messages`。
9. 递归解析 `includes`，对 cycle/diamond 安全，带 registry generation 缓存；`all/*` 会跳过 session-platform gated 的 toolset，不会把所有平台工具无条件暴露。
10. 发现顺序：bundled plugins → `$HERMES_HOME/plugins/model-providers/` → pip entry points → 旧式 `providers/*.py`；lazy discovery，用户插件可覆盖 bundled。凭据池状态 `ok/exhausted/dead`，策略 `fill_first/round_robin/random/least_used`。
11. Plugin 是进程内能力注册；Skill 是知识/流程包；MCP 是外部工具协议；Subagent 是进程内受控子任务；Cron 是 durable 定时任务；Kanban 是 durable 多 Agent 队列。它们不能互相替代。
12. TypeScript/CLI 负责屏幕、输入和事件渲染；Python 负责 session、tool、model、slash 和持久化。多 profile 共进程时，任何 RPC/tool/session 操作都必须显式绑定 profile/home scope，否则会串状态。

### 练习

1. 选一条真实或测试 turn，画出 admission → lease → context → API → tool → finalize 的事件顺序，并标出每个事实写进哪张表。
2. 人为在工具副作用后、tool result 落盘前杀进程；重启后写出你应该看到和不应该看到的事实。
3. 构造一个 stale 的 session prompt，观察压缩前后 stable/context/volatile 是否变化；解释哪些变化是允许的。
4. 给一个 mixed tool batch 加入 invalid call，验证它仍生成匹配 result，且不 dispatch。
5. 新增一个最小 RPC 方法，要求同步 wire contract、Python handler、TypeScript client 和测试。

### 练习参考答案与验收点

1. **验收点**：admission 在 `session_admissions`；lease 在 `session_turn_leases`；system prompt/hash 在 `sessions/system_prompts`；消息和 tool pair 在 `messages`；usage 在 `session_model_usage`；压缩锁在 `compression_locks`。图里要能区分 event 与 transcript。
2. **应看到**：已持久化的 user/assistant tool-call、未闭合 turn、lease/admission 状态、可能的工具副作用。**不应看到**：伪造的 tool result、成功终态、已投递 final response、自动重跑删除操作。恢复应先 readback/幂等判断，再决定重试或标记 unknown。
3. **验收点**：只有压缩才允许 system prompt 重建；stable 前缀应尽量字节一致，context/volatile 的变化要和压缩/权限/运行时事实对应。若普通轮次改了 stable，视为 cache 退化。
4. **验收点**：assistant 保留所有 call；每个 call 都有匹配 tool result；invalid call 的结果是错误/未 dispatch，而不是消失；DB 中 call/result UID 成对。
5. **验收点**：Python 方法是唯一语义实现，wire schema 生成 TypeScript；客户端能处理 server→client request/超时；有协议覆盖测试和多 profile scope 测试。

---

## 10. 一页代码地图

```text
run_agent.py                          AIAgent / mixin 组合
agent/turn_facade.py                  run_conversation facade
agent/turn_facade_lease.py            durable lease / refresher / watchdog
agent/conversation_loop.py            主循环与阶段
agent/turn_context.py                 build_turn_context / build_api_messages
agent/system_prompt.py                stable/context/volatile prompt
agent/context_compressor.py           压缩 / session rotation
agent/turn_preflight.py               API 前压缩闸门
agent/turn_api_request.py             build_api_request
agent/turn_api_call.py                perform_api_call
agent/turn_api_error.py               错误分类与恢复
agent/turn_tool_round.py              persist-before-execute
agent/tool_executor.py                并发/串行/分段执行
toolsets.py                           toolset 解析
model_tools.py                        工具定义/分发
providers/base.py                     ProviderProfile
providers/__init__.py                 provider 发现
agent/credential_pool.py              认证池
hermes_state_common.py                schema / SQL
gateway/run.py                        GatewayRunner
gateway/run_turn_runner.py            TurnRunner
gateway/session_authority.py          admission/authority
plugins/plugin_loader.py              plugin 加载
cron/scheduler.py                     durable cron facade
tui_gateway/                          TUI/Desktop Python 后端
```

读完后，应该能用一句话解释每个模块“拥有什么事实、失败后谁能接管”。如果只能背目录，说明还没真正读懂 Hermes。

---

*基于 Hermes Agent 0.22.5 发布源码编写 · 2026-10-31*
