---
title: "02 · 核心机制：状态、权限、证据与投影"
description: "理解 Goal、Todo、Claim、Gate、Quota、Evidence 与投影机制。"
---

> 基线：LoopX `v2.1.1`。本章不是命令手册，而是解释“为什么这些对象必须分开”。

## 1. 总模型：控制面是一个 effect interpreter

LoopX 官方架构文档给了一个很好的统一视角：

```text
model -> effect request -> harness interprets effect -> observation -> model
```

模型提出“我想做某件事”；Harness 不直接执行，而是先解释：

- 这是不是一个合法的 effect？
- 当前 Goal、Todo、claim、gate、quota 是否允许？
- 需要哪个 Capability/Provider？
- 返回的 observation 证明了多少？
- 这次变化是否已写回、花配额、调度下一轮？

于是，LoopX 不是简单的 CRUD 数据库，也不是“定时器 + prompt”。它是把当前状态 `A` 投影为 observation `F[B]`，再依据 quota/interaction/capability/scheduler 规则决定下一个 effect 的解释器。

这带来一个关键设计原则：**合法性写在 typed contract 里，不写在提示词里。**

---

## 2. Goal：为什么它必须是“lifetime goal”

LoopX 的核心对象不是一次 session，而是一个可能活很多天的 Goal。`docs/architecture.md` 的 Lifetime Goal Invariant 要求一个未来的人或 Agent 能恢复：

- 目标是什么；
- 当前什么在定义它；
- 谁可以修改；
- 下一步安全转换是什么。

因此 Goal 需要：

| 部分 | 作用 |
| --- | --- |
| identity | 稳定 goal id、repo/project 边界 |
| vision / acceptance | 最终目标和验收条件 |
| boundary / non-goals | 明确不能越过的范围 |
| authority sources | 哪些文档、状态或决策才是权威 |
| priority / next action | 当前 belief 下的路线 |
| guard / capability | 执行前必须满足的条件 |
| monitor / continuation | 何时继续、何时停 |

Goal 不能变成“无限日记”。活跃状态应保存下一轮重建正确决定所需的紧凑事实，旧推理可以丢弃，外部世界必须重新探测。

### 2.1 为什么 Authority Source 很重要

如果所有知识都来自模型记忆，换 session 后就会出现：

- 目标版本不一致；
- 同一份需求有两种解释；
- 旧讨论覆盖了新决策；
- 私有材料被无意公开。

Authority source 把“以什么为准”变成可检查的引用。它不自动保证内容正确，但至少让冲突有落点：当聊天、旧状态和权威文档冲突时，系统知道应该看哪一个。

---

## 3. Todo：不是待办事项，而是可执行工作卡

### 3.1 原生状态只有四个

`loopx/control_plane/todos/contract.py` 定义：

```text
open
done
blocked
deferred
```

不要自行发明 `running`、`claimed`、`superseded` 作为 stored status：

- `claimed_by` 是 ownership metadata，不是原生状态；
- “正在运行”通常是 claim/lease + current Turn 的派生视图；
- `superseded_by` 是后继关系元数据，不是第五种状态；
- `done` 与 `deferred` 都是 terminal status，但语义不同。

### 3.2 一张 Todo 至少回答什么

| 维度 | 典型字段 | 要解决的问题 |
| --- | --- | --- |
| 身份 | `todo_id` | 跨 session、跨 Agent 稳定引用 |
| 目标 | `goal_id` | 属于哪个长期目标 |
| 分类 | task class / action kind | 是交付、观察、修复还是重规划 |
| 范围 | repo、workspace、target key | 允许在哪里写 |
| 依赖 | predecessor / successor | 什么必须先完成 |
| 所有权 | `claimed_by`、lease | 谁当前负责 |
| 排除 | `excluded_agents` | 哪些 Agent 不应被唤醒 |
| 继续 | continuation policy | 完成后如何接下一张 |
| 等待 | resume condition / monitor | 什么事实到达后才能恢复 |

`selected_todo` 不是“列表第一项”。Kernel 会结合状态、依赖、claim、capability、workspace、gate 和 quota 选出当前 frontier。

### 3.3 Claim 与 Lease

Claim 回答“谁负责这张卡”，Lease 回答“这个责任在多长时间/版本内有效”。

当前源码同时存在轻量与更严格的协作合同：

- todo metadata 里的 `claimed_by` 是可见的 soft owner；
- 只有登记在 `coordination.registered_agents` 的身份才被接受；
- 更完整的 peer runtime 使用 claim/lease、scope、idempotency 和 compare-and-swap 解决并发；
- 注册 Agent 是 peer，不存在永久的 leader identity；
- 临时 coordinator 只协调一个 bundle，不获得其他 peer 的隐式评审/合并/重规划权。

