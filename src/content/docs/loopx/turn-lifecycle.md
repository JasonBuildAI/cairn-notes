---
title: "01 · 一次 Turn 的一生"
description: "追踪一次有界 Turn 从 should-run、Host 执行到验证、写回和调度的主线。"
---

> 基线：LoopX `v2.1.1`。主路径源码：`loopx/control_plane/turn_driver/driver.py`、`executor.py`、`transaction.py`、`settlement.py`。

## 1. 本章要解决的问题

用户说“继续修这个 PR”，到系统真正安全地推进一小步，中间并不是一次函数调用。LoopX 必须依次回答：

1. 这个 Goal 现在允许自动运行吗？
2. 哪张 Todo 是该 Agent 当前可合法执行的？
3. 这一轮是执行、观察、等待、询问人、修复还是重规划？
4. 给 Host 的合同包含哪些身份、权限和边界？
5. Host 做完后，什么算“有效结果”？
6. 哪些 durable effect 已经发生，崩溃后怎样恢复？
7. 什么时候扣配额、更新 scheduler、宣告 terminal？

本章沿着这条线走一遍。先记住总图：

```text
Registry + Goal State + Run History
        │
        ▼
quota should-run
        │  TurnEnvelope / effective_action / selected Todo
        ▼
build_loopx_turn_plan()
        │  route + transaction plan（只读规划，不执行）
        ▼
turn run-once
        │
        ├─ journal / admission / host invocation
        │
        ├─ host_execute
        ├─ typed_result
        ├─ validation
        ├─ durable_writeback
        ├─ quota_spend
        ├─ [terminal_closeout when completing]
        ├─ scheduler_apply
        └─ scheduler_ack
        │
        ▼
refresh-state / next should-run
```

---

## 2. 入口：命令不是内核

`pyproject.toml` 把 `loopx` 命令指向 `loopx.entrypoint:main`。入口先处理 UTF-8、极少量的快速路径，再进入 `loopx/cli.py` 的巨大命令面。`cli.py::build_parser()` 注册了 status、todo、quota、turn、history、capability、extension 等命令。

读源码时不要把“命令多”误认为“逻辑都在 CLI”。CLI 主要做：

- 参数解析与格式选择；
- 解析 registry / runtime root；
- 调用对应 handler；
- 打印 JSON 或 Markdown 投影。

真正的状态规则在 `loopx/control_plane/`。命令只是控制面的一个入口，Host 适配器、Heartbeat 和脚本最终也应落到同一合同。

### 2.1 先解析“看哪个项目、哪个 Goal”

Registry 默认项目路径约定是 `<project>/.loopx/registry.json`。一个 registry goal 至少要有：

- 稳定 `id`；
- 所属 repo/project；
- `state_file`；
- adapter kind/status；
- authority sources；
- 与 quota、guard、status 有关的配置。

`loopx/registry.py` 会检查多个 Goal 是否错误共享同一个 state file、state 文件是否存在、adapter 是否缺失。`loopx/runtime.py` 再保证 goal 目录不会逃逸出 runtime root。

这一步看起来像“找文件”，实际是在固定事实来源：**同一个请求不能在不同命令里悄悄读到不同 Goal。**

---

## 3. `quota should-run`：控制循环的分岔口

`loopx/quota.py::quota_status()`（约 437 行）先计算配额状态，顺序是固定的：

```text
blocked_health
operator_gate
focus_wait
eligible
waiting
throttled
paused
```

这不是“严重程度排序”，而是决策顺序：越靠前的条件越先拦截。

### 3.1 七种状态分别在说什么

| 状态 | 含义 | 常见恢复方式 |
| --- | --- | --- |
| `blocked_health` | 健康/合同阻断，先修系统 | 修复 contract、投影或 adapter |
| `operator_gate` | 人工门禁阻断 gated delivery | 人可以允许安全 bypass，但不能走被门禁的动作 |
| `focus_wait` | 当前交付聚焦点尚未满足 | 等 focus 条件解除 |
| `eligible` | 有可运行的下一回合 | 生成 TurnEnvelope，进入执行 |
| `waiting` | 外部证据或没有 Codex-ready 工作 | 观察、monitor、等外部条件 |
| `throttled` | 窗口内配额已花完 | 等窗口或调整预算 |
| `paused` | owner 停止 Goal 或 compute=0 | 显式 resume / 调整配额 |

