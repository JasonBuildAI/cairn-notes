---
title: "阶段 6：上下文投影与长期状态"
description: "阶段 6：上下文投影与长期状态。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：LoopX 源码课 · 阶段卷
> 前置：阶段 5，理解写回、消费与调度
> 对应总览：`02-核心机制.md` 的上下文与状态部分
> 本阶段目标：区分 canonical facts、read models 与 Host context，理解 refresh/frontier 的作用。

## 1. 本阶段解决什么

LoopX 不把长期记忆塞进聊天 transcript。它保存 Goal、Todo、claim、gate、quota、authority、evidence 与 run history，再在每轮重新生成：

- 人看的 Status / Dashboard；
- Agent 看的 next action / attention；
- Host 看的 turn envelope；
- scheduler 看的 cadence/ownership；
- 验收看的 evidence/frontier。

同一条事实可以有多个投影，但投影不能反过来成为唯一事实源。

## 2. 先记住一个判断

**事实可恢复，投影可重算；投影缺失不是数据丢失，投影覆盖事实才是事故。**

因此遇到“Status 显示完成但 Goal 没完成”时，先查 canonical state 和 receipt，不要直接改 Status。

## 3. 源码主线

1. `registry.py` 读取 Goal、Agent、authority 等注册事实。
2. `control_plane/goals/state_resolution.py` 与 `goal_frontier/` 计算当前目标前沿。
3. `control_plane/todos/contract.py` 定义 Todo 的 scope、依赖、任务类别和继续条件。
4. `control_plane/goals/acceptance.py` 用冻结的 acceptance basis 执行验收。
5. `control_plane/runtime/run_history.py` 保存每轮运行事实；`state_refresh.py::refresh_state_run()` 在结算后重建投影。
6. `status.py::collect_status()` 生成读模型；`capability_hooks.py::project_turn_context()` 生成 Host 上下文投影。
7. `quota/turn_envelope.py` 再把上下文压进有字节预算的合同包。

## 4. 关键对象与合同

| 层 | 典型对象 | 生命周期 | 能否重算 |
| --- | --- | --- | --- |
| canonical fact | Goal state、Todo、claim、gate、quota、evidence、run receipt | 长 | 否，必须恢复 |
| derived index | frontier、attention queue、next action | 中 | 是 |
| human projection | Status、Kanban、Dashboard markdown/HTML | 短 | 是 |
| Host projection | turn envelope、Host prompt、selected context | 单轮 | 是 |
| acceptance basis | 冻结的验收规则与快照 | 一次验收 | 不应被投影漂移改写 |

### 为什么 completion 不能只看 Status

Status 可能延迟、被筛选、按权限裁剪，或由旧版本规则生成。真正的 completion 需要 typed result、validation、durable writeback、quota spend 与 lifecycle receipt。Status 只能帮助定位，不能证明提交。

### 为什么 frontier 要重算

一轮 progress 可能新增依赖、关闭分支、使后继可执行，或触发 replan。frontier 是“基于当前事实，下一步可选什么”的投影，必须在写回后重新计算，而不是沿用上一轮列表。

### 为什么 acceptance 要冻结 basis

如果验收标准在运行过程中被移动，Agent 可以通过改标准而不是改结果来“完成”。冻结 basis、记录 digest/revision，再把观察结果写回，才能让验收可复现。

## 5. 一条可观察链路

```text
registry + goal state + todos + receipts
  → resolve_goal_state / frontier
  → acceptance basis（若需验收）
  → run history
  → state_refresh
  → status / attention / next actions
  → capability_hooks.project_turn_context
  → quota turn envelope
  → Host
```

如果一个字段同时出现在 Status 和 envelope，追查它从哪个 canonical object 来，而不是从另一个投影复制。

## 6. 实验

### 实验 A：只改投影

修改一份 Status markdown，不动 Goal state。参考验收：下一次 `refresh-state` 后显示回到事实；这说明投影不是事实源。

### 实验 B：观察 frontier 变化

让一轮 progress 关闭一个 Todo 并新增后继。参考验收：写回后 frontier 重算，新的 next action 出现；旧 next action 不能靠缓存继续使用。

### 实验 C：冻结验收 basis

记录 acceptance 的 digest/revision，再尝试改配置。参考验收：本次验收仍使用冻结 basis；新配置只在合法的新 revision 中生效。

### 实验参考答案

1. 手工改 Status 不是事实修改；下一次 refresh 会从 canonical state 重算并覆盖。
2. frontier 应由本轮写回后的 canonical 依赖关系重算；旧 next action 若与新 frontier 冲突，必须失效。
3. 验收应使用冻结的 basis digest/revision；配置变化只能在新 revision 中生效，不能追溯改写当前验收。

## 7. 失败与恢复

| 现象 | 事实源 | 恢复 |
| --- | --- | --- |
| Status 与 Goal 不一致 | registry/state/receipts | 重算投影，不手改状态 |
| next action 指向已关闭 Todo | frontier 重算 | 刷新并重新过准入 |
| Host 看不到关键证据 | context projection/envelope | 检查投影规则与预算，不改写 canonical |
| 验收标准漂移 | acceptance basis | 使用冻结 revision，重新执行验收 |
| run history 缺一轮 | journal/receipt | 从已提交阶段恢复，不补造历史 |
| memory 重复注入 | 投影去重与 scope | 去重，不删事实 |

## 8. 通关自测

1. Goal state、Status、turn envelope 三者的生命周期有什么不同？
2. 为什么不能通过修改 Status 来“修复”目标状态？
3. frontier 为什么必须在写回后重算？
4. acceptance 为什么需要冻结 basis 和 digest？
5. run history 与 Host 上下文是什么关系？
6. 当投影与事实冲突时，第一动作是什么？

### 参考答案

1. Goal state 是长期 canonical fact；Status 是可重算的人读投影；turn envelope 是单轮、有预算、面向 Host 的合同投影。三者不能互换。
2. Status 只是派生视图，修改它不会产生 validation、writeback 或 receipt。下一次刷新会回到 canonical 事实，还会制造“看起来修好但实际没有”的假象。
3. progress 可能改变 Todo 依赖、关闭分支或使后继就绪；completion 可能切换 active goal。只有基于写回后的状态重算，frontier 才反映下一步真实可做什么。
4. 验收规则若可变，Agent 就能移动球门。冻结 basis、digest 与 revision 使验收观察可复现，并能证明使用的是哪一版标准。
5. run history 是事实与审计，Host 上下文是从事实、frontier 和能力要求投影出的有限视图。Host 不应直接读全量历史，也不能把历史摘要当 canonical state。
6. 先定位 canonical fact 与 receipt，确认哪个事实变了；再修投影规则并重算。不要先改展示层。

## 9. 源码坐标

- `loopx/registry.py`
- `loopx/control_plane/goals/state_resolution.py`
- `loopx/control_plane/goals/acceptance.py`
- `loopx/control_plane/goals/goal_frontier/`
- `loopx/control_plane/todos/contract.py`
- `loopx/control_plane/runtime/run_history.py`
- `loopx/state_refresh.py`
- `loopx/status.py`
- `loopx/control_plane/capability_hooks.py`

## 10. 下一步

进入阶段 7：同一套事实和投影，怎样被 CLI、Dashboard、Goal Mode 与扩展 Host 共同使用？
