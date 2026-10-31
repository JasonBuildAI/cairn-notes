---
title: "01 · 一次 Turn 的一生"
description: "追踪一次 Turn 从 admission、lease、上下文组装到工具执行与持久化的主线。"
---

> 基线：`hermes-agent-0.22.5`（发布版本 `v0.22.5`，发布日 `2026.9.24`）。归档不含 `.git`，不声称 commit/tag。
> 路径相对 `$HERMES_SRC`。
> 本篇只追一条线：**一条输入如何变成一个被接纳、被租约保护、被模型处理、被工具推进、被持久化并最终投递的 Turn。**
> 读完后你应能准确说出：输入从哪里进、谁有权执行、模型这次看到什么、工具结果怎样回流、系统在什么条件下停止。

## 0. 心智模型：Turn 是一次“有房卡的会话事务”

普通函数调用是 `call → return`。Hermes 的 Turn 更像一次事务：

```text
提交（admission）
  → 排队（durable FIFO）
  → 领房卡（turn lease）
  → 准备上下文（transcript + prompt + compression）
  → 循环（模型 / 工具 / 重试）
  → 收尾（tail + persist + usage）
  → 交付（event / stream / adapter）
```

这条事务链把六类事实分开保存：

| 事实 | 保存处 | 回答的问题 |
| --- | --- | --- |
| 这条输入有没有被接纳 | `session_admissions` | 重复提交会不会执行两次？崩溃后还在不在？ |
| 现在谁有权跑这个 session | `session_turn_leases` | 两个进程会不会同时写同一份 transcript？ |
| 对话已经发生过什么 | `messages` | 下一轮模型该看到什么？ |
| 这一轮正在发生什么 | event stream | UI 该显示什么？审批请求该发给谁？ |
| 上下文是否被压缩过 | `sessions.parent_session_id` + compressor 状态 | 当前是原 session 还是旋转出的 child？ |
| 这次 turn 花了多少 | usage/cost 字段与辅助账本 | 哪个模型、多少 token、是否缓存命中？ |

所以读 Turn 生命周期时，不要只盯 `agent.run_conversation()`。**真正让 Hermes 成为多端产品的，是 admission、lease、transcript、event 和 delivery 这五层。**

## 1. 入口：三扇门，一个执行核心

### 1.1 经典 CLI：代理到 Gateway

`hermes` 的经典 REPL 在第一次需要 Agent 时进入 `_init_agent()`：

```python
from hermes_cli.gateway_agent import GatewayAgent as AIAgent  # the gateway runs the turn
```

`GatewayAgent` 的模块 docstring 明确写着：

> CLI 进程不构建 agent、不跑工具、不写 `state.db`；turn 在 gateway 里运行。

调用链是：

```text
hermes_cli/main.py::cmd_chat
  → cli.py::HermesCLI
  → cli_chat_turn_mixin.py::chat()
  → self.agent.run_conversation(...)
  → GatewayAgent.run_conversation(...)
  → connection.call("prompt.submit", ...)
  → 回放 gateway event stream
  → 返回与 AIAgent.run_conversation 同形状的 dict
```

`GatewayAgent.run_conversation()` 的关键动作：

- 先拿到本 turn 的 session 与 admission；
- 提交 `prompt.submit`，附带用户消息、历史、作者、显示元数据、平台消息 id；
- 在调用线程上消费 `connection.events`，把 `message.delta`、工具进度、审批请求等翻译成 CLI 回调；
- 等到本 admission 的 `message.complete` 或中断结算；
- 如果发生重连/丢帧，尽量用事件序号和已见文本做补画（`_paint_owed`），而不是重复整段输出。

这条设计的价值是：**CLI 不需要理解 Agent 内部，只需要理解事件合同。** 代价是 CLI 必须正确处理断线、重连、乱序、重复帧和审批往返。

### 1.2 消息平台：adapter → SessionAuthority

消息平台的路径更接近“服务端”：

```text
gateway/platforms/<platform>.py
  → 解析来源 / 身份 / chat_key
  → 忙碌时进入 adapter 的 _pending_messages
  → SessionAuthority.submit(Principal, Submission)
  → session_admissions（durable FIFO）
  → drain 领取
  → TurnRunner.run_sync
  → AIAgent.run_conversation
  → 事件 / 流式输出
  → adapter 回复原渠道
```

Gateway 里有**两道**忙碌消息守卫：

1. adapter 的 `_pending_messages`：session 正在跑时先排队；
2. runner 的 `run_busy.py`：在消息进入 `running_agent.interrupt()` 之前，拦截 `/stop`、`/new`、`/queue`、`/status`、`/approve`、`/deny`。

新命令如果必须在 Agent 阻塞时到达（尤其是审批），必须同时绕过这两道守卫并内联分发，不能走 `_process_message_background()`，否则会和 session 生命周期竞态。

### 1.3 TUI / Desktop：共享 Python 后端

`hermes --tui` 的进程模型是：

```text
Node (Ink)  ──stdio JSON-RPC──  Python (tui_gateway)
   │                                  └─ AIAgent + tools + sessions
   └─ 渲染 transcript / composer / prompts / activity
```