`paused` 只有两个 typed cause：`goal_stopped`、`compute_quota_zero`（`loopx/control_plane/quota/states.py`）。不要让 UI 文案自己发明暂停原因。

### 3.2 `should_run=false` 不是单一失败

`should-run` 输出除了布尔值，还会给出：

- `effective_action`：这一轮要采取的动作类型；
- `selected_todo`：选中哪张工作卡；
- `scheduler_hint`：何时/是否再次唤醒；
- `interaction_contract`：允许什么、禁止什么、下一步 CLI；
- `requires_user_action` / attention 信息；
- `next_cli_actions`：可执行的、通常绑定身份的下一步命令。

这些字段不是装饰。`monitor_due`、`operator_gate_notify`、`quota_skip`、`terminal_no_followup`、`blocked_wait` 都可能是 `should_run=false`，但恢复路径完全不同。**读 should-run 必须读 reason 和 effective_action，不能只看 run/no-run。**

### 3.3 指引不是隐形白名单

`next_cli_actions` 是 steering：帮助 Agent 快速选择合法路径。它不是唯一合法集合。只要 Agent 选择的是当前 authoritative 且 eligible 的动作，仍应通过同样的 preflight、receipt binding、validation、writeback 和 spend 路径提交。

如果要真正限制，应把限制写进 typed authority / transition contract，而不是靠“推荐列表里没有”或 prompt 暗示。

---

## 4. 从决策到合同：TurnEnvelope 与 `build_loopx_turn_plan()`

`quota should-run` 生成 TurnEnvelope。`build_loopx_turn_plan()`（`driver.py`，约 466 行）把它投影为 **无副作用的执行计划**。

### 4.1 支持面

当前 driver 支持的 Host：

```text
codex-cli
claude-code
dsh
generic-cli
```

执行模式：

```text
interactive-visible
isolated-headless
```

迭代上下文策略：

```text
fresh
resume
```

`agent` session scope 目前只允许 `codex-cli`；其他 Host 默认按 Todo scope 绑定。这不是模型偏好，而是会话身份合同的限制。

### 4.2 路由

计划先得到一个 `LoopXTurnRoute`：

- `ready_for_host`
- `capability_action_required`
- `repair_required`
- `replan_required`
- `user_action_required`
- `wait`
- `blocked`
- `contract_error`

只有 `ready_for_host`、`repair_required`、`replan_required` 会设置 `would_invoke_host=true`。

`capability_action_required` 是刻意拆出的第四条路：有些动作必须先走 capability 自己的命令和 receipt，不能直接启动普通 Host Turn。

### 4.3 计划里有什么

关键输出包括：

```text
host / execution_mode / scheduler context
session plan
route + effective_action + selected_todo
turn_envelope
transaction plan
effects = 全 false
boundary.read_only = true
```

`transaction` 由 `build_loopx_turn_transaction_plan()` 生成，绑定：

- Goal / Agent / Todo / replan obligation；
- host、execution mode、session action；
- `turn_key`；
- settlement identity / effect id。

`turn_key` 不是随机日志 id，而是身份与执行上下文的 canonical hash。后续 Host 结果、journal、writeback、spend 都必须与它对齐。

### 4.4 为什么“规划”必须无副作用

计划阶段可被 Preview、调试、Host 预检和测试反复调用。如果它顺手写状态或扣配额，就无法安全重放。

源码在 payload 中明确写明：

```text
host_invoked = false
state_written = false
quota_spent = false
scheduler_acknowledged = false
host_invocation_allowed = false
```

真正执行必须进入显式 `turn run-once` 路径。

---

## 5. `turn run-once`：有界执行与 journal

`run_loopx_turn_once()` 在 `executor.py` 约 1435 行。它是执行主线，不是“直接 Popen 一个 agent”。

### 5.1 先 fail closed

在动 journal、Host 或 quota 之前，先检查计划中的 executor 是否可启动。若 planned executor 不可用，返回失败，不留下半截副作用。

没有 `--execute` 时只返回 preview。真正执行要求 writeback、spend、scheduler 回调齐全，否则直接报错。

### 5.2 journal 是恢复账本

每个 Turn 按 `turn_key` 打开 journal 并加独占文件锁。journal 记录：

