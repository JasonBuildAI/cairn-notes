---
title: "01 · 一次 Run 的一生"
description: "追踪一次 Run 从 HTTP 接单、状态迁移、Agent 装配到交付与终态的完整主线。"
---

> 基线：DeerFlow `v2.1.0`（`345f08be`）。路径相对 `backend/`，除非另注。
> 本篇只追一条线：**一次 HTTP Run 如何从请求变成可恢复、可观察、可交付的执行。**
> 读完后你应能准确说出：谁创建 Run、谁批准它开始、谁组装 Agent、事件去了哪里、失败后哪一层负责收尾。

## 1. 先建立一个心智模型：Run 是“工单”，不是“函数调用”

普通函数调用是 `call → return`。DeerFlow 的 Run 更像一张工单：

```text
接单（Gateway） → 登记（RunStore: pending） → 开工（pending → running）
     → 生产（LangGraph Agent + tools） → 记录过程（journal/event store）
     → 验收交付（delivery receipt） → 归档（success/error/interrupted）
```

这条工单链把四类事实分开保存：

| 事实 | 保存处 | 回答的问题 |
| --- | --- | --- |
| 这次执行是否还存在、归谁负责 | `RunRecord` + `RunStore` | 有没有重复接单？worker 还活着吗？ |
| 对话图执行到哪一步 | LangGraph checkpoint | 下次能否从同一线程续跑？ |
| 运行过程发生了什么 | run journal + event store | 前端该看到什么？审计时能回放什么？ |
| 最终交付了什么 | delivery receipt / outputs | 结果真的产出了吗，还是只是“模型说完了”？ |

所以读 Run 生命周期时，不要只盯 `agent.astream()`。**真正让 DeerFlow 成为产品级 Harness 的，是接单、围栏、事件和交付这四层。**

## 2. 入口：三个 HTTP 形态，一个创建函数

`app/gateway/routers/thread_runs.py` 暴露三种常用入口：

| 路由 | 行为 | 适合 |
| --- | --- | --- |
| `POST /api/threads/{thread_id}/runs` | 创建后立即返回 `RunResponse` | 后台任务、轮询、程序集成 |
| `POST /api/threads/{thread_id}/runs/stream` | 创建并订阅 SSE | Web 前端实时看过程 |
| `POST /api/threads/{thread_id}/runs/wait` | 创建并等待终态，返回最终数据 | 同步调用、脚本、短任务 |

三者最终都调用同一个函数：

```text
thread_runs.py
  ├─ create_run       → services.start_run(...)
  ├─ stream_run       → services.start_run(...) + StreamBridge.sse_consumer(...)
  └─ wait_run         → services.start_run(...) + wait_for_run_completion(...)
```

这就是第一条重要设计：**`start_run()` 是所有 Run 创建路径的唯一收口点**。HTTP、定时任务、IM 渠道、内部通知都从这里进入。源码在 `app/gateway/services.py:1459` 明确写着 “single choke point every run-creation path flows through”。只要权限、模型白名单、输入清洗放在这里，就没有入口能绕开。

### 2.1 为什么不能把校验分散到 router？

因为 router 只代表“HTTP 这一种入口”。如果校验写在 router：

- 定时任务从 scheduler 直接调 service，会绕过；
- IM 渠道从 channel service 发起，会绕过；
- 内部通知 Run 可能使用另一条调用链，也会绕过。

把规则放在 `start_run()`，等价于把“接单规则”放在接单台，而不是放在某一扇门上。

## 3. `start_run()`：接单前先做七类判断

按源码顺序，`start_run()` 至少要过这些关：

```text
1. 取消能力检查
2. thread_id 合法性
3. metadata/config 中的秘密清洗检查
4. 模型白名单
5. 线程访问权与 owner 归属
6. 请求上下文白名单合并
7. checkpoint 初始化 + 持久化的原子准入
```

### 3.1 取消能力：创建权和取消权不是一回事

`require_cancel_permission_if(request, body.multitask_strategy != "reject")` 在创建前检查取消能力。

原因很直接：`interrupt` / `rollback` 这类策略会终止同线程上已存在的 Run。一个只有 `runs:create` 的令牌不应该因为“顺便带了一个策略参数”就获得终止别人的能力。只有显式 `reject` 不触达已有执行，才不需要取消权。

这里体现的是一条通用原则：**参数不是权限。客户端传递的策略名，必须由服务端映射成能力检查。**

### 3.2 模型白名单：模型名不是任意字符串