不要把握有 claim 当成拥有整个 Goal。Claim 只覆盖被领取的 Todo 和其 scope。

### 3.4 Gate：等待不是失败

Gate 表示某个前置事实或人的判断尚未满足。常见类型：

- operator/user gate；
- capability readiness gate；
- workspace / boundary gate；
- external evidence gate；
- terminal acceptance gate。

`operator_gate` 的关键细节是 **blocked_action_scope**：它可能只阻断 gated delivery，而允许安全的只读 steering、分析或与门禁无关的优先事项。不能因为一个 gate 就把整个 Goal 冻死，也不能把它当成全局放行。

### 3.5 Monitor：外部条件未满足时的观察工作

Monitor 不是忙等。它需要：

- 观察目标（PR、CI、实验、外部系统）；
- 新鲜度要求；
- 下一次观察时间/backoff；
- 连续无变化计数；
- 恢复条件；
- 何时升级为人工动作或重规划。

`consecutive_no_change` 属于 monitor target，不属于整个 Goal。多个 monitor 交错轮询时，不能用“相邻 run 文本相似”草率判断停滞。

### 3.6 Continuation：完成后不等于结束

`validated_completion` 必须声明 continuation：

- `successor`：产生后继 Todo；
- `active_goal`：Goal 仍活跃，重新看 frontier；
- `no_followup`：没有后继，进入 terminal audit。

如果一张卡完成却没有定义后继，系统不能自动说“Goal 完成”。它要检查 monitor、handoff、acceptance gap、replan obligation、sink retry、blocker/resume route 等。

---

## 4. Quota：预算也是权限

`quota_status()` 同时做两件事：

1. 判断自动运行状态；
2. 计算本窗口已花/可用 slot。

源码中的 `QUOTA_STATE_ORDER` 是：

```text
blocked_health → operator_gate → focus_wait → eligible → waiting → throttled → paused
```

顺序意味着优先级。例如健康阻断先于人工门禁，人工门禁先于普通 eligible。

### 4.1 Quota 不是只有“有钱/没钱”

| 状态 | 你能学到什么 |
| --- | --- |
| `blocked_health` | 先修系统，不是等预算 |
| `operator_gate` | 人可以给方向，但不能绕过 gated 动作 |
| `focus_wait` | 当前 focus 未满足，继续等特定条件 |
| `eligible` | 可以生成下一 Turn |
| `waiting` | 外部观察/无 ready 工作 |
| `throttled` | 预算窗口耗尽 |
| `paused` | owner 停止或 compute=0 |

### 4.2 Slot 记账要对净效果负责

Quota 不能只加不减。源码支持 spend 与 void：

- spend 记录一次真实交付；
- void 在非破坏性前提下纠正错误记账；
- 记录会按 goal instance 和窗口校验，避免把旧 Goal 实例的花费算到新实例；
- 重复事件不能重复加 slot。

这再次体现控制面原则：预算不是 UI 计数器，而是有身份、有事件来源的账本。

### 4.3 无进展时不要“花配额证明自己活着”

`should-run` 可能在两轮无实质推进后要求 self-repair、replan 或 stop。继续热轮询只会消耗预算，并把“活动”伪装成“进展”。

判断进展应看：

- 交付物是否变化；
- 证据是否新增且新鲜；
- blocker 是否解除；
- 是否有新的 typed successor；
- 是否有覆盖证明的 `no_followup`。

不是看 run 次数、token 数或聊天气泡数。

---

## 5. Evidence：为什么“我做过”不够

一个可信 evidence 至少要有：

- **身份**：属于哪个 Goal / Todo / Turn / effect；
- **来源**：命令、文件、CI、Provider readback 或人工决策；
- **时间/新鲜度**：何时产生，是否已过期；
- **范围**：证明的是全部还是局部；
- **可验证性**：别人能否重放或检查；
- **公共安全性**：能否进入 public projection。

### 5.1 观察 vs 转换

```text
外部 observation → Provider 归一化 → Capability 验证 → typed proposal → Kernel commit
```

其中任何一步都不能被跳过。PR 页面显示 merged，只是 observation；Provider 要把事实带回，Capability 要判断它是否满足本 Todo 的验收，Kernel 才写回。

### 5.2 Receipt 的边界

Receipt 证明“某个 effect 被请求/执行过”，但不自动证明“领域目标完成”。

- Host receipt 证明一轮 Host 结果；
- writeback receipt 证明状态写入；
- quota receipt 证明 slot 扣除；
- terminal closeout receipt 证明终局收尾。

每种 receipt 只能关闭它对应的阶段。不能用 writeback receipt 代替 validation，也不能用 Host 的“success”代替外部 readback。

### 5.3 Run history 不是全量日志

Run history 是 compact evidence trail，供下一轮重建判断。它保留：

