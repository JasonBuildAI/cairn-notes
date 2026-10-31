---
title: "阶段 3：Turn 计划与事务"
description: "阶段 3：Turn 计划与事务。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：LoopX 源码课 · 阶段卷
> 前置：阶段 2，理解 should-run
> 对应总览：`turn-lifecycle.md`
> 本阶段目标：看清一次 Turn 的 identity、envelope、七阶段与结算计划。

## 1. 本阶段解决什么

准入只回答“可以开始”。Turn 计划要回答更硬的合同问题：

- 这到底是哪一次 Turn？
- 它绑定哪个 Goal/Todo/agent/session？
- Host 最多看到多少上下文？
- 完成后按什么顺序验证、写回、消费和调度？
- 崩溃后从哪个前缀继续，哪些 effect 不能重做？

## 2. 先记住一个判断

**Turn 不是一次函数调用，而是一份可持久化、可恢复、带幂等身份的合同。**

Plan 一旦建立，后续层不应各自重新解释“这轮要做什么”。Host、validation、writeback、spend 和 scheduler 都围绕同一个 identity 工作。

## 3. 源码主线

1. `loopx/control_plane/turn_driver/driver.py` 根据 route/Goal/Todo 组织 Turn 计划与可执行路径。
2. `transaction.py::build_loopx_turn_transaction_plan()` 计算 `turn_key`，生成阶段列表与 settlement plan。
3. `turn_transaction_contract.json` 是阶段顺序的事实源：`host_execute`、`typed_result`、`validation`、`durable_writeback`、`quota_spend`、`scheduler_apply`、`scheduler_ack`。
4. `effect_program.py::TURN_TRANSACTION_PHASES` 从合同加载阶段，`SettlementStepKind` 定义 provider 级结算动作。
5. `quota/turn_envelope.py` 组装本轮 envelope，`turn_envelope_budget.ts` 负责字节预算与超限诊断。
6. `turn_driver/executor.py` 在执行时只接受与计划一致的 `turn_key`。

## 4. 关键对象与合同

| 对象 | 作用 | 关键不变量 |
| --- | --- | --- |
| `turn_key` | Turn 的规范哈希身份 | 同 lineage/host/mode/scheduler/session 输入稳定 |
| `turn_instance_id` | 需要时区分具体实例 | 归一化后可替代默认 turn_key 用于绑定 |
| `turn_envelope` | Host 可见的本轮上下文 | 有界、可测量、字段属于当前决策 |
| `transaction.phases` | 结算阶段顺序 | 只能按前缀推进 |
| `commit_policy` | 提交因果 | `result<validate<writeback<spend;apply<ack` |
| `settlement_plan` | provider 结算步骤 | validation 由 turn_driver 拥有，非 provider effect |
| `receipt_seed` | 初始 receipt | `not_executed`，并指向第一阶段 |

### 为什么 turn_key 要规范哈希

如果把时间戳、随机 UUID 或自然语言摘要放进 identity，重启后同一轮会被算成新 Turn，writeback 和 spend 就可能重复。源码用规范化字段和 canonical JSON/SHA-256 生成稳定 key，业务随机性只放在显式的 `turn_instance_id`。

### 为什么 envelope 是有预算的

Host 的上下文不是越多越好。Envelope 需要带 route、selected Todo、gate、evidence 要求、resume 条件和输出合同；超出预算会挤压真正的任务信息。所以预算首先保护“本轮合同”，再容纳解释性投影。

## 5. 一条可观察链路

```text
should-run payload
  → route 与 selected Todo
  → lineage / host / execution_mode / session_action
  → turn_key
  → turn_envelope（预算内投影）
  → transaction phases + settlement_plan
  → receipt_seed
  → host request
```

调试时先打印 `turn_key`，再看 `transaction.phases` 和 `receipt_seed.next_phase`。如果三者对不上，不要继续执行。

## 6. 实验

### 实验 A：比较两个计划的 turn_key