如果请求携带 `context.model_name`，`start_run()` 会调用 `app_config.get_model_config(model_name)`；不在配置白名单内直接 400。

这防止两类问题：

- 客户端传入未配置的 provider/model，造成不可控的出网、计费或密钥选择；
- 模型名被当作配置键，影响后面的 provider 解析。

真正的模型实例创建在 `models/factory.py:174` 的 `create_chat_model()`；白名单判断发生在接单阶段，二者职责不同：**先决定“允许用哪个”，再决定“怎么构造它”。**

### 3.3 线程归属：`thread_id` 可能来自 body

有些无状态路由把 `thread_id` 放在请求体，而不是路径参数，因此通用的路径 owner 检查覆盖不到。`start_run()` 在创建 Run 之前显式做 `thread_store.check_access(...)`。

这里有一个容易忽略的细节：内部渠道不是“超级用户”，而是代表连接所有者执行。源码注释明确说，内部 token 泄漏也不能因此获得跨用户线程访问权。**内部身份只改变“代表谁”，不取消“属于谁”的检查。**

### 3.4 上下文白名单：客户端不能伪造服务端事实

`body.config` 是自由结构，`body.context` 也可能携带 agent 参数。处理分两步：

```text
merge_run_context_overrides(...)  # 只转发 agent 相关键
strip_internal_context_keys(...)  # 清掉仅限内部使用的键
inject_authenticated_user_context(...) # 注入服务端认证用户
```

这一步的核心不是“字段拷贝”，而是**信任分层**：

- 客户端可以表达偏好：模型、thinking、部分运行参数；
- 服务端拥有身份、权限、项目归属、内部密钥、运行上下文；
- 客户端字段不能覆盖服务端事实。

后面还会把 project context 在 Run 开始时“钉住”为服务端快照，避免执行中途成员关系变化导致前后不一致。

## 4. 从接单到工单：`RunManager.create_or_reject()`

校验通过后，`start_run()` 调用：

```python
record = await run_mgr.create_or_reject(
    thread_id, assistant_id,
    on_disconnect=disconnect,
    metadata=run_metadata,
    kwargs={...},
    multitask_strategy=body.multitask_strategy,
    model_name=model_name,
    user_id=owner_user_id,
    idempotency_key=idempotency_key,
)
```

`RunRecord` 是这次执行的“控制面记录”，字段很多，但可以按用途分组：

| 分组 | 代表字段 | 用途 |
| --- | --- | --- |
| 身份 | `run_id`、`thread_id`、`assistant_id`、`user_id` | 这是谁的哪次执行 |
| 状态 | `status`、`error`、`stop_reason` | pending/running/success/error/interrupted |
| 控制 | `abort_event`、`abort_action`、`task` | 取消与本地任务句柄 |
| 所有权 | `owner_worker_id`、`lease_expires_at`、`ownership_lost` | 多 worker 下谁有权写终态 |
| 幂等 | `idempotency_key`、`idempotency_reused` | 重试是否会重复执行 |
| 成本 | `total_*_tokens`、`token_usage_by_model` | 观测和计费 |

状态定义在 `packages/harness/deerflow/runtime/runs/schemas.py`：

```text
pending → running → success
                  ├→ error
                  └→ interrupted
pending ───────────→ interrupted（开工前被取消）
```

`RunManager.create_or_reject()` 负责同线程并发策略：`reject` 拒绝已有活跃 Run，`interrupt` / `rollback` 走取消路径。真正的持久化准入由 store 的原子操作完成，确保两个 Gateway 不会同时为同一线程插入了相互冲突的工单。

### 4.1 幂等重放：返回旧工单，而不是再开一张

如果调用方带 `Idempotency-Key`，store 可能恢复已有的 `pending/running` Run。此时 `idempotency_reused=True`，`start_run()` 会比对 `input`、`assistant_id`、`conversation_references`：

- 一致：直接返回旧记录，不启动第二个 worker；
- 不一致：409，说明同一个 key 被用于不同请求。

这叫“幂等准入”，不是“模型结果缓存”。它保证的是**不会重复接单**；结果是否可重复，则取决于执行本身和外部工具。

## 5. 工单落地后：worker 如何开工

`start_run()` 在持久化准入后创建后台任务：

```python
worker = run_after_metadata(record)
record.task = asyncio.create_task(worker)
```

