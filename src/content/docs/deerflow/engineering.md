---
title: "03 · 工程实战"
description: "用故障定位表、源码实验、测试地图和安全修改路径完成工程实战。"
---

> 基线：DeerFlow `v2.1.0`（`345f08be`）。路径相对仓库根目录。
> 前两篇讲“是什么、怎么跑”；本篇讲“怎么读、怎么调、怎么改、怎么验证”。

## 1. 读 DeerFlow 的最短路线

不要从几万行目录开始平铺。用五层定位法：

```text
① 入口层   app/gateway/routers/
② 控制层   app/gateway/services.py + runtime/runs/
③ 装配层   agents/__init__.py + agents/factory.py + lead_agent/agent.py
④ 机制层   agents/middlewares/ + tools/ + sandbox/ + models/
⑤ 支撑层   persistence/ + runtime/journal.py + app/channels/
```

每次读一个功能，都先判断它属于哪层：

- 请求字段变了 → 先看 router + start_run；
- Run 状态不对 → 先看 RunManager + worker；
- 模型看到/没看到某段上下文 → 先看 ThreadState + middleware；
- 工具没有执行/被拒绝 → 先看授权、deferred、sandbox；
- 前端事件缺失 → 先看 journal、event store、StreamBridge。

## 2. 故障定位表

| 症状 | 第一现场 | 接着检查 | 常见根因 |
| --- | --- | --- | --- |
| 创建 Run 返回 400 | `start_run()` | 模型白名单、thread_id | 模型未配置、ID 非法 |
| 创建 Run 返回 403/404 | auth / thread ownership | `check_access`、owner 注入 | 令牌能力不足、线程属于别人 |
| Run 卡片一直 pending | `RunManager.create/try_start` | worker task 是否挂上、lease | 进程崩溃、store 不可用 |
| Run 一直 running 但无输出 | worker / stream | 是否在等模型、工具、容量 | provider 卡住、子 Agent 容量耗尽 |
| SSE 收不到事件 | StreamBridge | owner worker、Redis 配置、Last-Event-ID | 连错 worker、buffer gap |
| 页面显示成功但没有文件 | delivery 逻辑 | workspace snapshot、outputs、receipt | 模型只是口头声称 |
| 工具报“路径不允许” | sandbox path resolver | 虚拟路径、provider 映射 | 越界、用宿主机路径 |
| 子 Agent 不启动 | SubagentLimit / capacity | max_concurrent、max_total | 并发/总量超限 |
| 进程重启后 Run 变 error | lease reconciliation | owner worker、heartbeat | 租约过期被接管 |
| 模型答非所问/丢上下文 | context projection | summarization、预算、memory | 旧消息被压缩、工具结果被裁剪 |

## 3. 三个必须会看的“证据源”

### 3.1 日志

先看结构化字段：`run_id`、`thread_id`、`worker_id`、`model_name`、`tool_name`、`error_type`。不要只看最后一行异常。

一个高效顺序：

```text
request accepted
  → run admitted
  → run -> running
  → agent assembly
  → llm start/end
  → tool start/end
  → delivery receipt
  → terminal status
```

哪一段缺失，问题就在那一段之前或之中。

### 3.2 事件

`GET /api/threads/{thread_id}/runs/{run_id}/events` 可以看完整事件流（用于调试/审计）。重点看：

- 是否有 `metadata`；
- 是否出现模型错误/fallback；
- 工具开始后是否有结束；
- 是否有 delivery / workspace_changes；
- 事件 seq 是否连续。

### 3.3 Checkpoint

checkpoint 用来回答“图执行到哪、状态里有什么”。注意它可能被压缩、可能处于 delta 模式，不能拿它当完整聊天记录。

调试时先确认：

```text
thread_id 对不对
checkpoint mode 是否匹配
是否选择了正确 checkpoint_id
是否被后续 Run 覆盖
```

## 4. 四个源码实验

### 实验 1：让 Run 在 pending 阶段被取消

目标：验证 startup barrier。

步骤：

1. 在 `RunManager.try_start()` 的 `cancelled` 分支加日志；
2. 创建 Run 后立即 cancel；
3. 观察是否出现 Agent 构造/模型调用；
4. 检查事件流是否以取消结束、状态是否为 interrupted。

应得出结论：**取消发生在开工前，不应产生模型费用。**

### 实验 2：切换 memory / redis bridge

目标：理解流式部署边界。

步骤：

1. 用默认 memory bridge 启动两个 worker；
2. 在 A 创建流式 Run，尝试从 B join；
3. 记录 409 条件；
4. 配置 Redis bridge，重复实验；
5. 观察 `Last-Event-ID` 重连行为。