`tui_gateway/agent_factory.py` 直接构建 `AIAgent`；`tui_gateway/server.py` 是方法/事件目录的 facade，`methods_*.py` 是各主题的 RPC 实现。Desktop 通过 `apps/shared` 的 `JsonRpcGatewayClient` 走 WebSocket 连同一个后端。

TUI/Desktop 与经典 CLI 的差别是：

- 经典 CLI 的 `GatewayAgent` 是**代理**；
- TUI/Desktop 的 Python 后端是**真实宿主**，AIAgent 就在这个进程（或 compute-host 子进程）里；
- 两者都可以绑定 canonical session authority，但绑定的是不同传输层。

Dashboard 则通过 PTY 嵌入真正的 `hermes --tui`。它不重写 transcript/composer；任何加在 Ink 上的能力都会自动出现在 Dashboard。

## 2. Admission：输入先变成“持久工作项”

`gateway/session_authority.py:121` 的 `SessionAuthority` 拥有 live sessions 和 canonical durable FIFO。`submit()` 在 `:636`，`_submit()` 在 `:656`。

### 2.1 提交前先授权

```text
authorize(actor, request.ref, 'session:submit')
  → 检查 principal 是否有权向这个 session 提交
  → 在 mutation_lock 下再次 authorize
  → 规范化 payload
  → admit_session_input(...)
```

这里有两个容易忽略的点：

- **权限不是 payload 字段。** 客户端不能通过传入 `owner_id`、`local_operator_v1` 之类字段来提升权限；服务端根据 principal 和 session 绑定生成可信字段。
- **重复提交要幂等。** `admission_id`、`request_id`、`payload_digest` 和唯一约束共同保证：同一个请求重复到达不会执行两次。

### 2.2 payload 会被规范化

`_submit()` 会处理：

- `finite`：一次性查看器/有限轮次；
- `surface`：来源面；
- `display`：显示类型与元数据；
- `cli_turn`：CLI 特有参数；
- `attachments`：附件捕获与持久化；
- `text`：真正的用户文本；
- `voice_context`、`interrupted`、`voice_turn`、`title_preview`、`turn_author`、`api_text`、`model_override`、`clarify_batch` 等可选字段。

规范化之后才写 `payload_json`。这意味着**排队的是“服务端理解的输入”，不是原始 HTTP body。**

### 2.3 状态机

`session_admissions.status` 至少有四种：

| 状态 | 含义 | 恢复含义 |
| --- | --- | --- |
| `queued` | 已持久接纳，等待 drain 领取 | 重启后仍可领取 |
| `started` | 已被某个 owner 领取并开始执行 | 不能重复领取；若 owner 死亡可能转 `unknown` |
| `unknown` | owner 崩溃/失联，执行结果不确定 | 需要恢复扫描、人工确认或安全重试 |
| `terminal` | 已结算（成功/失败/取消） | 只读回执 |

`unknown` 是关键设计：**“不知道有没有执行”不能被当成“没执行”。** 对于有副作用的 turn，系统宁可把它标成未知，也不能盲目重跑。

### 2.4 为什么不能只用内存队列

因为输入可能在以下时刻跨进程：

```text
收到消息 → 写队列 → 进程崩溃
```

如果队列只在内存，消息就丢了。Hermes 把 admission 写进 SQLite，并让 drain 以 `seq` 顺序领取，才能在多进程、重启和后台通知之间保持一致。

### 2.5 后台事件也走同一扇门

后台进程完成通知、cron 触发、子 Agent 回报不是“直接插一条消息”。它们通过 `admit_internal_event` 获得 admission receipt，再进入同一 durable FIFO；拒绝接纳时，调用方必须把已领取的批次退回，而不是假装成功。

这条规则的价值是：**系统只有一个“新输入”入口，所有输入都受同样的排队、权限和崩溃恢复约束。**

## 3. TurnRunner：宿主把舞台搭好

Gateway 的 `_run_agent_inner()` 在 `gateway/run_turn.py:2293`。它负责：

- 从 display 配置解析本轮行为（streaming、tool progress、interim messages、cleanup）；
- 构建 `TurnContext` 和 `TurnRunner`；
- 绑定工具生命周期回调、审批通知、进度队列；
- 启动 progress sender、tool log、stream consumer、tracking、interrupt monitor、long-running notifier；
- 调用 `TurnRunner.run_sync`；
- 等待 worker 完成，处理 interrupt、queued follow-up、stream finalize 和 cleanup。

`TurnRunner` 在 `gateway/run_turn_runner.py:175`，其 `:998` 调用：

```python
result = agent.run_conversation(api_message, **kwargs)
```

注意这里的 `agent` 是 Gateway 进程里的真实 `AIAgent`，不是 CLI 的 `GatewayAgent`。所以“同一条输入”在不同宿主里会走不同的入口，但都会落到同一个 `AIAgent.run_conversation()`。

## 4. TurnFacade：先拿房卡，再开始工作

`AIAgent.run_conversation()` 的实现在 `agent/turn_facade.py:22`。它的顺序非常值得记住：