- plan 与 turn identity；
- host 调用状态；
- host result；
- `completed_phases`；
- 每一步 receipt / checkpoint；
- recovery audit；
- terminal closeout 状态。

`completed_phases` 必须始终是七阶段的**有序前缀**。例如：

```text
["host_execute", "typed_result", "validation"]
```

表示验证已完成，但 durable writeback 尚未确认。不能出现跳阶段或乱序。

### 5.3 先恢复，再决定是否重新调用 Host

如果 journal 已存在，`assess_existing_turn_recovery()` 会判断：

- 同一 Turn 已完成：返回 existing，不再次执行；
- 已有 Host 结果但结算未完成：复用结果，只补结算；
- 失败可重试且请求允许：按阶段清理并继续；
- 身份/会话不匹配：要求 typed recovery continuation，不能硬跑。

只有确实需要重新调用 Host 时才走 admission。这样可避免“恢复结算”被误当成“新一次自动执行”重复占预算或重复产生外部副作用。

### 5.4 Host 请求本身有硬边界

`build_loopx_turn_host_request()` 从计划构造 Host 请求；结果入口对字段、文本长度和 evidence 数量都有限制，例如总结果上限 `12_000` 字节、evidence 条目数限制等。

约束的目的不是节省几 KB，而是：

- 防止 Host 用超长自由文本替代结构化事实；
- 保证结果可投影、可验证、可恢复；
- 避免把私有原始材料直接塞进公共状态。

---

## 6. Host 结果：只有七阶段中的前两段

Host/Agent 返回 `result_kind`、`completed_phases`、evidence、summary 等。它完成的是：

```text
host_execute
typed_result
```

随后 LoopX 不是“相信结果”，而是进入验证与结算。

### 6.1 结果类型

`turn_contract_generated.py` 定义 12 种 `LoopXTurnResultKind`：

| 结果 | 含义 | 是否花配额 |
| --- | --- | --- |
| `validated_progress` | 有验证证据的推进，但未完成 | 可进入 material settlement |
| `validated_completion` | 验证后的 Todo 完成，必须有 continuation | 可进入 material settlement |
| `repair_required` | 需要修复控制面/执行环境 | 可进入 material settlement |
| `replan_required` | 当前路线失效，需要重规划 | 可进入 material settlement |
| `user_action_required` | 需要具体人工动作 | 不花 |
| `wait` | 有类型的等待 | 不花 |
| `iteration_failed` | 本轮迭代失败，无 typed continuation | 不花 |
| `host_failure` | Host 执行失败 | 不花 |
| `validation_failed` | 验证失败 | 不花 |
| `writeback_failed` | 写回失败 | 不花 |
| `quota_spend_failed` | 配额扣除失败 | 不花 |
| `terminal_closeout_failed` | 写回和配额已提交后，终局收尾失败 | 已花，不能当未花 |

`NO_SPEND_RESULT_KINDS` 排除了 `terminal_closeout_failed`。这是刻意的：该失败发生时，前五个阶段已提交，恢复只能补 closeout，不能重复 writeback/spend。

### 6.2 完成结果必须给出 continuation

`validated_completion` 不能只说“做完了”。它必须有选中 Todo，并声明：

- `successor`：产生后继 Todo，需给出 successor ids；
- `active_goal`：目标仍活跃，下一轮从新 frontier 继续；
- `no_followup`：没有后继工作，可以进入终局检查。

这防止局部任务完成被误当成整个 Goal 完成。

### 6.3 验证阶段

验证后会加入第三个阶段：

```text
host_execute → typed_result → validation
```

如果验证失败，结果通常是 `validation_failed`。某些失败阶段允许重新调用 Host 取得新结果；但这是受 journal 和阶段状态约束的恢复，不是任意重试。

---

## 7. 结算：从验证到 durable effect

`execute_turn_driver_settlement()` 在 `settlement.py` 约 428 行。它接收 transaction plan、已完成阶段、writeback/spend/closeout payload 和 effect 回调，逐步推进。

完整七阶段来自 `turn_transaction_contract.json`：

```text
1. host_execute
2. typed_result
3. validation
4. durable_writeback
5. quota_spend
6. scheduler_apply
7. scheduler_ack
```

另外，`terminal_closeout` 是完成型 Turn 的额外 provider effect。它发生在写回和 spend 之后、最终 scheduler 关闭之前；失败会返回 `terminal_closeout_failed`。

