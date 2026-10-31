---
title: "LoopX 2.1.1 源码课 · 导读"
description: "LoopX 2.1.1 源码课导读：控制面定位、七块职责、阅读顺序与核心边界。"
---

:::note[独立学习笔记]
这是基于 [LoopX](https://github.com/loopx-project/loopx) 版本 v2.1.1（提交 87e5b4f8）源码与公开文档整理的独立学习笔记，不是官方文档。本站不包含上游源码；下文以 $LOOPX_SRC 表示你自己的本地源码目录。
:::

> 基线：`loopx-2.1.1`，Git tag `v2.1.1`，提交 `87e5b4f88d207adf062eea57002cda6fe04fd535`（2026-10-23）。
> 本文路径相对 `$LOOPX_SRC`。
> 旧版讲义不在本仓库中；本课只以 v2.1.1 源码为准，旧版结论不再作为依据。

## 一句话理解 LoopX

**LoopX 不是另一个 Agent 运行时，而是长程 Agent 的“控制面”：它把目标、Todo、领取权、门禁、配额、证据和恢复状态保存在模型上下文之外，再把当前状态编译成一次有界、可验证、可写回的 Turn。**

模型仍然由 Codex、Claude Code 等 Host 提供；工具仍由 Host 或 Capability 执行。LoopX 关心的不是“这一轮模型怎么想”，而是：

- 这一轮到底该不该运行；
- 谁有权运行、运行哪张 Todo；
- 外部动作是否真的发生；
- 哪些结果可以写回长期状态；
- 写回和花配额之后若崩溃，下一轮如何不重复副作用。

把它想成一张“可执行的长期看板”：

```text
Goal / Issue / 外部事件
          │
          ▼
Registry + Goal State + Run History（事实与历史）
          │
          ▼
Status / Attention Queue（投影：现在谁该行动）
          │
          ▼
Quota should-run（是否运行、运行什么、是否花配额）
          │
          ▼
Turn Envelope + Transaction Plan（本轮合同）
          │
          ▼
Host（模型 + 工具执行一次有界工作）
          │
          ▼
Capability / Provider（领域规则、外部调用、readback）
          │
          ▼
Validation → durable writeback → quota spend → scheduler
          │
          └──────── 重新计算下一轮 frontier
```

## 七块总表

| 部件 | 要回答的问题 | LoopX 的答案 | 主要源码 |
| --- | --- | --- | --- |
| 循环 | 目标怎样跨很多轮持续推进？ | `quota should-run` 选动作，Turn 执行一次，结算后重算 frontier | `loopx/control_plane/quota/`、`turn_driver/` |
| 上下文 | 模型不记事，长期事实放哪里？ | Registry、Goal State、Authority、Run History、Todo/Event；每次重新投影 | `loopx/registry.py`、`state_refresh.py`、`run_history.py` |
| 工具 | 谁真正操作外部世界？ | Host 提供模型和工具；Capability 定规则，Provider 做调用与 readback | `loopx/capabilities/`、`loopx/extensions/` |
| 模型接入 | 怎样不绑定某一家模型？ | 模型在外部 Agent Host 中；LoopX 只使用 host-neutral 合同 | `turn_driver/driver.py`、各 goal-mode adapter |
| 扩展 | 新业务怎样接入而不改内核？ | Capability、Provider、Extension、Host adapter 分层注册 | `capability_registry`、`extensions/`、`*_goal_mode/` |
| 界面 | 人、脚本、Heartbeat 怎样使用同一控制面？ | CLI + JSON 投影；Dashboard/IM 只是读模型消费者 | `loopx/cli.py`、`status.py`、`presentation/` |
| 工程 | 崩溃、重试、并发下怎样不重复副作用？ | 类型化合同、有序阶段、Turn journal、幂等 receipt、恢复审计 | `turn_driver/transaction.py`、`executor.py`、`settlement.py` |

三条纵线贯穿始终：

1. **事实归属**：canonical state 才是事实，Status/Kanban/prompt 都是 projection。
2. **权限边界**：claim、lease、gate、quota、workspace/capability 是硬边界；推荐动作只是 steering。
3. **副作用边界**：观察不等于推进，收到外部回执也不等于内核接受；必须先验证，再写回、花配额和调度。

## 阅读顺序

| 顺序 | 文档 | 你会得到什么 |
| --- | --- | --- |
| 0 | [全局地图](overview/) | 产品定位、七块、六层状态、四类运行时责任、目录与术语 |
| 1 | [一次 Turn 的一生](turn-lifecycle/) | 从 `should-run` 到 Host、七阶段结算和恢复的完整主线 |
| 2 | [核心机制](core-mechanisms/) | Goal/Todo/Claim/Gate/Quota/Evidence/Projection、上下文与扩展 |
| 3 | [工程实战](engineering/) | 调试路径、源码实验、失败矩阵、修改内核对齐与毕业练习 |

## 阶段课（源码深入）

总览之后，按 [阶段导读](learning-path/) 从阶段 0 走到阶段 9。`00`～`03` 负责建立全局与机制直觉；阶段卷沿真实源码拆开 ownership、状态迁移、失败恢复和可观察实验，每篇自测与练习均附参考答案。

## 推荐读法

- **第一遍只抓一条线**：`quota should-run → build_loopx_turn_plan → run_loopx_turn_once → execute_turn_driver_settlement → refresh-state`。
- **第二遍追问三个归属**：这个字段的事实源是谁？谁有资格修改？失败后哪个 journal/receipt 能证明已经做到哪一步？
- **第三遍做最小实验**：读一份 should-run JSON，画七阶段；故意构造一个“已写回但未 spend”的恢复场景，解释为什么不能重做写回。

## 最容易混淆的五件事

1. **LoopX 不是 Agent framework**：它不实现模型循环、上下文窗口或工具协议；这些属于 Host。它实现的是跨 Turn 的目标与状态治理。
2. **Todo 不是聊天待办**：Todo 有稳定身份、scope、依赖、claim/lease、证据和 continuation；勾选完成不能替代 accepted writeback。
3. **Status 不是事实源**：`collect_status()` 和 attention queue 是从 Registry、State、History 和 contract health 派生出来的读模型。
4. **Quota 不只是“次数限制”**：它同时表达健康阻断、人工门禁、focus wait、外部等待、可运行、限流和硬暂停；`should_run=false` 可能意味着完全不同的恢复路径。
5. **收到回执不等于事务完成**：Host 只完成 `host_execute` 与 `typed_result`；验证、写回、spend、scheduler apply/ack 仍要逐阶段推进。

## 学习完成标准

读完后应能不看文档回答：

- 为什么长程状态不能只放在 transcript 里？
- 一次 Turn 的七个阶段是什么，为什么 `quota_spend` 必须在 `durable_writeback` 之后？
- `validated_progress`、`validated_completion`、`wait`、`host_failure` 分别如何影响下一轮？
- 当 `terminal_closeout_failed` 发生时，哪些 effect 已提交、恢复时哪些绝不能重做？
- Claim、Gate、Quota、Capability 和 Workspace guard 各自限制什么？
- 为什么“推荐动作”不能悄悄缩小 Agent 的合法选择空间？

### 学习完成标准参考答案

1. **因为 transcript 只是模型工作副本，不是长期事实源。** 它会压缩、截断、换模型、换会话，甚至被摘要改写；LoopX 的 Goal、Todo、claim/lease、gate、quota、authority、evidence 和 run history 必须活在模型上下文之外，才能在进程崩溃、Host 切换和长程暂停后重建当前 frontier，并判断哪些动作合法、哪些 effect 已提交。
2. **七阶段是** `host_execute → typed_result → validation → durable_writeback → quota_spend → scheduler_apply → scheduler_ack`；完成型 Turn 另有 `terminal_closeout` 这个 provider effect。**先 writeback 再 spend**，是因为只有写回被接受，才存在可证明的交付；先扣配额再写回失败会留下“花了钱但没有状态变化”的坏账，恢复时既不能安全退款，也不能安全重扣。
3. **`validated_progress`** 表示有证据的推进但未完成，进入 material settlement 后下一轮继续看新的 frontier；**`validated_completion`** 必须声明 `successor`、`active_goal` 或 `no_followup`，据此关闭 Todo、安排后继或进入终局；**`wait`** 不花配额，保存有类型的 resume condition，下一轮按 monitor/backoff 再观察；**`host_failure`** 不花配额，也不得写成成功，下一轮按策略修 Host、重试或等待，且只能在证据允许时重新进入 Host。
4. **发生 `terminal_closeout_failed` 时，前五阶段已经提交**：Host 执行、typed result、validation、durable writeback 和 quota spend 都已有事实；缺的是终局 closeout；恢复时先读 closeout receipt/已完成阶段，**只补 closeout；绝不能重跑 Host、重复 writeback 或再次 spend。**
5. **Claim** 限定“谁负责哪张 Todo、在什么 scope 和期限内”，不是 Goal 所有权；**Gate** 限定前置事实、人工决定、边界或验收是否满足，只阻断对应动作；**Quota** 限定当前是否允许运行和花费，区分 health、operator、focus、waiting、throttle、paused；**Capability** 定义领域成功条件、证据、typed transition 和错误分类，不能直接写 Kernel 私有状态；**Workspace guard** 限定可读写的 repo/path/environment，防止跨项目、破坏性或生产副作用。
6. **因为推荐动作是 steering，不是权限白名单。** 如果 `next_cli_actions` 悄悄成为“唯一合法集合”，Agent 会失去当前 authoritative/eligible 但未被推荐的合法路径，行为还会依赖某个投影；反过来，任何被推荐的动作也必须重新过 typed authority、preflight、receipt binding、validation 和 settlement。真正必须拒绝的动作应写成硬边界并返回明确 typed error，而不是靠“不推荐”来暗示。

---

*基于 LoopX v2.1.1 源码编写 · 2026-10-31*