应得出结论：**流式能力取决于 bridge，不取决于 RunStore 是否共享。**

### 实验 3：制造“假交付”

目标：验证 success 与文件事实的关系。

步骤：

1. 让模型只回复“已生成报告”，不调用写文件工具；
2. 查看 workspace changes 和 delivery receipt；
3. 再让工具真实写入 `/mnt/user-data/outputs/report.md`；
4. 对比终态与前端产物。

应得出结论：**交付验证看实际产物/交付内容，不看模型措辞。**

### 实验 4：触发子 Agent 并发上限

目标：理解 `SubagentLimitMiddleware`。

步骤：

1. 在测试配置中把 `max_concurrent` 调小；
2. 构造一次响应包含多个 task call；
3. 观察保留/移除数量与事件；
4. 检查总调用数是否也被 `max_total` 限制。

应得出结论：**并发限制在模型响应后、工具执行前生效。**

## 5. 如何安全地改一个功能

### 5.1 改请求字段

顺序：

```text
router schema
  → start_run validation
  → RunCreateRequest → graph_input/config
  → worker / middleware consumption
  → tests: API contract + behavior
```

检查清单：

- 是否可能被客户端伪造？
- 是否需要加入 `strip_internal_context_keys`？
- 是否要落 RunRecord / event？
- 幂等比较是否要包含新字段？
- 旧客户端是否兼容？

### 5.2 加一个工具

顺序：

```text
tool definition
  → get_available_tools
  → authorization
  → deferred/tool search 可见性
  → sandbox 或服务端执行
  → result metadata / budget / receipt
  → prompt 指引
  → tests
```

检查清单：

- 参数 schema 是否严格？
- 是否需要 sandbox 虚拟路径？
- 失败是否可分类、可恢复？
- 输出是否可能过大？
- 是否会被子 Agent 误用？
- 是否需要审计事件？

### 5.3 加一个 middleware

先回答六个问题：

1. 它处理 `before_model`、`after_model`、`wrap_tool_call` 还是其他钩子？
2. 它修改 state、prompt，还是只观察？
3. 它在链中的 anchor 是什么？
4. 它失败时阻断还是降级？
5. 它是否产生 token/事件/审计？
6. 它和 Clarification、Summarization、ToolError 的先后关系？

不要用“append 到末尾”绕过顺序设计。

### 5.4 改 checkpoint / 持久化

这是高风险区。至少验证：

- full/delta 兼容；
- 旧数据迁移；
- 多 worker 租约；
- 取消/重启/回滚；
- 事件 seq 和 receipt；
- schema migration 的前后向兼容。

## 6. 测试地图

### 6.1 最值得先读的测试

| 测试 | 保护什么 |
| --- | --- |
| `test_harness_boundary.py` | `deerflow` 不得反向依赖 `app` |
| `test_run_manager.py` | 状态、取消、租约 |
| `test_thread_run_idempotency.py` | 幂等准入 |
| `test_runs_api_endpoints.py` | HTTP 契约 |
| `test_run_worker_delivery.py` | 终态与交付 |
| `test_multi_worker_run_ownership.py` | 多 worker 所有权 |
| `test_run_worker_delta_resume.py` | delta checkpoint 恢复 |
| `test_sandbox_leases.py` | sandbox 使用与释放 |
| `test_subagent_limit_middleware.py` | 子 Agent 并发限制 |
| `test_run_event_stream_contract.py` | SSE 事件契约 |

### 6.2 常用命令

```powershell
cd $DEERFLOW_SRC\backend
uv run pytest tests/test_harness_boundary.py -q
uv run pytest tests/test_run_manager.py tests/test_thread_run_idempotency.py -q
uv run pytest tests/test_run_worker_delivery.py tests/test_multi_worker_run_ownership.py -q
```

仓库根还可运行：

```powershell
make test
```

改动触及多 worker / Redis / sandbox 时，单元测试通过不等于完成；至少补一次真实多进程或集成验证。

## 7. 五个设计取舍的“为什么”

### 7.1 为什么 Run 要有 pending 状态

因为“已接单”与“已开工”之间需要可取消、可恢复、可审计的窗口。没有 pending，取消只能杀进程，幂等只能靠猜。

### 7.2 为什么要有 event store

因为 checkpoint 是给图的，不是给人的。用户要看到工具进度、模型输出、交付状态；审计要看到失败原因和事件顺序。

### 7.3 为什么工具要 deferred

因为工具目录会随 MCP/扩展增长。全量 prompt 会消耗大量 token，并让模型在相似工具间误选。延迟发现把“知道存在”和“现在可用”分开。

