---
title: "阶段 5：验证、写回、配额与调度"
description: "阶段 5：验证、写回、配额与调度。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：LoopX 源码课 · 阶段卷
> 前置：阶段 4，理解 Capability、Provider 与 Host result
> 对应总览：`turn-lifecycle.md` 的结算部分
> 本阶段目标：掌握 result kind、commit order、terminal closeout 和崩溃后的前缀恢复。

## 1. 本阶段解决什么

Host 返回结果后，系统面临一串不能合并的问题：

- 这个结果有没有证据，能不能进入长期状态？
- 若能，先写状态还是先扣配额？
- 写的状态是否包括 Todo 生命周期、后继目标或终局关闭？
- scheduler 的 RRULE 要 apply 到哪一步，什么时候 ack？
- 中途崩溃时，下一轮从哪个阶段继续？

LoopX 的答案是七阶段事务，而不是“把所有副作用塞进一个 try”。

## 2. 先记住一个判断

**Host 执行与 typed result 只是前半段；只有 validation + writeback + spend 都提交，Turn 才有可证明的交付。**

`quota_spend` 位于 `durable_writeback` 之后，是因为花钱必须由一个已被接受的状态变化来证明；反过来先扣费再写回失败，会留下无法安全退款或重扣的坏账。

## 3. 源码主线

1. `transaction.py` 定义阶段顺序、material/no-spend result 集合和失败阶段映射。
2. `executor.py::_task_validation_stage()` 检查 result 与证据，决定进入 material settlement 还是停止。
3. `settlement.py::execute_turn_driver_settlement()` 依次执行 validation、durable writeback、quota spend 和 terminal closeout。
4. `quota/spend_commit.py` 用 run-index CAS 与 `effect_ref` 保证消费不重复。
5. `executor.py` 在 spend 后调用 scheduler callback，完成 apply/ack 或留下待恢复动作。
6. `terminal_closeout_requirement()` 判断 completion 是否要求关闭 Goal/Todo/scheduler。

## 4. 关键对象与合同

### result kind 的三组

| 组 | 类型 | 语义 |
| --- | --- | --- |
| material | `validated_progress`、`validated_completion`、`repair_required`、`replan_required` | 有受控状态变化，需要结算 |
| no-spend | `user_action_required`、`wait`、`iteration_failed`、`host_failure`、`validation_failed`、`writeback_failed`、`quota_spend_failed` | 不消费配额，也不能伪装成功 |
| 终局失败 | `terminal_closeout_failed` | 前五阶段已提交，只缺 closeout |

`validated_progress` 表示有证据但未完成，结算后重算 frontier；`validated_completion` 必须声明 successor、active goal 或 `no_followup`，并可能需要 lifecycle adapter。

### 提交顺序

```text
host_execute
  < typed_result
  < validation
  < durable_writeback
  < quota_spend
  < scheduler_apply
  < scheduler_ack
```

分号之外还有 cadence 语义：`apply<ack; cadence:no-spend`。调度 cadence 不能伪造一次消费，ack 也不能越过已经应用的 RRULE。

### 关键对象

| 对象 | 事实 | 恢复用途 |
| --- | --- | --- |
| `effect_ref` | 本次外部 effect 的稳定引用 | 重放和去重 |
| `completed_phases` | 已提交阶段的有序前缀 | 决定从哪继续 |
| `quota_spend` receipt | 哪次消费已提交 | 防止二次扣费 |
| scheduler receipt | apply/ack 做到了哪里 | 避免重复改 cadence |
| terminal closeout receipt | 终局是否已关闭 | 只补缺的 closeout |
| recovery decision | 允许继续还是阻断 | 保留审计和拒绝原因 |

## 5. 一条可观察链路

```text
typed result
  → validation（证据/scope/transition）
  → durable writeback（状态 + lifecycle）
  → quota spend（effect_ref + run-index CAS）
  → scheduler apply（RRULE/ownership）
  → scheduler ack（确认已应用）
  → terminal closeout（仅 completion + no_followup）
  → refresh-state
```

调试时把 journal 的 `completed_phases` 当作唯一进度尺。不要根据“日志看起来跑完了”推定为已提交。

## 6. 实验

### 实验 A：比较 progress 与 completion

构造两份 typed result：一份 `validated_progress`，一份带 lifecycle adapter 的 `validated_completion`。参考验收：前者写回后继续 frontier，后者进入 closeout 判断；缺少后继/intent 的 completion 被拒。