```text
1. cancel_background_review_for_live_turn(self)
2. admit_durable_turn_lease(...)
3. 若 admission 返回 early_result：带回未接纳的用户消息，直接返回
4. 进入 relay / accounting / portal scope
5. lease.start()
6. agent.conversation_loop.run_conversation(...)
7. finally：stop refresher、release lease、清理 scope
```

### 4.1 为什么先取消后台 review

后台 review（memory/skill 反思）可能复用同一个 `session_id` 以保持 prompt cache 对齐。如果它和前台 turn 并行，就会竞争同一份 transcript。`cancel_background_review_for_live_turn()` 会先给 review 一个有限的退出窗口；如果它不退出，前台优先。

### 4.2 durable lease 是什么

`agent/turn_facade_lease.py:34` 的 `DurableTurnLease`：

- `LEASE_TTL_SECONDS = 300.0`；
- `LEASE_WAIT_SECONDS = 1800.0`；
- 默认每 60 秒刷新一次；
- 持有者包含 pid、pid namespace token、turn id、platform；
- 持久化在 `session_turn_leases` 表；
- 丢失 lease 会中断 turn；
- 配置了 liveness watchdog 时，长时间无活动会 hard interrupt。

它不是“数据库全局锁”，而是**针对一个 session 的 turn 房卡**。不同 session 可以并行；同一个 session 同一时刻只允许一个 turn 持有。

### 4.3 admission 失败时为什么还要保存用户消息

如果 lease 等待超时、被中断或无法接纳，`carry_unadmitted_user_message()` 会把用户消息带回 early result。这样调用方不会“消息消失了”，下一轮还能继续。细节很小，但它体现了一个原则：**拒绝执行不等于丢弃输入。**

### 4.4 lease 等待期间发生了什么

`admit_durable_turn_lease()` 在 `:297`。如果另一个进程持有 lease，它会等待，直到：

- 拿到 lease；
- 超时（`LEASE_WAIT_SECONDS`）；
- 被用户中断；
- 发现 owner 已死并可回收。

等待不是忙等；它也允许把当前用户消息暂存，避免在排队期间丢输入。

## 5. build_turn_context：模型这次到底看到什么

`agent/turn_context.py:1036` 的 `build_turn_context()` 是一轮准备的唯一入口。它的 docstring 说明了一个非常关键的顺序：

> DB session row 必须在 system prompt 构建之后创建；否则会写入 `system_prompt=NULL`，造成 cache miss。

### 5.1 准备顺序

按源码主线，至少经过这些步骤：

1. **stdio guard**：防止 broken pipe 把整个进程打崩；
2. **surrogate 清洗**：避免非法 UTF-16 代理字符进入 provider；
3. **恢复 rotated compression session**：如果上一轮压缩旋转了 session，先把 canonical child 找回来；
4. **绑定 session context / write origin**：日志、memory 写入来源、review attended 标记；
5. **恢复 primary runtime**：如果上一轮 fallback 到了别的 provider，这轮要回到主 runtime；
6. **刷新 MCP tools**：turn 之间允许 MCP 工具集变化，但本轮开始后要稳定；
7. **绑定 turn identity**：task_id、turn_id、stream callback、persist 元数据；
8. **重置 per-turn 状态**：interim 去重、持久化失败标记、credential 刷新计数等，绝不能让上一轮泄漏到下一轮；
9. **复制历史**：`messages = list(conversation_history)`，不修改调用方列表；
10. **stage 当前用户消息**：处理 persist override、显示类型、平台消息 id；
11. **hydrate 历史**：恢复 token 估算、图片成本、session 相关状态；
12. **append 当前 user message**，记录 `current_turn_user_idx`；
13. **恢复或构建 system prompt**：每 session 一次，之后复用；
14. **创建 DB session row**：在 prompt 之后，避免 NULL prompt；
15. **turn-start compaction / idle compaction**：在第一次 API 调用前处理超窗；
16. **fire `pre_llm_call` hook、memory prefetch、skills index note**；
17. **持久化 turn start**。

### 5.2 system prompt 的三层

`agent/system_prompt.py:736` 的 `build_system_prompt_parts()` 把 prompt 分成三层：

| 层 | 放什么 | 为什么放这里 |
| --- | --- | --- |
| `stable` | identity、guidance、coding brief、workspace 快照、环境提示、平台提示 | 最不容易变，放在最前面，最大化 longest-prefix cache |
| `context` | 调用方 `system_message`、项目 context files（AGENTS.md 等）、剩余 workspace 指导 | 一个 session 内相对稳定，但可能依赖工作目录 |
| `volatile` | skills index、memory、USER.md、外部 memory provider、timestamp、runtime hints | 最可能变，放在最后；即使变化，也尽量只影响尾部 |

`build_system_prompt()` 在 `:802` 组装并缓存在 `agent._cached_system_prompt`。`invalidate_system_prompt()` 在 `:814`，只在压缩后调用。

### 5.3 为什么要冻结 workspace 快照