### 7.1 为什么写回在 spend 前

先写回，才能证明“有被接受的状态变化”；再花配额，才能把预算和实际交付绑定。

反过来，如果先 spend 再写回，一次写回失败就会留下“花了钱但没有状态变化”的坏账。LoopX 因此明确规定：

- material result 必须先完成 validation 才能写回；
- 必须先完成 durable writeback 才能 spend；
- stop/failure 类型不能 spend；
- 只有持久化 checkpoint 才能推进下一个 provider effect。

### 7.2 每一步的幂等合同

结算不假设进程永不崩溃。每次外部 effect 都带稳定 effect reference：

```text
effect_id + step_kind + turn identity
```

恢复时：

- journal 说已提交的 effect：不重做；
- 外部已有 readback 但本地未 checkpoint：先读取证明，再决定是否 checkpoint；
- 状态不确定：返回 typed failure，要求 repair，而不是猜测成功；
- 已 spend、已写回但 closeout 失败：只重试 closeout。

因此，**idempotency 不是“工具自己支持重试”就够了**，而是控制面必须知道每个阶段的提交事实。

### 7.3 scheduler apply / ack

最后两个阶段把“这一轮结束后的唤醒/停止状态”落到调度侧：

- `scheduler_apply`：把 scheduler hint 或后续运行安排写入；
- `scheduler_ack`：确认调度侧确实接受。

有配额和调度的系统最容易犯的错，是把“我调用了 scheduler API”当成“scheduler 已接受”。LoopX 分开 apply 和 ack，就是为了保留这个确认边界。

---

## 8. 终态与恢复：四个典型场景

### 场景 A：`wait`

Host 观察后判断外部证据还没到，返回 `wait`。

```text
host_execute ✓
typed_result ✓
validation ✓
durable_writeback ?（typed wait 通常不提交 material state）
quota_spend ✗
scheduler_apply/ack 按合同处理
```

这不是失败，也不应消耗交付配额。下一轮按 monitor/backoff 再次观察。

### 场景 B：写回成功，spend 失败

journal 已记录 durable writeback，spend 无确认。恢复时：

- 不能重做写回；
- 必须先检查 spend readback 或失败原因；
- 若 spend 确实未发生，再提交 spend；
- 绝不能把整轮从头重跑。

### 场景 C：写回和 spend 都成功，closeout 失败

结果是 `terminal_closeout_failed`：

```text
completed_phases = 前五个阶段
failed_phase = terminal_closeout
```

恢复只补 terminal closeout，不重复写回和 spend。`docs/architecture.md` 明确要求不能把该失败当成“未 spend”。

### 场景 D：Host 执行到一半崩溃

journal 可能只有 `host_execute` 的部分证据，甚至没有 typed result。恢复策略取决于：

- 是否有 host result / session recovery record；
- 是否可安全重试；
- admission 是否允许新 host attempt；
- 旧 Turn 是否已绑定到同一 Todo / agent / turn instance。

无法证明的状态必须 fail closed，而不是通过“再跑一次”碰运气。

---

## 9. 设计取舍

### 取舍 1：控制面复杂，Host 简单

LoopX 把身份、配额、阶段、journal、receipt 都放进 Kernel，Host 只需执行有界工作并按合同回报。这增加了合同和适配成本，但让不同 Host 共享同一可靠性。

### 取舍 2：严格类型胜过自由文本

领域结果必须 typed；文本只能作摘要和解释。这损失了一些表达自由度，换来可验证、可重放、可投影。

### 取舍 3：恢复优先于“自动重试”

遇到不确定状态时，系统先审计已有事实，再决定补哪一步。它可能显得慢，但能避免重复不可逆外部动作。

### 取舍 4：状态投影有界

Agent 不应一次拿到整个历史。`status`、`history`、`should-run` 都提供 compact projection；需要更多事实时，再走 typed discovery route。这控制上下文成本，但不允许投影悄悄获得 canonical authority。

---

## 10. 常见误解