用相同 lineage/host/mode/session 构造两次计划，确认 `turn_key` 相同；只改变 `session_action` 或 host，确认变化。

### 实验 B：观察阶段顺序

```powershell
Get-Content loopx\control_plane\turn_transaction_contract.json
rg -n "commit_policy|effect_ref|settlement_plan" loopx\control_plane\turn_driver\transaction.py
```

验收点：能逐字写出七阶段与 `result<validate<writeback<spend;apply<ack;cadence:no-spend`。

### 实验 C：制造 envelope 超限

在测试中注入大段可重算说明，触发 `turn_envelope_budget_exceeded`。参考观察：系统报告 warning/excess，而不是悄悄删掉 identity 或结算字段。

### 实验参考答案

1. 相同 lineage/host/mode/session 应得到相同 turn_key；改变 session_action 或 host 会改变身份，避免不同事务复用同一 key。
2. 七阶段与顺序应能逐字写出：`result < validate < writeback < spend; apply < ack; cadence: no-spend`。
3. envelope 超限只报告 warning/excess，identity、receipt、settlement 字段不能被静默删除。

## 7. 失败与恢复

| 失败 | 根因 | 恢复 |
| --- | --- | --- |
| turn_key 与计划不一致 | identity 被重建/字段漂移 | 拒绝执行，回到计划生成 |
| receipt 找不到计划 | 计划未持久化或版本不符 | 不补造 receipt；修持久化边界 |
| 阶段跳跃 | 调用方跳过前置 | 只允许已完成前缀后的下一阶段 |
| envelope 超限 | 投影过多 | 缩减非合同字段，重算预算 |
| effect_ref 为空 | identity 不完整 | 阻止 provider 执行，先修 identity |
| 重启后生成新 key | 随机字段进了 hydration | 把随机性移到 turn_instance_id |

## 8. 通关自测

1. `turn_key` 与 `turn_instance_id` 有什么区别？
2. 七阶段分别是什么？
3. 为什么 `commit_policy` 不是普通注释？
4. 为什么 validation 不属于 Provider effect？
5. envelope 超预算时为什么不能直接删字段？
6. receipt_seed 为什么从 `not_executed` 开始？

### 参考答案

1. `turn_key` 由稳定的 lineage/host/mode/scheduler/session 等身份计算，默认代表一次逻辑 Turn；`turn_instance_id` 是显式实例身份，用于需要区分多次实例时稳定绑定，不能把随机数偷偷塞进 turn_key。
2. `host_execute → typed_result → validation → durable_writeback → quota_spend → scheduler_apply → scheduler_ack`；完成型 Turn 还可能追加 terminal closeout provider effect。
3. 它规定可观察的提交顺序：结果先出现，验证后才允许写回，写回后才消费，apply 后才 ack；代码、测试和恢复都依赖这个顺序。
4. validation 由 turn_driver 根据 typed result、证据和领域合同独立完成，不是 Provider 自己声明的副作用。Provider 只能提供写回、消费和 closeout 等 effect。
5. 字段可能承载 identity、route、gate、receipt binding 或恢复条件。正确做法是按投影优先级压缩可重算内容，并保留合同字段。
6. 它表示计划已建立但尚未执行；后续每个 checkpoint 只能沿已完成阶段推进，不能声称某阶段已提交。

## 9. 源码坐标

- `loopx/control_plane/turn_driver/driver.py`
- `loopx/control_plane/turn_driver/transaction.py`
- `loopx/control_plane/turn_transaction_contract.json`
- `loopx/control_plane/effect_program.py`
- `loopx/control_plane/quota/turn_envelope.py`
- `loopx/control_plane/quota/turn_envelope_budget.ts`
- `loopx/control_plane/turn_driver/executor.py`

## 10. 下一步

进入阶段 4：计划里写着 Host 与 Capability，它们各自能做什么、不能做什么？typed result 又怎样变成可验证结果？