`_coding_parts()` 会做一次 git/workspace 探测。如果每次重建 prompt 都重新探测，仓库状态一变，prompt 字节就变，cache 前缀断裂。于是 Hermes 把 workspace block **按 session 冻结**，key 是探测时的 cwd；重建时只要 cwd 没变，就回放同一段字节。

这是一个很典型的工程取舍：**宁可显示稍微过时的 workspace 信息，也不要在 session 中途制造 cache miss。**

### 5.4 build_api_messages：wire copy 与 transcript 分离

`build_api_messages()` 在 `agent/turn_context.py:1243`。它不是简单地把 `messages` 原样发出去，而是构造一份 wire copy：

- 历史 user/assistant 行如果有 `api_content`，回放**当时实际发送的字节**；
- 当前用户 turn 复用 prologue 已 stamp 的版本；
- `api_content`、`display_*`、`_row_id` 等本地簿记字段从 wire copy 中移除；
- memory prefetch、`pre_llm_call` hook、`ephemeral_system_prompt` 只在 API 时注入，不写回 `messages`；
- system prompt 每 session 构建一次，之后逐字重放。

这解释了一个常见疑问：**为什么 transcript 里看到的消息和 provider 收到的消息不完全一样？** 因为 transcript 是人类可读的事实，wire copy 是 cache 稳定的事实的“发送视图”。两者由 `api_content` sidecar 连接。

### 5.5 常见误解

- **“system prompt 每轮都重建”**：不。它每 session 构建一次，只有压缩会失效重建。
- **“工具结果直接追加到历史就行”**：不。工具结果要经过预算、落盘、持久化和 provider 适配，才能进入下一轮 wire copy。
- **“memory 是 system prompt 的一部分，所以每轮都能变”**：memory 在 volatile 层，但只在 session 构建时读取；中途写入要等压缩或下一 session 才体现。

## 6. Preflight compression：每次 API 调用前的闸门

`agent/turn_preflight.py:57` 的 `run_preflight_compression()` 在每个 API 调用前运行。它拿到当前请求压力（tokens），然后判断：

```text
是否 eligible（compression_enabled、消息数 > 1、attempt 未超限）
  → 是否在 failure cooldown
  → 是否 review fork 首次请求 pending
  → compressor.should_compress(request_pressure_tokens)
```

如果命中：

1. 先尝试 grow managed local window（llama.cpp 这类本地模型）；
2. 否则调用 compressor 压缩，refund 掉这次未真正发生的 API call；
3. 压缩后重新进入循环，重新测量；
4. 如果压缩超时/阻塞/不可行，按 fail-closed 或 deferred 处理。

### 6.1 默认值不是“固定 75%”

`hermes_cli/config_defaults.py` 的 `compression` 段：

- `threshold: 0.50`；
- `target_ratio: 0.20`；
- `protect_last_n: 20`；
- `protect_first_n: 3`；
- `tail_mode: "lean"`。

但注释同时说明：**窗口小于 512K 的模型会把阈值抬到 0.75（raise-only floor）**，避免“窗口还剩一半就压缩”。所以实际触发点取决于模型窗口和 per-model override。

`ContextEngine` 基类还声明了 `0.75 / 3 / 6` 的默认值，这是给没有覆盖这些属性的插件引擎用的；内置 `ContextCompressor` 的实际构造参数来自 `CompressionSettings`，不要混用两组默认值。

### 6.2 compressor 做什么

`agent/context_compressor.py:2152` 的 `ContextCompressor`：

- 先 prune 旧 tool result（确定性、无需 LLM）；
- 保护 head（system + 前几条）；
- 保留 token-budget 的 tail（不是固定条数）；
- 对中间段用廉价的 auxiliary model 做总结；
- 后续压缩迭代更新已有摘要，而不是每次从零重来；
- 处理 orphan tool pair，保证 `assistant(tool_calls) → tool` 结构合法；
- 支持 micro-compaction、proactive prune、failure cooldown、anti-thrash；
- 压缩可以沿 `parent_session_id` 旋转出 child session。

`should_compress()` 在 `:3002`，`compress()` 在 `:5447`。

### 6.3 为什么压缩要加锁

压缩会改写历史、可能旋转 session，并影响 prompt cache。`compression_locks` 表保证同一 session 同时只有一个压缩者。压缩期间 admission 不会被 LLM 调用长时间阻塞：`LiveSession.claim_gate` 只在“准备替换 transcript”的窗口持有，而不是整个总结过程。

### 6.4 常见误解

- **“压缩就是把旧消息删掉”**：不。它保护头尾、总结中间、保留用户锚点，并可能旋转 session。
- **“超过阈值就一定压缩”**：不。还要看 cooldown、review fork、provider overflow、attempt 上限和可行性探测。
- **“压缩失败就继续发原请求”**：不一定。provider 已证明 overflow 时，preflight 会 fail-closed，避免把必然失败的请求再发一次。

## 7. 主循环：一轮迭代到底做什么

`agent/conversation_loop.py:1785` 的 `run_conversation()` 先调用 `build_turn_context()`，然后进入 `_run_conversation_turn()`。主循环在 `:1724`：

```python
while _prelude_action != "break" and (
    (s.api_call_count < agent.max_iterations and agent.iteration_budget.remaining > 0)
    or agent._budget_grace_call
):
```