### 7.4 为什么 sandbox 用虚拟路径

因为工具契约不能依赖部署路径。虚拟路径同时提供权限边界、跨 provider 一致性和 prompt 稳定性。

### 7.5 为什么保留 harness/app 边界

因为内核要能被 Web、IM、SDK、嵌入式客户端复用。允许内核 import app，短期方便，长期会把所有宿主耦合进内核。

## 8. 常见“看起来对”的错误改法

| 错误改法 | 为什么危险 | 正确方向 |
| --- | --- | --- |
| 在 router 里加权限检查 | 其他入口可绕过 | 放到 `start_run()` 收口 |
| 用 `task.cancel()` 代替取消流程 | 流、日志、sandbox 未收尾 | 设置 abort_event 并走统一 finalization |
| 给模型塞完整工具输出 | 挤爆上下文 | 预算 + synopsis + 可回查路径 |
| 把 checkpoint 当审计日志 | 压缩/覆盖/格式变化 | 用 event store / journal |
| 让子 Agent 自由递归 | 预算失控 | capacity + max_total + depth 限制 |
| 直接信任 MCP 返回 | 注入、超大 payload | 结果分类、摘要、权限与大小限制 |
| 改状态不看 lease | 僵尸 worker 覆盖 | 条件更新 + ownership_lost 围栏 |

## 9. 毕业练习

### 练习 A：画一张“失败恢复图”

选一个失败点（模型超时、worker 崩溃、sandbox 断连、SSE 断开、交付写失败），画出：

```text
谁发现 → 谁决策 → 谁写状态 → 用户看到什么 → 如何重试
```

### 练习 B：实现一个只读工具

要求：

- 只读访问 `/mnt/user-data/uploads`；
- 参数严格校验；
- 结果过大时摘要；
- 错误可分类；
- 不暴露给子 Agent；
- 有测试。

### 练习 C：给一个中间件写契约测试

选择一个现有 middleware，补三类测试：

1. 正常路径；
2. 工具/模型错误路径；
3. 取消或超时路径。

### 练习 D：解释一次跨 worker 故障

假设 Run 在 worker A 执行，A 在写终态前崩溃，worker B 接管。请按 lease、checkpoint、event store、receipt 的顺序解释 B 应该做什么、不能做什么。

### 练习参考答案与验收点

**练习 A（以“worker A 写终态前崩溃”为例）**

```text
谁发现：Run 心跳/租约过期，或 restore/reconcile 扫描发现 owner 不在
谁决策：RunManager 的恢复路径判定 lease 已失效，允许新 owner 接管
谁写状态：只有拿到新 lease 的 worker 才能以条件更新推进状态
用户看到：先看到中断/恢复中，而不是伪造的 success；随后看到 replayed 事件和最终态
如何重试：从最后一个已提交 checkpoint 继续；先读 event store/journal/receipt，已发生的外部 effect 不重做
```

验收点：旧 worker 的 `ownership_lost` 后不再写终态或 receipt；新 owner 不会重复执行已经留下幂等 receipt 的工具；如果副作用存在但结果未知，先做 readback，而不是直接重跑。

**练习 B（只读上传工具）**

参考做法：在工具定义处声明严格 schema，只接受 `/mnt/user-data/uploads/...` 逻辑路径；经 `get_available_tools → authorization → deferred/tool search` 后才暴露；执行时由 sandbox provider 解析真实路径并做越界检查；读取有大小上限，超限返回 synopsis、字节数和可回查的 receipt，而不是整段内容；错误至少区分 `not_found`、`permission_denied`、`too_large`、`transient`；在授权/可见性层明确不向子 Agent 暴露。

验收点：目录穿越、符号链接逃逸、绝对宿主路径都被拒绝；大文件不会撑爆上下文；错误可被模型理解；审计能看到调用与结果摘要；子 Agent 的可用工具列表中没有它。

**练习 C（middleware 契约测试）**

1. **正常路径**：断言 state/prompt 的前后差异、事件顺序、工具结果结构，以及是否只执行一次。
2. **错误路径**：模型或工具报错时，断言错误被分类、没有悬空 `tool_call`、不会把失败当成功，必要时是否 re-raise/降级。
3. **取消/超时路径**：断言 `abort_event` 生效后停止继续调用，已开始的工具被收尾，未开始的调用有匹配结果，最终不是 `success`，资源和 sandbox 被释放。

验收点不是“函数被调用过”，而是这些可观察行为：状态、事件、工具结果配对、终态、持久化副作用。