源码特意强调：**持久化准入与 task 挂接之间不能有 await**。否则可能出现“store 已经有 pending Run，但进程在挂 worker 前挂掉”的窗口。这个窗口并非靠祈祷避免，而是用“先完成准入，再同步挂接”缩小到最小。

任务开始后先做元数据准备，然后进入 `worker.py::run_agent()`（`worker.py:807`）。

### 5.1 第一道门：`try_start()` 把 pending 变 running

`run_agent()` 不会立刻组装 Agent，而是先：

```python
start_outcome = await run_manager.try_start(run_id)
```

`RunManager.try_start()`（`manager.py:893`）做三件事：

1. 检查本地 `abort_event`；
2. 如果配置了 RunStore，执行持久化的 `start_run(run_id)`；
3. 只有 store 接受、且记录仍是 pending，才把状态改为 `running`。

如果开工前已经被取消，返回 `cancelled`，worker 直接走取消收尾，**不会构造模型、不会加载工具、不会产生 LLM 费用**。

这就是“pending-to-running startup barrier”。它解决的是经典的启动竞态：

```text
请求 A：创建 Run
请求 B：立刻取消 Run
worker：开始执行
```

如果没有 barrier，worker 可能先花几秒初始化 Agent，然后才发现取消。屏障把“是否值得开工”的判断放在最前面。

### 5.2 第二道门：租约把“我以为我还活着”变成可验证事实

多 Gateway 部署时，RunStore 记录 `owner_worker_id` 和 `lease_expires_at`。worker 定期续租；如果租约过期，另一个 worker 可以接管孤儿 Run。

`RunRecord.ownership_lost` 是进程内的 fencing 信号。一旦置位，本 worker **不能再写 Run 终态或线程终态**，因为另一个 worker 可能已经接管。源码在终态收尾处反复检查 `not record.ownership_lost`，这不是防御性重复，而是防止“僵尸 worker 覆盖新 worker 的结果”。

一句总结：

> 状态机回答“工单现在是什么状态”，租约回答“谁有资格改变这个状态”。

## 6. 施工前准备：日志、快照、Checkpoint、Runtime Context

`try_start()` 成功后，`run_agent()` 开始准备执行环境。关键动作包括：

### 6.1 建 RunJournal

如果配置了 `event_store`，会创建 `RunJournal`，并挂到 LangChain callbacks 上。它负责：

- 捕获 LLM 请求/响应与 token usage；
- 捕获 chain/tool 生命周期；
- 生成可持久化的事件；
- 维护最终交付信息；
- 把进度快照回写到 `RunManager`。

这里要区分两个“历史”：

- **checkpoint**：给 LangGraph 恢复状态用；
- **journal/event store**：给用户看、给审计看、给 SSE 用。

前者是执行状态，后者是过程事实。二者可能包含相似消息，但职责不同。

### 6.2 捕获 Run 前工作区快照

`capture_workspace_snapshot(...)` 在 Agent 真正跑之前记录工作区基线。Run 结束后再扫描一次，就能算出：

- 这次 Run 新增/修改了哪些文件；
- 最终交付内容是否包含产物；
- workspace changes 如何展示给前端。

这体现了一个重要原则：**“模型说生成了文件”不等于“文件真的存在”。** DeerFlow 用运行前后快照把“声称”变成“可验证的差异”。

### 6.3 注入 Runtime Context

worker 构造 `runtime_ctx`，把 `thread_id`、`run_id`、服务端 app config、task store、extensions、conversation reader 等交给中间件和工具。然后：

```python
runtime = Runtime(context=runtime_ctx, store=store)
config["configurable"]["__pregel_runtime"] = runtime
```

为什么手动做？因为这里通过 `agent.astream(config=...)` 驱动图，而不是走 LangGraph CLI 的完整运行时装配。**worker 是宿主，必须替 LangGraph 补齐运行时上下文。**

同时 worker 会把 checkpoint 的 agent 身份、项目上下文、trace id 等写成服务端覆盖值。请求元数据不能伪造这些字段。

## 7. 组装 Agent：中间件不是装饰，而是执行策略层

worker 通过 `agent_factory` / `make_lead_agent` 进入组装链：

```text
agents/__init__.py::make_lead_agent(config)
  → agents/lead_agent/agent.py
    → get_available_tools(...)
    → apply_tool_authorization(...)
    → assemble_deferred_tools(...)
    → build_middlewares(...)
    → apply_prompt_template(...)
    → create_agent(model=..., tools=..., middleware=..., system_prompt=...)
```