每轮迭代的阶段：

```text
begin_iteration        # 计数、检查预算/中断
prepare_iteration      # 运行预算、tool schema、steer、上下文提示
assemble_api_request   # 生成本次 wire request
run_preflight_gate     # 压缩/本地窗口/overflow 闸门
announce_api_call      # 状态、usage、请求 id
_run_api_retry_loop    # 真正调用 provider，处理 retry
apply_retry_restarts   # fallback / restart 后重算
normalize_model_response
  ├─ tool_calls → run_tool_round
  └─ 纯文本     → finish_text_response
finalize_turn
```

阶段函数的返回值通常有三种动作：

- `continue`：本轮不结束，重新进入循环（例如压缩后重新测量）；
- `break`：结束循环，进入收尾；
- `return`：直接返回本 turn 的 result（例如早退/致命错误）。

### 7.1 停止条件不是一个

至少有以下几类：

1. 模型返回纯文本，且通过 stop gates；
2. `api_call_count >= max_iterations`；
3. `iteration_budget.remaining <= 0`；
4. 运行时间预算耗尽；
5. 用户中断；
6. 压缩阻塞/超时，按策略结束；
7. 工具守卫 halt；
8. 持久化失败；
9. 空响应/重复输出/长度截断等恢复路径仍无法产出；
10. provider/编码/连接错误达到终态。

### 7.2 `max_iterations` 与 `iteration_budget`

`run_agent.py:241` 的 `AIAgent.__init__` 默认 `max_iterations = sys.maxsize`，也就是“默认不靠迭代次数硬停”。实际产品里由宿主传入更小的值（例如 TUI 的 `_cfg_max_turns(cfg, 500)`、GatewayAgent 默认 90）。

`iteration_budget` 是另一个维度：它记录本轮还能调用多少次，`execute_code` 这类不真正消耗模型轮次的工具可以 refund。`_budget_grace_call` 允许在预算刚耗尽时再给一次“无工具总结”机会，避免用户只看到半截。

### 7.3 特殊分支

- `api_mode == "codex_app_server"`：整个 turn 可以交给 codex app-server 子进程，`conversation_loop` 只做外层协调。
- `prelude`：脚本化预置工具调用，在第一次模型调用前播放；用于 onboarding 等场景。
- `PreflightCompressionTimedOut`：在 `build_turn_context()` 内提前返回一个早结果，而不是进入主循环。

## 8. API 请求：wire copy 怎样变成一次真实调用

### 8.1 build_api_request

`agent/turn_api_request.py:93` 的 `build_api_request()` 负责：

- 重新应用 reasoning echo（某些 provider 需要把 reasoning 回传）；
- 重新做 provider prompt-cache decoration；
- 对不接受图片的模型去掉图片；
- 调 `agent._build_api_kwargs()` 组装基础参数；
- sanitize payload；
- codex preflight；
- OpenRouter cache bypass；
- Copilot 的 `x-initiator`；
- LLM request middleware；
- `pre_api_request` hook；
- debug dump。

这一层的关键是：**它不改变 transcript，只改变“这一次请求的投影”。**

### 8.2 perform_api_call

`agent/turn_api_call.py:72` 的 `perform_api_call()`：

- `_should_stream()` 优先选择 streaming，因为流式能让 liveness watchdog 看到进展；
- process provider 必须显式支持 streaming；
- `nous_rate_limit_guard()` 等守卫在此生效；
- 流式失败可以回退到非流式或别的 transport，但不能破坏已经交付的文本。

### 8.3 retry 不是盲目重试

`TurnRetryState` 每个 API attempt 新建，包含一次性 guard，防止同一个恢复动作反复触发：

- auth retry；
- thinking signature 修复；
- image shrink；
- multimodal 降级；
- rate limit 等待；
- auth failover；
- auto recovery；
- restart signal。

`agent/turn_api_error.py:52` 的 `handle_api_error()` 先做分类恢复，再处理 interrupt/shutdown、overflow、不可重试的 client error，最后才走 primary transport recovery → fallback → terminal。

### 8.4 fallback 为什么要回到 preflight

因为换 provider 往往意味着 context window、token 估算、图片支持、reasoning 格式都变了。直接“换个 client 继续发”会用错误的预算和错误的 wire 格式。

Hermes 的做法是 `restart_with_rebuilt_messages`：回到 preflight，重新计算上下文和请求。代价是可能多一次压缩/组装，但正确性优先。

### 8.5 response intake

`agent/turn_response_intake.py:120` 的 `normalize_model_response()`：

- 规范化 `finish_reason`；
- 强制 `content` 类型；
- 运行 response hooks；
- 处理 codex incomplete；
- 把 provider 的响应变成循环后续阶段能理解的结构。

## 9. 工具轮次：persist-before-execute

`agent/turn_tool_round.py:49` 的 `run_tool_round()` 模块头写得很清楚：

1. validate / cap / dedupe tool calls；
2. **persist tool-call turn BEFORE any side effect**；
3. execute tools；
4. guardrail / persistence failure handling；
5. compress after tool results。

