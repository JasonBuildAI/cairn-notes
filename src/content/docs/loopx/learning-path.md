---
title: "LoopX 2.1.1 阶段课 · 导读"
description: "十个源码阶段的阅读顺序、阶段地图、建议节奏与通关标准。"
---

> 基线：`loopx-2.1.1`，Git tag `v2.1.1`，提交 `87e5b4f88d207adf062eea57002cda6fe04fd535`。
> 路径相对 `$LOOPX_SRC`。
> `00`～`03` 是总览；本组文档从阶段 0 走到阶段 9，按源码把同一条主脉络拆深。

## 一句话理解 LoopX

**LoopX 是一个长程 Agent 的控制面：它不替 Host 跑模型，而是决定“这一轮该不该运行、运行哪件事、结果能不能信、什么可以写回、写回后怎样安全结算，以及下一轮从哪里继续”。**

把 Host 想成工人，LoopX 想成工单、门禁、账本和质检台：

```text
Registry / Goal State / Todo / History      事实层
                 │
                 ▼
Status / Frontier / Attention Queue          投影层
                 │
                 ▼
Quota should-run                             准入层
                 │
                 ▼
Turn Envelope + Transaction Plan             合同层
                 │
                 ▼
Host（模型 + 工具，执行一次有界工作）        执行层
                 │
                 ▼
Typed Result → Validation                    证据层
                 │
                 ▼
Writeback → Spend → Apply/Ack → Closeout     结算层
                 │
                 └────────► refresh frontier
```

## 整门课的四幕

| 幕 | 阶段 | 要回答的问题 | 心智产物 |
| --- | --- | --- | --- |
| 第一幕：看清事实 | 0～1 | 谁是事实源？一次 Turn 在系统里是什么？ | 六层地图与对象所有权 |
| 第二幕：决定这一轮 | 2～3 | 为什么现在跑、跑哪张 Todo、合同里写了什么？ | should-run 与 Turn Plan |
| 第三幕：执行并验收 | 4～5 | Host 做了什么，怎样证明结果可写回？ | Capability、typed result、七阶段 |
| 第四幕：长期运转 | 6～9 | 上下文从哪里来，崩溃后怎样续，怎样扩展？ | 投影、恢复、工程化与毕业设计 |

这四幕不是四个独立模块。它们始终围绕一个问题：**模型上下文之外的长期事实，怎样被安全地编译成一次可执行、可验证、可恢复的 Turn。**

## 十个阶段

| 阶段 | 文档 | 你会得到什么 |
| --- | --- | --- |
| 0 | [环境与源码地图](../stage-0/) | 版本、目录、六层状态和最小阅读实验 |
| 1 | [对象模型与控制面](../stage-1/) | Goal、Todo、Claim、Gate、Run、投影各自拥有什么 |
| 2 | [ShouldRun 与 Quota](../stage-2/) | 为什么现在能跑/不能跑，false 的不同恢复路径 |
| 3 | [Turn 计划与事务](../stage-3/) | Turn Envelope、turn_key 与七阶段合同 |
| 4 | [Capability、Provider 与 Host](../stage-4/) | 领域能力、Provider 生命周期、Host 请求/结果 |
| 5 | [验证、写回、配额与调度](../stage-5/) | 结果分类、写回顺序、spend、apply/ack、closeout |
| 6 | [上下文投影与长期状态](../stage-6/) | 事实怎样变成模型可见的有限上下文 |
| 7 | [CLI、Dashboard 与扩展](../stage-7/) | CLI、Dashboard、Goal Mode、Capability 怎样复用内核 |
| 8 | [工程化、测试与恢复](../stage-8/) | 测试、导入边界、journal、失败恢复与故障排查 |
| 9 | [毕业设计](../stage-9/) | 设计一个可验证的新 Capability 并完成恢复演练 |

## 贯穿全课的三个判断

### 1. 事实与投影必须分开