最终创建 Agent 的位置在 `lead_agent/agent.py:1239` 左右；更通用的组装入口是 `agents/factory.py:66` 的 `create_deerflow_agent()`。

### 7.1 组装顺序为什么重要

从 `factory.py` 的注释可以看到，Lead Agent 的中间件链有明确顺序，最后固定放 `ClarificationMiddleware`。顺序影响：

- 谁先看到模型响应；
- 谁能在工具调用前拦截；
- 谁负责清理悬空 tool call；
- 谁在最后决定是否要求用户澄清；
- `after_model` 在 LangChain 中按反向顺序执行时，谁拥有最终话语权。

所以“加一个 middleware”不是简单 append。你必须同时回答：它在模型前还是模型后？它修改消息还是仅观察？它失败时是否阻断 Run？

### 7.2 工具不是先把所有定义塞给模型

Lead Agent 先拿到候选工具，再经过：

```text
get_available_tools
  → apply_tool_authorization
  → assemble_deferred_tools
  → build_mcp_routing_middleware
```

这表示工具面至少分三层：

1. **可用**：系统里存在这个工具；
2. **授权**：当前用户/上下文允许使用；
3. **已装配**：本轮真正暴露给模型，或通过 tool search 延迟发现。

工具多时，全部塞进 prompt 会浪费 token、增加误选。DeerFlow 用 deferred tools / tool search 把“工具目录”和“当前工具定义”分开。

### 7.3 模型入口只有一条

无论 Lead Agent、bootstrap agent 还是其他调用点，最终都走 `create_chat_model()`。它负责：

- 从模型配置解析 provider class；
- 合并模型 profile 与 per-agent overrides；
- 处理 thinking / reasoning effort；
- 只把 provider 认识的参数传给客户端；
- 处理 tracing attach 的重复 span 问题。

这样“换模型”改配置，不改 Agent 循环；“加 provider”实现适配类，不改业务链路。

## 8. 真正执行：`agent.astream(...)`

准备完成后，worker 调用：

```python
stream = agent.astream(
    input_payload,
    config=stream_config,
    stream_mode=lg_modes,
    subgraphs=stream_subgraphs,
)
```

然后逐帧消费：

```python
async for item in stream:
    if record.abort_event.is_set():
        break
    mode, chunk, namespace = _unpack_stream_item(...)
    await _publish_stream_item(...)
```

这里有几个关键点。

### 8.1 多种 stream mode 对应不同观察面

`values`、`messages`、`updates`、`custom` 等模式产生不同粒度的事件：

- `values`：状态快照，适合恢复/整页刷新；
- `messages`：token 级消息流，适合打字机效果；
- `updates`：节点更新，适合调试图执行；
- `custom`：业务自定义事件，子 Agent/工具可上报进度。

worker 不只是“转发”。它还做：

- 文件工具 chunk 聚合；
- 子 Agent 事件缓冲；
- message seq 盖章；
- LLM error fallback 识别；
- SSE 序列化和 `StreamBridge.publish`。

### 8.2 StreamBridge 可以是进程内，也可以跨进程

`StreamBridge` 有两种实现：

- `MemoryStreamBridge`：进程内队列，只能由 owner worker 提供 SSE；
- `RedisStreamBridge`：把事件写进 Redis Stream，多 Gateway 可以通过 `XREAD` 订阅，并保留 `Last-Event-ID` 重放语义。

因此路由里的 409 条件是“store-only Run + bridge 不支持跨进程”，不是无条件拒绝所有跨 worker 请求。默认 memory 模式是单进程部署约束；要多 worker 流式观看，就配置 Redis bridge。**状态可跨 worker 与事件流可跨 worker 是两件独立能力，不要混为一谈。**

### 8.3 取消不是“杀掉 Python 协程”这么简单

`abort_event` 被设置后，stream 循环会主动 break。随后 worker 走 `_finish_cancellation`：

- 发布取消事件；
- 结束 SSE 订阅；
- 标记 `interrupted`；
- 释放任务资源；
- 避免把半成品当成功交付。

如果只是 `task.cancel()`，可能留下未关闭的 stream、未 flush 的日志、未释放的 sandbox。所以取消是一个有明确收尾顺序的业务动作，而不是单纯的协程终止。

## 9. 收尾：成功不等于“模型停止输出”

主循环结束后，worker 先判断：

```text
abort_event? → interrupted
LLM fallback? → error
否则 → 计算交付内容 → success / error
```