### 9.1 为什么必须先持久化

假设模型要求执行 `rm -rf`，Hermes 在执行前崩溃。如果 tool-call block 只存在内存里，重启后的 resume 看不到这次调用，模型会以为“还没执行”，可能再次执行。持久化先行的不变量是：

> **如果工具调用可能产生副作用，transcript 必须已经记录了“模型要求执行它”。**

反过来，如果 canonical append 失败，Hermes 不会“先从进程内状态跑一把再说”，而是直接结束 turn，标记 `session_persistence_failed`。因为无法证明副作用是否发生，比不执行更危险。

### 9.2 混合 batch 的细节

- 一个 assistant message 可能有多个 tool call；
- 其中无效的工具名也必须生成匹配的 tool result，只是不 dispatch；
- 工具调用 id 要规范化，保证 provider 的 `assistant(tool_calls) → tool` 配对；
- `expand_local_tool_batches` 会把本地桥接的批量调用展开，每个子调用仍走同样的 scope、审批、状态和调度。

### 9.3 执行器

`agent/tool_executor.py`：

- `_MAX_TOOL_WORKERS = 8`（每批并发 worker 上限）；
- `_DEFAULT_CONCURRENT_TOOL_TIMEOUT_S = 420.0`；
- `_START_ORDER_GATE_TIMEOUT_S = 120.0`；
- `execute_tool_calls_concurrent()` `:1585`；
- `execute_tool_calls_sequential()` `:1865`；
- `execute_tool_calls_segmented()` `:1935`。

关键机制：

- 并发结果按原始 tool call 顺序回填，UI 不会因为完成顺序不同而错位；
- 有 per-batch deadline；
- start-order gate 保证“调用开始”的观察顺序；
- approval lock timeout 与人工审批等待上限对齐；
- heartbeat 防止慢工具被 inactivity timeout 误杀；
- 中断后为未执行调用补 skipped result，保证每个 call 都有结果；
- 文件修改工具会做 checkpoint；
- tool result commit 之后才发布 UI completion。

### 9.4 工具结果如何回流

工具返回后，执行器会：

1. 处理多模态结果；
2. 对超大文本做 spill/persist，返回摘要或路径；
3. 记录 persisted path；
4. 生成 `role: "tool"` 消息；
5. flush 到 SessionDB；
6. 如果持久化失败，不把内存结果送回模型；
7. 工具守卫 halt 时，生成受控 halt response 并结束；
8. 工具轮次结束后，再做一次 post-tool compression。

### 9.5 常见误解

- **“工具并发执行，结果就按完成顺序写”**：不。结果按调用顺序回填。
- **“工具报错就是 turn 失败”**：不一定。错误会变成 tool result 回到模型；只有持久化失败、守卫 halt、中断等才终止 turn。
- **“工具结果可以无限大”**：不。超过预算会落盘，只把摘要/路径送回模型。

## 10. finalize_turn：模型停下来不等于 turn 结束

`agent/turn_finalizer.py` 的模块头列出收尾职责：

> budget summary、trajectory save、persist、diagnostics、response transforms、result assembly、steer drain、memory/skill review。

### 10.1 预算耗尽时还要再试一次

`_resolve_budget_fallback()` 在 `:125` 左右。如果 `final_response is None` 且预算耗尽，Hermes 会调用 `_handle_max_iterations()` 做一次**无工具的总结请求**。这样用户至少能得到“我做到哪、为什么停”的说明，而不是空白。

如果之前有一个被 verification gate 扣下的候选答案，预算耗尽时会优先保留它，而不是再冒一次失败风险。

### 10.2 从流式文本恢复

`_recover_final_from_stream()` 在 `:225`：如果终态 `final_response` 为空，但流里已经交付过文本，就用流文本恢复，避免把用户已经看到的答案覆盖成空白。

### 10.3 关闭 transcript 尾部

`_close_transcript_tail()` 在 `:240` 左右：

- 中断时关闭未完成的 tool 序列；
- 如果交付了 `final_response` 但 transcript 没有对应 assistant row，补一条；
- 如果尾行是 tool-call-only 或流恢复的空行，把 `final_response` 填进去；
- 保证“交付的最终答案 ⇒ transcript 里有 assistant 行”。

### 10.4 持久化与后处理

`_persist_step()` 在 `:620` 左右：

```text
recover final from stream
  → apply output transform
  → close transcript tail
  → micro-compact (if enabled)
  → agent._persist_session(messages, conversation_history)
```

之后还会：

- 记录 turn exit 日志；
- 追加文件修改 footer；
- 解释异常退出；
- 应用输出 hooks；
- sanitize surrogate；
- 组装 result（`final_response`、`failed`、`interrupted`、usage、cost、failure_reason 等）；
- drain leftover steer；
- 同步外部 memory；
- 在交付后触发 background memory/skill review。

### 10.5 失败 turn 也要闭合

`_close_durable_failed_turn()` 在 `conversation_loop.py` 末尾：如果失败 turn 留下了开放的 `user` 或 `tool` 尾行，就补一条 Hermes 自己的 assistant 边界，避免下一轮把失败请求和新请求合并。上下文压力类失败除外，因为给已超窗的 session 再追加内容会形成增长循环。