| 误解 | 事实 |
| --- | --- |
| “Host 返回 success，Turn 就成功了。” | Host 只完成前两阶段，后面还有验证、写回、spend、scheduler。 |
| “`should_run=false` 就是系统闲着。” | 可能在等待、门禁、限流或需要修复，恢复动作不同。 |
| “Todo 完成就等于 Goal 完成。” | 还要检查 successor、monitor、acceptance、terminal audit。 |
| “返回 `terminal_closeout_failed` 说明本轮没花钱。” | 写回和 spend 已提交，恢复不能重做。 |
| “恢复就是重跑同一条命令。” | 先读 journal/receipt；已提交 effect 必须跳过。 |
| “推荐动作就是白名单。” | 它只是 steering；真实边界在 typed authority/transition。 |

---

## 11. 自测与练习

### 自测

1. 为什么 `build_loopx_turn_plan()` 必须无副作用？
2. `turn_key` 与 `todo_id` 分别解决什么问题？
3. 如果一个 Turn 的 `completed_phases` 是 `["host_execute","typed_result","validation","durable_writeback"]`，下一个合法阶段是什么？
4. 为什么 `quota_spend` 不能排在 `durable_writeback` 前面？
5. `terminal_closeout_failed` 与 `writeback_failed` 的恢复差异是什么？

### 练习

画一张状态图，节点是七阶段，边是“成功 checkpoint”和“typed failure”。然后加入：

- writeback readback 已存在但 journal 未记录；
- spend 成功但本地 journal 未记录；
- terminal closeout 失败。

对每个场景写出“哪些步骤可重试、哪些绝不能重做、需要哪个 readback”。如果你能把这张图讲清楚，就已经掌握 LoopX Turn 的核心。

---

### 自测参考答案

1. 因为计划会被 Preview、调试、Host 预检和测试反复读取。只要它顺手写状态、扣配额或发 scheduler 消息，就无法安全重放，也会让“看一眼计划”产生副作用。计划必须明确输出 `effects=false`，真正执行只能进入 `turn run-once`。
2. `todo_id` 标识“哪张工作卡”，一张卡可以经历多次 Turn/重试；`turn_key` 标识“哪一次执行及其结算上下文”，把 Goal、Agent、Todo、Host、session 与 settlement identity 绑成一个 canonical hash。后续 Host result、journal、writeback、spend 必须与同一个 `turn_key` 对齐。
3. 下一个合法阶段是 **`quota_spend`**。`completed_phases` 必须是有序前缀；已有前四段表示状态已 durable writeback，但预算尚未提交。
4. 先 writeback，才能证明“有被接受的状态变化”；再 spend，才能把配额扣减绑定到真实交付。反过来先 spend，一旦 writeback 失败，就会出现“已扣费但没有 durable 结果”的不确定状态，恢复时既不能安全退款，也不能安全重扣。
5. `terminal_closeout_failed` 表示前五阶段（含 writeback 和 spend）已经提交，只剩 terminal closeout；恢复只能补 closeout，绝不能重跑 Host、writeback 或 spend。`writeback_failed` 表示状态还没被确认提交：应复用已验证的 typed result 重试 writeback，仍不应重跑 Host；若 readback 发现 writeback 其实已存在，则按已提交处理并跳过。

### 练习参考答案

七阶段状态图可压缩成下面这张表：

```text
host_execute → typed_result → validation
             → durable_writeback → quota_spend
             → scheduler_apply → scheduler_ack
                              └→ terminal_closeout（完成型 Turn 的额外 effect）
```

每条成功边先写 checkpoint，再进入下一阶段；typed failure 只能把恢复点放到失败阶段，不能跳到更后面。三个特殊场景：

| 场景 | 先做什么 readback | 可以重试 | 绝不能重做 |
| --- | --- | --- | --- |
| writeback readback 已存在、journal 未记录 | 读 canonical authority/写回 receipt，确认该 effect 是否已提交 | journal 标记 `durable_writeback`，然后从 `quota_spend` 继续 | 重跑 Host、重复 writeback |
| spend 成功、本地 journal 未记录 | 读 quota ledger/spend receipt，确认 slot 已扣 | 只补 journal/checkpoint，再从 `scheduler_apply` 继续 | 再次 spend、重跑 Host |
| terminal closeout 失败 | 读 closeout receipt 与已完成阶段 | 只重试 closeout | 重做 writeback、spend、Host |

讲清楚这张图的标志是：你能指出**事实源、幂等身份、恢复入口**，而不是只会说“失败了就再跑一遍”。

*下一章：`core-mechanisms.md`，把 Goal、Todo、Claim、Gate、Quota、Evidence、Projection 和扩展边界拆开。*