- identity；
- 结果 kind；
- 关键 evidence；
- 推荐动作/决策；
- 配额贡献；
- 与 Goal/Todo 的关系。

原始 transcript、私有日志和大文件不应成为控制面的默认上下文。需要时通过 typed evidence reference 去读；不要让“上下文里塞得下”决定“应该塞”。

---

## 6. Projection：为什么看板和状态页不能拥有事实

`loopx/status.py::collect_status()` 从 Registry、run history、contract health、attention 等构建状态。`build_attention_queue()` 再派生“谁需要行动”的队列。

Projection 的目标是：

- 让 Agent/Heartbeat/UI 用有限上下文理解当前局面；
- 排序和压缩；
- 隐藏私有或无关细节；
- 指出下一步可执行动作。

Projection 不能：

- 成为唯一状态源；
- 让列表位置变成权限；
- 用一个概括字段替代 original receipt；
- 把建议动作当真白名单；
- 将私有原始日志写入 public JSON。

Dashboard 和 Kanban 都是 projection。卡片移动必须翻译成 canonical transition，而不是直接改 UI 或 Markdown 表格。

---

## 7. 上下文工程：LoopX 如何“让模型看见正确的世界”

LoopX 不做模型上下文窗口管理，但它决定**本轮应该看见哪些控制事实**。

### 7.1 每轮上下文由这些层组成

```text
当前 Goal identity / vision / acceptance / boundary
当前选中的 Todo + claim/lease + capability gate
当前 quota / gate / monitor 决策
本轮 TurnEnvelope + transaction plan
最近 run history / evidence refs
Host 自己的 system prompt、会话与工具说明
```

### 7.2 fresh 与 resume

- `fresh`：明确假设旧会话不可依赖，用当前控制事实重建上下文；
- `resume`：复用 Host 会话，但仍重新绑定当前 Goal/Todo 身份。

两者都不能让旧对话覆盖当前 canonical state。切换模型、Agent 交接或长会话压缩后，`fresh` 往往更安全，但会牺牲对话连贯性。

### 7.3 为什么先投影再执行

如果直接把整个 Goal 状态、所有历史、所有日志交给模型，会：

- 超出窗口；
- 混入过期事实；
- 增加成本和攻击面；
- 让模型误把私有数据带到外部。

所以先由 status/history/quota/turn plan 做有界投影，再让 Host 在其上加自己的提示和工具上下文。这是 LoopX 与 Host 的上下文分工。

---

## 8. Capability、Provider、Extension：三条正交轴

### 8.1 Capability

Capability 是产品合同，回答：

- 这个领域什么算成功？
- 需要哪些观察和验证？
- 允许哪些 typed transition？
- 失败如何分类？

它不应该直接拥有 Kernel 的 claim、gate、quota 或 lifecycle 写权。

### 8.2 Provider

Provider 是外部连接，回答：

- 如何调用 API/CLI/系统；
- 如何归一化 observation；
- 如何做 readback 和幂等；
- 如何暴露错误与不可用状态。

Provider 不做产品策略。它不应自行决定 Todo 是否完成。

### 8.3 Extension

Extension 是交付与生命周期单元，可以安装一个或多个 Provider，但不因此获得 Kernel 权限。`CapabilityRegistry` 将 provider、capability contract 和 implementation 分开注册，正是为了防止“安装即授权”。

### 8.4 Host adapter

Host adapter 把 Codex/Claude/DSH 的 hook、MCP 或本地接口映射到同一 CLI-equivalent 合同。它应该：

- 路由到当前状态；
- 暴露读与合法写；
- 保持 CLI fallback；
- 不嵌入第二套 scheduler 或旧项目策略。

---

## 9. 硬边界 vs steering：最容易做错的设计点

LoopX 文档把它称为 **Guided Autonomy, Not Recommendation Lock-In**。

### 硬边界

- claim/lease 与 scope；
- capability readiness；
- operator/user gate；
- quota 与 pause；
- workspace/repo 写边界；
- destructive/production-effect 规则；
- public/private 边界。

这些必须由 typed authority 或 transition 执行，不能靠提示词。

### Steering

- 优先级建议；
- 推荐动作；
- bounded `next_cli_actions`；
- work-lane 提示；
- 提醒最近的失败类型。

这些帮助 Agent 高效选择，但不应悄悄缩小合法集合。Agent 可以选择未显示但当前 authoritative/eligible 的动作，只要仍走同样的 preflight 和 settlement。

### 判断规则

问自己：如果 Agent 不按这条建议做，系统应该**拒绝**，还是只是**不推荐**？

- 拒绝 → 写成硬边界；
- 不推荐 → 保持 advisory，并在 schema 里标清楚。

---

## 10. 失败、停滞与自我修复

### 10.1 失败要分类，不要都叫 error