### 实验 B：在 writeback 后中断

在 journal 已记录 `durable_writeback`、尚未记录 `quota_spend` 时中断。参考验收：恢复只补 spend，不重跑 Host、不重复写回；`effect_ref` 保持同一值。

### 实验 C：在 spend 后中断

在 spend 已提交、scheduler apply/ack 未完成时中断。参考验收：恢复读取 spend receipt，只补调度阶段；绝不再次花配额。

### 实验 D：制造 closeout 失败

让 terminal closeout adapter 报错。参考验收：结果变成 `terminal_closeout_failed`，恢复只补 closeout，Host、writeback、spend 均不重做。

### 实验参考答案

1. progress 写回后继续 frontier；合法 completion 才进入 closeout。缺生命周期或后继的 completion 应被拒。
2. 恢复只补 `quota_spend`；Host 与 durable writeback 不重跑，`effect_ref` 保持一致。
3. 读取 spend receipt 后只补 scheduler apply/ack，绝不再次消费配额。
4. closeout 失败应成为 `terminal_closeout_failed`，恢复只补 closeout；Host、writeback、spend 均已完成，不能重做。

## 7. 失败与恢复

| 失败点 | 已提交事实 | 绝不能再做 |
| --- | --- | --- |
| validation 失败 | Host 执行、typed result | 不写回、不花配额 |
| writeback 失败 | 前三个阶段 | 不 spend，保留原 receipt 修复 |
| spend 冲突/失败 | 前四个阶段 | 不能改 effect_ref 重扣，先 readback |
| scheduler apply 失败 | 前五个阶段 | 不能重复写回或消费 |
| scheduler ack 失败 | apply 已完成 | 只补 ack，不回滚事实 |
| closeout 失败 | 前五阶段与调度 | 只补 closeout |
| journal 不一致 | 未知前缀 | 阻断并修 journal，不猜进度 |

## 8. 通关自测

1. 为什么 `validated_progress` 与 `validated_completion` 都要结算，但下一轮不同？
2. `quota_spend` 为什么必须排在 `durable_writeback` 后面？
3. `validated_completion` 缺 lifecycle adapter 时为什么不能自动降级？
4. `terminal_closeout_failed` 已在哪些阶段提交？恢复时能重跑 Host 吗？
5. scheduler apply 成功但 ack 失败时，恢复应做什么？
6. `no-spend` 结果为什么仍可能留下 journal？

### 参考答案

1. 两者都改变了被验证的长期状态，因此要写回和消费；progress 只推进未完成工作，下一轮重算 frontier 继续；completion 还要安排后继、切换 active goal 或 `no_followup`，并触发终局关闭。
2. 写回被接受后才存在可证明的交付。先消费再写回失败会留下“已扣费但无状态变化”的坏账；先写回让 spend 有明确的前置 receipt，也使恢复能判断该不该消费。
3. completion 会改变 Goal/Todo 生命周期，缺少 adapter 就无法确定谁接续、是否关闭或如何留痕。自动降级会伪造完成或让任务悬空，因此应 validation 失败并要求补齐合同。
4. 前五阶段（Host、typed result、validation、writeback、spend）以及已完成的调度都已有事实，只缺 closeout。恢复只能补 closeout，绝不能重跑 Host、重复 writeback 或再次 spend。
5. 读取 apply receipt，确认 RRULE 已落地，只补 ack。不能回滚 apply 再重复消费，也不能因为 ack 缺失就把整轮当未执行。
6. no-spend 只表示不扣配额，不代表没有过程事实。journal 仍要记录 Host 失败、验证失败或等待条件，用于诊断、去重和下一轮恢复。

## 9. 源码坐标

- `loopx/control_plane/turn_driver/transaction.py`
- `loopx/control_plane/turn_driver/executor.py`
- `loopx/control_plane/turn_driver/settlement.py`
- `loopx/control_plane/effect_program.py`
- `loopx/control_plane/quota/spend_commit.py`
- `loopx/control_plane/scheduler/arbitration.py`
- `loopx/control_plane/scheduler/heartbeat_commit.ts`
- `loopx/control_plane/scheduler/execution_context.py`

## 10. 下一步

进入阶段 6：结算后状态已经改变，下一轮模型看到的上下文从哪里重建？哪些是事实，哪些只是投影？