### 9.1 交付验证

成功路径会：

1. 取 journal 记录的 delivery content；
2. 用运行前后工作区快照扫描实际产物；
3. 把产物路径合并进交付内容；
4. 调用 `_delivery_error(...)` 判断是否满足成功条件；
5. 写 delivery receipt。

所以 `success` 的语义不是“HTTP 流正常结束”，而是：**Run 完成了，并且交付事实可被记录/验证。**

### 9.2 终态写入顺序

`finally` 块体现了一个很讲究的顺序：

```text
flush journal
  → 写 delivery receipt
  → 更新 finalizing progress
  → 写 duration checkpoint
  → 持久化终态
  → 持久化 completion/token 统计
  → 处理标题、工作区变化、扩展通知、sandbox 释放
```

为什么 receipt 要在终态前？源码注释给出答案：避免“Run 已经显示成功，但交付凭据还没落盘”的崩溃窗口。先有可验证交付，再有终态。

### 9.3 所有权丢失时，停止一切持久化收尾

每个持久化步骤几乎都带 `not record.ownership_lost`。如果租约已经丢了：

- 本 worker 不再写终态；
- 不再写 receipt；
- 不再改线程标题；
- 把恢复责任留给接管者。

这条规则比“尽量多写一点”更重要。分布式系统里，**过期 owner 的善意写入可能比不写更危险。**

## 10. 一张完整时序图

```text
Client
  │ POST /runs[/stream|/wait]
  ▼
thread_runs.py
  │ start_run(body, thread_id, request)
  ▼
services.start_run
  ├─ cancel permission / thread id / secret scan
  ├─ model allowlist / thread ownership
  ├─ context whitelist + authenticated user injection
  ├─ checkpoint history seed
  ├─ RunManager.create_or_reject  ──────────────► RunStore(pending)
  │     └─ idempotency replay? → return existing
  └─ asyncio.create_task(run_after_metadata)
                          │
                          ▼
                 worker.run_agent
                   ├─ wait_for_prior_finalizing
                   ├─ RunManager.try_start ─────► RunStore(running)
                   │    └─ cancelled → no agent build
                   ├─ RunJournal + workspace snapshot
                   ├─ build Runtime context
                   ├─ make_lead_agent
                   │    ├─ tools/auth/deferred/tool-search
                   │    ├─ middlewares
                   │    └─ create_chat_model
                   ├─ agent.astream
                   │    ├─ model ↔ tool loop
                   │    ├─ journal events
                   │    └─ StreamBridge → SSE
                   ├─ delivery content + outputs scan
                   └─ receipt → terminal status → cleanup
```

## 11. 五个最值得记住的设计取舍

1. **先接单再开工**：pending 工单可被取消、可被恢复、可被幂等复用；直接开跑则没有这些控制面。
2. **状态与所有权分离**：`status` 说“是什么”，lease 说“谁能写”。两者缺一不可。
3. **checkpoint 与 event store 分离**：一个服务恢复，一个服务观察/审计。
4. **进程内流与跨进程状态分离**：SSE 绑 owner worker，历史从存储读。
5. **成功必须带交付凭据**：模型结束不是终点，产物和 receipt 才是。

## 12. 常见误区

| 误区 | 正确理解 |
| --- | --- |
| `POST /runs` 返回就意味着 Agent 已经开始 | 返回的是已准入的 RunRecord，worker 还要过 `try_start` |
| SSE 断开就等于 Run 取消 | 是否取消由 `on_disconnect` 和取消策略决定，不是连接本身 |
| `success` 只表示没抛异常 | 还要通过交付内容/产物验证并写 receipt |
| 有了 checkpoint 就不需要 event store | checkpoint 不保存完整过程事件，也不负责前端回放 |
| 任意 worker 都能 stream 任意 Run | memory bridge 下只能由 owner worker 提供；Redis bridge 才支持跨进程 |
| 幂等 key 会缓存模型答案 | 它只防止重复接单，不保证执行结果一致 |

## 13. 源码实验

### 实验 A：验证“开工前取消不构造 Agent”

1. 在 `RunManager.try_start()` 的 `cancelled` 分支打断点；
2. 创建 Run 后立刻调用 cancel；
3. 观察日志：应看到 pending → interrupted，而不是 create_chat_model / tool 初始化。

### 实验 B：验证 SSE 的 worker 绑定

1. 启动两个 Gateway worker；
2. 在 worker A 创建 Run；
3. 向 worker B 请求 `join` 同一 Run；
4. 观察 409 与错误信息，再对比从 event store 读取历史。