- `host_failure`：执行环境/Host 问题；
- `validation_failed`：结果未通过证据或领域检查；
- `writeback_failed`：状态提交失败；
- `quota_spend_failed`：预算提交失败；
- `terminal_closeout_failed`：已写回/已花配额，但终局收尾失败；
- `repair_required`：需要修控制面/执行环境；
- `replan_required`：原路线不再成立。

分类决定恢复动作。把所有失败都重试同一命令，是控制面最危险的错误之一。

### 10.2 停滞检测看“变化”

Self-repair 不应只是“再想一次”。源码课程建议的检查顺序包括：

1. 重读当前 quota interaction contract；
2. 读 scoped evidence；
3. 比较最新 run 与 selected Todo；
4. 检查 projection、claim、lease、capability、workspace、gate；
5. 判断是执行、状态还是 Host 问题；
6. 写 machine-visible repair delta；
7. 做 focused validation；
8. 只有 material progress 才 refresh/spend。

Self-repair 不允许：

- 降低安全 gate；
- 猜测缺失 payload；
- 把私有日志提交到 public repo；
- 用 destructive git 清理不明改动；
- 把 no-progress 改名为 success。

---

## 11. 工程边界：为什么架构测试重要

`tests/architecture/test_control_plane_import_boundaries.py` 检查 control plane 是否越界依赖 presentation、CLI、capability 或 benchmark adapter。这不是形式主义：

- 若 Kernel import CLI，状态规则会被命令参数污染；
- 若 Kernel import capability，通用控制面会绑定某个业务；
- 若 provider 直接写 lifecycle，验证与审计被绕过；
- 若 projection 获得写权，UI 就变成第二事实源。

读一个新模块时先判断它属于 Agent、Provider、Capability 还是 Kernel，再讨论代码结构。边界错了，测试再多也只是固化错误。

---

## 12. 自测

1. 为什么 `claimed` 不应被当成 Todo 的原生 status？
2. `operator_gate` 和 `waiting` 的恢复路径有何不同？
3. 为什么 Provider receipt 不能直接关闭 Todo？
4. `fresh` 与 `resume` 各适合什么场景？
5. 一个“推荐动作”没有出现在 `next_cli_actions`，是否意味着它非法？怎么判断？
6. 为什么 `terminal_closeout_failed` 不能归入 `NO_SPEND_RESULT_KINDS`？
7. Capability 与 Extension 为什么不能互相替代？

---

### 参考答案

1. 因为 `claimed` 是**所有权元数据**，不是工作生命周期。原生 status 只表达 Todo 本身是 pending/in_progress/blocked/done/deferred 一类事实；“谁在 claim、lease 到何时”应由 `claimed_by`、lease 和当前 Turn 派生。把 claimed 写成第五种 status 会让过期 claim 伪装成工作状态，也会破坏状态机与投影的可重建性。
2. `operator_gate` 需要用户/操作者做决定，恢复路径是拿到明确授权或修改 gated scope；它不一定冻结整个 Goal。`waiting` 是外部条件/无 ready 工作，恢复路径是 monitor、resume condition 或 backoff 后重新观察。前者是“人给权限”，后者是“等事实到达”。
3. Provider receipt 只证明某个 effect 被请求/执行过，或某个外部 observation 被读回；它不证明本 Todo 的验收已满足。必须由 Capability 验证 evidence、Kernel writeback 接受转换，才能关闭 Todo。receipt 只能关闭它对应的阶段，不能越权关闭领域目标。
4. `fresh` 适合 Host/模型切换、长会话、旧会话不可信、压缩后需要从 canonical state 重建的场景；`resume` 适合同一 Host 连续性有价值，且旧会话仍可信的场景。二者都必须重新绑定当前 Goal/Todo/claim，旧对话不能覆盖当前权威状态。
5. 不是。`next_cli_actions` 是 steering，不是白名单；判断合法性要看 typed authority、当前 transition/eligibility、preflight 和 receipt binding。只要动作在当前 canonical state 下被授权且可验证，即使没有被推荐，也可以走同一结算路径；反过来，推荐列表里的动作也必须重新校验。
6. 因为它发生在 writeback 和 spend **之后**，表示配额已经提交、只剩终局收尾失败。如果把它归进 `NO_SPEND_RESULT_KINDS`，调用方会误以为未扣费并重试，造成重复 spend 和错误预算；正确恢复只补 closeout。
7. Capability 定义领域合同：什么算成功、如何观察/验证、允许哪些 typed transition；Extension 是安装与交付单元，可以携带 Provider/Capability 实现，但“安装”不自动获得 Kernel 权限。前者是语义与验证，后者是分发与组合，二者正交。

*下一章：`engineering.md`，把这些机制落到调试、实验、修改和验收。*