### 10.6 常见误解

- **“模型返回 stop 就结束了”**：不。还要过 stop gates、收尾、持久化、usage、memory review。
- **“流式已经显示了，就不用写 transcript”**：不。流是 live 事实，transcript 是 durable 事实；两者都要。
- **“失败就不用收尾”**：不。失败 turn 更需要闭合尾部，否则下一轮历史会坏。

## 11. 交付：事件流怎样回到用户

### 11.1 Gateway

Gateway 的 `TurnRunner` 会创建 `GatewayStreamConsumer`，把 delta 和工具进度送到 adapter。最终 `finish(final_text)` 用**权威的 `final_response`** 收尾，而不是用流式累加器的最后一段。原因：

- 最终回答可能包含 verifier footer、completion explainer；
- 流式累加器可能漏掉后处理；
- 中断/失败的诊断文本不能覆盖用户已经看到的部分。

对于 `draft_stream_is_message=True` 的平台，流本身就是最终消息，必须满足前缀稳定、最终声明、interim 标记、编辑而非重发等合同。

### 11.2 TUI / Desktop

TUI 后端通过 JSON-RPC 发 `message.delta`、`message.complete`、工具事件和 server→client request。Desktop 通过 WebSocket 接收同一套事件。客户端断线重连时，`session.events.since` / `session.resume` 会回放未完成的问题和必要事件。

### 11.3 经典 CLI

`GatewayAgent._pump()` 持续读事件，直到本 admission 的 `message.complete`。如果丢帧，它用 `turn.seen`、`turn.shown`、`turn.spoken` 做补画；如果 Ctrl-C，它有 `INTERRUPT_SETTLE_SECONDS = 10.0` 的结算上限。

## 12. 失败矩阵

| 失败点 | 已经发生了什么 | 恢复策略 |
| --- | --- | --- |
| 提交前崩溃 | 什么都没发生 | 客户端重试；request_id 幂等 |
| admission 已写、未领取 | 输入已持久 | 重启后 drain 继续领取 |
| 已领取、turn 未开始 | admission=started | owner 死亡后转 unknown，按恢复策略处理 |
| turn 已开始、tool call 已持久、工具未执行 | transcript 有 tool-call block | resume 能看到请求，不会误以为没发生 |
| 工具已执行、结果未持久 | 副作用可能已发生 | 不把内存结果送回模型；标记持久化失败 |
| lease 丢失 | 另一个进程可能接管 | 当前 turn 中断，避免双写 |
| 压缩超时 | 历史未删 | 记录 cooldown，继续或 deferred，不丢消息 |
| provider 429/5xx | 本次调用失败 | retry → 同 provider 恢复 → fallback → terminal |
| provider overflow | 请求必然失败 | 回到 preflight 重新压缩/重算 |
| 审批拒绝 | 工具未执行 | 生成拒绝结果回到模型 |
| 工具守卫 halt | 工具可能部分执行 | 生成受控 halt response，结束 turn |
| CLI/Gateway 断线 | turn 可能仍在跑 | 重连后按 admission/event 回放；不要假设 turn 已停 |
| TUI 客户端断线 | 后端 turn 继续 | `session.resume` / `events.since` 回放 |

## 13. 用四个问题复述整条线

### 输入从哪进？

- 经典 CLI：`prompt.submit` → Gateway；
- 消息平台：adapter → `SessionAuthority.submit`；
- TUI/Desktop：JSON-RPC `prompt.submit` → `tui_gateway`（可绑定 authority）；
- 后台事件：`admit_internal_event` → 同一 durable FIFO。

### 模型这次看到什么？

- 当前 session 的 system prompt（stable/context/volatile 三层，构建一次）；
- 历史消息的 `api_content` 回放；
- 当前用户消息（可能的 prologue stamp）；
- 本轮工具 schema；
- API 时注入的 memory prefetch / hook / ephemeral context；
- 压缩后的摘要与保留头尾。

### 模型做了什么，工具结果怎样回流？

- 模型返回 `tool_calls`；
- 工具调用先持久化，再执行；
- 执行结果按原始顺序变成 `role: tool` 消息；
- 结果 flush 到 SessionDB；
- 下一轮 API 看到这些结果；
- 如果结果持久化失败，turn 结束，不把内存结果发给模型。

### 系统何时真正停止？

- 纯文本通过 stop gates；
- 预算/迭代/时间耗尽；
- 用户中断；
- 压缩阻塞/超时；
- 工具守卫 halt；
- 持久化失败；
- provider 终态错误；
- 空响应/重复输出等恢复路径仍失败。

## 14. 自测与练习