### 实验 C：验证交付验证

1. 让 Agent 只回复“已生成 report.md”，但不实际写文件；
2. 查看 delivery content / workspace changes / 终态；
3. 再让工具真实写入，比较 receipt 与 success 判定。

## 14. 自测题

1. 为什么 `start_run()` 要同时做模型白名单和线程归属检查？分别防什么？
2. `try_start()` 与 `create_or_reject()` 都在改状态，它们各自解决哪个竞态？
3. `RunRecord.ownership_lost` 为什么必须阻止终态写入？
4. checkpoint、RunJournal、RunStore 三者分别保存什么？能否互相替代？
5. 为什么 SSE 不能像 RunStore 一样透明跨 worker？
6. 如果 delivery receipt 写失败，Run 应该是什么状态？为什么？
7. 取消一个已经进入工具执行的 Run，至少要做哪些收尾？

### 参考答案

1. **模型白名单**防客户端把任意 provider/model 名变成出网、计费和密钥选择权限；**线程归属检查**防请求体里的 `thread_id` 绕过路径级 owner 校验，造成跨用户读写。前者回答“允许用哪个模型”，后者回答“谁有权在这个线程上创建 Run”。
2. `create_or_reject()` 解决**接单竞态**：同一线程并发创建、同幂等键重放、以及 `reject/interrupt/rollback` 策略下只能产生一个合法工单。`try_start()` 解决**开工竞态**：pending 可能已被取消，多个 worker 也可能同时尝试启动；它用条件状态迁移和租约保证只有一个所有者把 Run 变成 running。
3. `ownership_lost` 表示本 worker 已失去写入资格，通常因为租约过期或被新 owner 接管。此时旧 worker 再写终态、receipt、标题或用量，会覆盖新 owner 的合法结果，形成“僵尸写入”；所以它必须停止所有持久化收尾，把恢复责任交给接管者。
4. **checkpoint** 保存 LangGraph 的可恢复图状态；**RunJournal** 保存运行期过程事件、token、交付内容；**RunStore** 保存 RunRecord、状态、幂等键、租约和控制面字段。三者分别服务恢复、观察/审计、控制面，格式和生命周期不同，不能互相替代。
5. 因为实时 SSE 绑定的是产生流的 owner worker：默认 `MemoryStreamBridge` 的队列在进程内。RunStore 是共享持久层，任何 worker 都能读；但要跨 worker 看实时流，需要 Redis bridge 或从 event store 重放历史，不能假设内存队列透明共享。
6. 不能标记 `success`。交付 receipt 是“成功已有可验证交付”的证据；receipt 写失败意味着终态前的事实链没有闭合，应进入 error/交付失败路径并保留可恢复信息，待重试或人工处理后再形成终态。源码刻意先写 receipt、后写终态，就是为了消除“页面已显示成功、证据却没落盘”的窗口。
7. 至少应：设置 `abort_event` 并停止继续消费模型/工具；让已开始的工具走到可收尾边界，未开始的调用不能留下悬空结果；发布取消事件并结束 SSE；flush journal、保存已有 checkpoint/部分事实；释放 sandbox lease 和 worker 资源；以 `interrupted` 收尾且不写成功 receipt。已经发生的外部副作用不能假装回滚，必须记录为部分执行并依靠幂等键/readback 恢复。

## 15. 代码地图

```text
backend/app/gateway/routers/thread_runs.py   HTTP 三种入口
backend/app/gateway/services.py              start_run / wait / SSE consumer
backend/packages/harness/deerflow/runtime/runs/manager.py
                                             RunRecord / 状态机 / 租约 / 幂等
backend/packages/harness/deerflow/runtime/runs/worker.py
                                             run_agent / astream / 终态
backend/packages/harness/deerflow/runtime/journal.py
                                             过程事件 / token / delivery
backend/packages/harness/deerflow/agents/__init__.py
                                             make_lead_agent
backend/packages/harness/deerflow/agents/factory.py
                                             通用 Agent 组装
backend/packages/harness/deerflow/agents/lead_agent/agent.py
                                             Lead 工具/中间件/模型装配
backend/packages/harness/deerflow/models/factory.py
                                             create_chat_model
```

下一篇把这些部件拆开：上下文如何组装、工具在哪里执行、sandbox 的信任边界、子 Agent 如何共享 Run、以及生产可靠性为何这样设计。