**练习 D（跨 worker 接管）**

worker B 应先确认 A 的 lease 已过期并取得自己的 lease；读取 RunStore 的当前状态、checkpoint、journal/event store 和已有 receipt。若 A 的最后一个 checkpoint 已完整，就从那里恢复；若某个工具 effect 已有幂等 receipt，就跳过；若没有 receipt 但外部状态可能已经改变，先 readback 再决定。B 不能：在未拿到 lease 时写任何状态；直接从头重跑整个 Run；重复写 delivery receipt；把 A 留下的未知工具结果编造成成功。只有验证交付并写入 receipt 后，B 才能推进到终态。

## 10. 最终自测

不看文档回答：

1. 一次 Run 的五个关键阶段是什么？
2. 哪些字段只能由服务端写？
3. 哪三类事实分别存在 checkpoint、RunStore、event store？
4. 取消、失败、交付失败分别如何收尾？
5. 多 worker 下，SSE 与 Run 状态的所有权有何不同？
6. 一个工具从注册到被模型调用，要经过哪些层？
7. 修改 middleware 顺序可能破坏哪些行为？
8. 为什么 `deerflow` 不能 import `app`？

### 最终自测参考答案

1. 五个关键阶段：**接单准入（start_run）→ pending→running 开工/lease → Agent 组装与 astream 执行 → 交付验证与 receipt → 终态写入/清理**（代码地图里通常展开为接单、开工、执行、交付、收尾）。
2. 只能由服务端写：`run_id/owner_user_id/status/timestamps/lease/ownership/token usage/checkpoint_id/delivery receipt`、认证用户与项目归属、内部 context key、事件 seq 等生命周期和授权事实。客户端可以表达偏好，但不能写身份、所有权和终态。
3. **checkpoint**：LangGraph 图状态与恢复点；**RunStore**：Run 控制记录、状态、幂等与租约；**event store/journal**：过程事件、审计/回放、交付内容与 receipt。
4. **取消**：设置 abort、停止继续消费、收尾已开始工具、flush journal、释放 sandbox/流资源，以 `interrupted` 结束且不写成功 receipt。**失败**：记录分类错误、保存 checkpoint/journal、按所有权条件进入 error，保留可恢复证据。**交付失败**：不能 success；保留产物/交付验证失败信息，走 error 或可重试恢复，直到 receipt 与终态一致。
5. 多 worker 下，Run 状态在共享 RunStore 中，任何有权限的 worker 可读；实时 SSE 默认绑定 owner worker 的进程内 StreamBridge。跨 worker 观看需要 Redis bridge 或从 event store 重放，不能把“状态可读”误当成“流可透明接管”。
6. 注册/定义 → `get_available_tools` 候选 → 授权过滤 → deferred/tool search 本轮暴露 → prompt/schema → 模型调用 → 参数校验/审批 → sandbox 或 provider 执行 → 结果分类/预算/receipt → 作为 `ToolMessage` 回流。
7. 会破坏：系统 prompt 与缓存稳定性、上下文压缩时机、工具授权/审批、工具错误处理与结果配对、澄清顺序、子 Agent 并发限制、取消与收尾。middleware 的顺序是行为契约，不是列表装饰。
8. 因为 `deerflow` 要作为可复用 harness 被 Embedded Client、SDK 和其他宿主使用；反向依赖 `app` 会把 Web/IM/数据库实现耦合进内核，破坏可移植性和边界测试。

## 11. 一页代码地图

```text
app/gateway/routers/thread_runs.py       HTTP 契约
app/gateway/services.py                  start_run / SSE / wait
runtime/runs/manager.py                  RunRecord / 状态 / 租约 / 幂等
runtime/runs/worker.py                   run_agent / astream / 终态
runtime/journal.py                       事件 / token / 交付
runtime/stream_bridge/                   memory / redis 流桥
runtime/checkpoint_mode.py               full / delta
agents/__init__.py + factory.py          Agent 组装
agents/lead_agent/agent.py               Lead 装配
agents/middlewares/                      上下文/工具/安全/澄清
models/factory.py                        模型工厂
tools/ + sandbox/                        工具与执行边界
subagents/                               子 Agent 运行时
mcp/ + skills/ + extensions/             扩展面
app/channels/                            IM 接入
backend/tests/                           契约与行为证明
```

读到这里，DeerFlow 的核心脉络应能压缩成一句话：

> **Gateway 把不可信请求变成受控 Run，worker 用租约和状态机把 Run 可靠地跑完，Agent 用上下文/工具/模型完成推理，journal/checkpoint/store 把过程、状态和交付分别留证。**