1. 画出经典 CLI 从按键到 `AIAgent.run_conversation()` 的完整调用链，标出哪一步发生在 CLI 进程、哪一步发生在 Gateway 进程。
2. 为什么 `session_admissions` 需要 `unknown` 状态？如果把它当成 `queued` 或 `terminal`，会出什么问题？
3. 如果 turn lease 的 TTL 是 300 秒、刷新间隔是 60 秒，为什么还需要 liveness watchdog？
4. 找到 `build_turn_context()` 中“先构建 system prompt、再创建 DB session row”的注释，解释如果不这样做会发生什么。
5. 选一条历史消息，解释 `content`、`api_content` 和 wire copy 的区别。
6. 手动构造一个 `assistant(tool_calls) → tool` 的 orphan 场景，说明 compressor 为什么必须修复它。
7. 如果 provider fallback 后不回到 preflight，可能会有哪些具体错误？
8. 为什么工具调用必须先持久化？请用一个“删除文件后进程崩溃”的例子说明。
9. 解释 `final_response` 已交付但 transcript 没有 assistant row 时，`_close_transcript_tail()` 为什么要补一行。
10. 假设 Gateway 进程崩溃时一个 turn 已经执行了工具，但结果还没写回。重启后系统应该看到什么？不应该看到什么？

### 参考答案

1. 经典 CLI 的链路是：`hermes_cli/main.py::cmd_chat` → `cli.py::HermesCLI` → `cli_chat_turn_mixin.py::chat()` → `GatewayAgent.run_conversation()` → `gateway_agent.py` 中 `connection.call("prompt.submit", ...)`。**输入解析、回调渲染和事件回放发生在 CLI 进程**；真正的 admission、`TurnRunner`、lease、`AIAgent.run_conversation()` 以及模型/工具执行发生在 Gateway 进程。CLI 侧并没有直接跑真实 Agent。
2. `queued` 表示已持久化排队、尚未开始；`started` 表示已被 worker 接手；`unknown` 表示提交/启动的边界状态不确定（例如进程在写入 started 与执行之间崩溃，无法仅凭本地观察断言到底跑没跑），必须 readback/reconcile；`terminal` 表示已有明确终态。把 `unknown` 当 queued 会重复执行，当 terminal 会丢工作或错误宣布完成。
3. TTL 300 秒、刷新 60 秒只保证“正常事件循环下租约会续期”；liveness watchdog 还要识别进程仍在但事件循环被卡住、刷新协程饿死、DB/网络分区或线程阻塞。没有 watchdog，系统可能在这 300 秒窗口内继续把旧 owner 当作活着；有了 watchdog 可以更早发现心跳缺失并中断/隔离。
4. 代码要求先构建 system prompt，再把 prompt 写入/关联到 session row。若先创建 session row，构造失败或顺序颠倒时会把 `system_prompt` 记成 NULL；下一轮无法复用同一份 prompt，既破坏 prompt cache 的字节稳定性，也可能让模型在缺少系统约束的情况下运行。
5. `content` 是 transcript 中面向显示/保存的消息内容；`api_content` 是 provider 回放用的稳定 sidecar，保留该消息在 API 协议中的形状；wire copy 是本次请求前根据压缩、预算、hook 和 provider 适配临时生成的副本，不写回 transcript。三者分别回答“人看到什么”“下次如何原样回放”“这一次实际发了什么”。
6. `assistant(tool_calls)` 后必须有匹配的 `tool` 结果。压缩切点若落在两者之间，会制造 orphan；provider 可能直接拒绝请求，模型也会误解为工具仍在执行。compressor 必须把被保留的 tool call 与结果成对处理，或为缺失结果生成明确的占位/修复结果，绝不能留下悬空 UID。
7. fallback 后模型窗口、`api_mode`、prompt/tool schema、压缩阈值和消息形状都可能不同。不重跑 preflight 会沿用旧窗口预算，导致新 provider 上下文溢出；也可能把旧 provider 专用字段/未压缩消息发过去，或让缓存前缀与 system prompt 不一致。正确做法是 `restart_with_rebuilt_messages`，回到 preflight 重新组装 wire copy。
8. 工具调用先持久化，是为了在副作用发生前留下“这次 turn 打算做什么”的 canonical 证据。以删除文件为例：若先删文件、进程随即崩溃，而 transcript 里没有 tool call，重启后系统既不知道删除发生过，也无法判断是否需要补偿；若已有持久化的调用，至少能定位未完成调用，并依靠幂等/readback 决定是否重试或标记 unknown，而不是把“没有结果”误当成“没有执行”。
9. 因为用户可能已经从流里看到了最终文本。若 transcript 没有对应 assistant row，下一轮/重启后的历史就缺少这段已交付事实，审计也会出现“UI 有、账本无”。`_close_transcript_tail()` 补一行，是把已交付答案纳入 canonical transcript，保证“交付过的文本必有账本记录”。
10. 重启后应看到：已持久化的 user/assistant tool-call 记录、admission 与 lease 的现状，以及一个**没有 canonical tool result** 的未闭合 turn。系统应把它识别为 interrupted/unknown，先 reconcile，不能伪造成功结果。不应看到：凭空生成的 tool result、已交付最终答案、已完成的 terminal receipt，或自动重跑已执行的副作用。外部文件是否真的删除，只能通过 readback/幂等记录判断。

> **一句话总结：一次 Turn 的可靠性，不来自模型多聪明，而来自“输入先持久、执行先拿租约、工具先记账、结束先收尾”这四道顺序。**