Goal State、Todo、claim/lease、quota、authority、evidence、run history 是事实；Status、Kanban、prompt、next action 是从事实派生的视图。投影可以重算，事实不能靠“再让模型说一遍”修复。

### 2. 推荐动作不是权限白名单

`next_cli_actions`、recommended action 和 attention queue 是 steering。真正合法的动作还要重新过 typed authority、preflight、receipt binding、validation 和 settlement。必须禁止的动作应返回明确错误，而不是靠“没推荐”暗示。

### 3. 副作用必须按阶段提交

Host 执行和 typed result 只说明“尝试发生了什么”；validation 决定“证据是否够”；writeback 决定“长期状态是否接受”；spend 决定“成本是否记账”。任何一步失败，都要从 journal 已提交的前缀继续，而不是重跑整轮。

## 一条可以背下来的主链

```text
should-run
  → turn plan
  → host request
  → typed result
  → validation
  → durable writeback
  → quota spend
  → scheduler apply/ack
  → terminal closeout（仅 completion 且 no_followup）
  → refresh-state
```

读每个阶段时都问三句：**这一步的事实属于谁？失败后停在哪？重试时哪些副作用绝不能重做？**

## 推荐读法

- 第一遍只看主链，不追 Capability 内部业务。
- 第二遍打开每个阶段列出的源码坐标，确认函数名、输入输出和失败返回。
- 第三遍做实验：构造一个 `should_run=false`、一个 `wait`、一个“写回后崩溃”的场景，并写出恢复动作。

## 学习完成标准

1. 为什么 LoopX 不把目标、Todo 和配额只放在 transcript 里？
2. `should_run=true` 为什么不等于 Host 可以做任何事？
3. 七阶段为什么必须让 `quota_spend` 位于 `durable_writeback` 之后？
4. `validated_progress`、`validated_completion`、`wait`、`host_failure` 对下一轮分别意味着什么？
5. `terminal_closeout_failed` 发生时，哪些 effect 已经提交，恢复时哪些不能重做？
6. Capability 与 Provider 的职责边界是什么？
7. 为什么 Status 和 next action 只能当投影，不能当事实源？

### 参考答案

1. transcript 会压缩、截断、换模型、换会话；它只是本轮工作副本。目标、Todo、claim/lease、gate、quota、authority、evidence 和 run history 必须独立持久化，才能在崩溃、Host 切换或长期暂停后重建当前 frontier。
2. `should_run` 只回答“当前允许进入一次 Turn 的候选”；具体事项仍受 Todo scope、claim、user gate、capability gate、workspace guard 和 typed action authority 约束。推荐动作也只是 steering。
3. 只有写回被接受，才存在可证明的交付。先扣配额再写回失败，会留下“消费了但没有状态变化”的坏账；恢复时既难安全退款，也难判断是否该重扣。先写回，spend 才有明确的 receipt 前置条件。
4. `validated_progress` 是有证据但未完成的推进，结算后重算 frontier；`validated_completion` 必须声明后继、active goal 或 `no_followup`，可能触发 terminal closeout；`wait` 是不消费的暂停，保存 resume condition；`host_failure` 不消费、不算成功，下一轮按策略修 Host、重试或等待。
5. 前五阶段通常已经提交：Host 执行、typed result、validation、durable writeback、quota spend 都已有事实；缺的是终局 closeout。恢复时只补 closeout，不能重跑 Host、重复 writeback 或再次 spend。
6. Capability 定义领域语义：成功条件、证据、typed transition、错误分类；Provider 提供生命周期与执行实现，并遵守 declared/installed/enabled/ready 状态。Capability 不能直接改 Kernel 私有状态，Provider 也不能绕过验证与结算。
7. 投影可以随规则、版本和筛选条件重算，也可能暂时缺失；事实若被投影覆盖，崩溃后就没有可信恢复点。Status 适合告诉人和 Agent“现在看哪里”，不适合证明“这件事已经发生”。

## 下一步

从 `阶段0-环境与源码地图.md` 开始。先不要急着读全部 Capability，先确认六层事实、一条主链和四个恢复问题。
