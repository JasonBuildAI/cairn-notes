---
title: "阶段 9：毕业设计"
description: "阶段 9：毕业设计。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：LoopX 源码课 · 阶段卷
> 前置：阶段 0～8
> 对应总览：`03-工程实战.md` 的设计练习
> 本阶段目标：完成一个可验证、可结算、可恢复的 Capability 设计，而不是再加一篇摘要。

## 1. 本阶段解决什么

读完前八阶段，真正的检验不是背诵七阶段，而是能否给 LoopX 增加一个领域能力，同时不破坏：

- 事实归属与投影边界；
- Goal/Todo/claim/gate/quota 的准入；
- Host 只产候选结果的权限；
- validation → writeback → spend 的顺序；
- journal/receipt 驱动的崩溃恢复；
- CLI/Dashboard 的单一事实源。

本设计题以一个“文档交付能力”为例：Agent 要生成一份评审材料，并把它投递到受控渠道。难点是“生成了文件”不等于“交付完成”。

## 2. 先记住一个判断

**Capability 设计的核心不是工具函数，而是“什么证据能让状态迁移”。**

如果无法定义证据、无法在崩溃后读回、无法区分正常交付与恢复，工具再能调用也不合格。

## 3. 源码主线：照着一等公民实现

1. 在 `capabilities/catalog.py` 参考现有 Capability 声明成功条件、证据和 transition。
2. 在 `capabilities/registry.py` 注册 Provider、implementation 与 `declared/installed/enabled/ready` 生命周期。
3. 在 `control_plane/capability_hooks.py` 只投影本轮需要的上下文，不把内部句柄暴露给 Host。
4. 在 `turn_driver/host_candidate.py` 定义可用于验证的 typed result 字段。
5. 在 `turn_driver/executor.py` 的验证层检查 scope、证据与 completion lifecycle。
6. 在 `turn_driver/settlement.py` 只通过 effect/readback 写回、消费和关闭。
7. 在 `turn_driver/turn_contract_generated.py` 与 `turn_transaction_contract.json` 保持 result/phase 词汇一致。
8. 在 `presentation/` 与 `status.py` 增加只读投影，不新增事实桶。
9. 在 `tests/` 增加成功、拒绝、重复执行、崩溃恢复和公共安全用例。

## 4. 关键对象与合同

### 题目：受控文档交付

建议定义两种 material transition：

| transition | 证据 | 结算 |
| --- | --- | --- |
| `draft_ready` | 文件路径、内容 digest、生成命令回执 | 写回草稿状态，继续等待审批 |
| `delivery_completed` | 渠道消息 id、目标 scope、审批 receipt、内容 digest | 写回交付状态，安排后继/关闭 |

至少还要有：

- `wait`：等待 owner 审批，不消费配额，保存 resume condition；
- `host_failure`：生成失败，不消费，不写交付成功；
- `repair_required`：证据缺字段、路径越界或 digest 不匹配；
- `terminal_closeout_failed`：交付已提交，但生命周期关闭失败。

### 必须写出的设计表

| 问题 | 你的答案必须说明 |
| --- | --- |
| 事实源 | 草稿、审批、交付分别存在哪里，谁是 canonical |
| Provider | 生成器与渠道分别是 declared/installed/enabled/ready 的哪一层 |
| Host 边界 | Host 最多知道哪些 scope，能返回哪些字段 |
| 证据 | 怎样证明目标渠道收到的是同一份内容 |
| 幂等 | 重复 Turn 如何用 effect_ref/channel id 防止重投 |
| 恢复 | 在哪五个点注入崩溃，分别只补哪些阶段 |
| 投影 | Dashboard 显示什么，为什么不能反向改交付状态 |
| 安全 | 路径、凭据、public-safe 输出和越权渠道如何处理 |

## 5. 一条可观察链路

```text
Goal: 交付评审材料
  → Todo: 生成草稿
  → should-run / claim / gate
  → Host 生成文件（candidate）
  → validation: path + digest + scope
  → writeback: draft_ready
  → spend
  → wait: owner approval（no-spend）
  → 新 Turn: delivery
  → validation: approval + content digest
  → writeback: delivery_completed
  → spend + scheduler
  → closeout
  → refresh frontier
```

注意审批前后是两个逻辑 Turn。审批等待不应消费配额，也不应让 Host 轮询到永久运行。

## 6. 实验：必须完成的五项交付物

### A. Capability 合同

写一份一页合同：成功条件、证据、错误分类、transition、scope、public-safe 字段。验收标准：另一个工程师不看实现也能判断何时 completion 合法。

### B. Provider 生命周期

写出生成器和渠道 Provider 的 manifest/状态变化。验收标准：未声明不能安装、未安装不能启用、未启用不能 ready；缺少渠道凭据时走 capability gate。

### C. 崩溃矩阵

在五个点注入失败：Host 后、validation 后、writeback 后、spend 后、scheduler/closeout 后。每个点写出已提交事实和唯一合法恢复动作。

### D. 幂等实验

让同一 Turn 重复执行两次。验收标准：第二次读取到已有 effect/receipt，不重复生成和投递；若内容 digest 不同则明确冲突。

### E. 投影实验

在 Dashboard 手工篡改“已交付”，再刷新。验收标准：回到 canonical 状态；展示层没有自己的交付表。

### 实验参考答案

1. 合同必须让他人仅凭成功条件、证据、错误分类、transition、scope 和 public-safe 字段就能判断 completion 是否合法。
2. 生命周期应体现 declared → installed → enabled → ready，并让渠道凭据缺失走 capability gate，而不是运行中崩溃。
3. 五个崩溃点都应写清已提交事实与唯一合法恢复动作：Host、validation、writeback、spend、scheduler/closeout 后只补缺失阶段。
4. 同一 Turn 重跑应命中已有 effect/receipt，不重复生成/投递；同一身份但内容 digest 不同必须明确冲突。
5. 手工篡改展示层后 refresh 应回到 canonical 交付状态；Dashboard 不能维护自己的交付事实表。

## 7. 失败与恢复

| 设计漏洞 | 后果 | 修正 |
| --- | --- | --- |
| 把文件存在当交付 | 生成了但没送到 | completion 证据必须含渠道 receipt |
| 用文件名当幂等键 | 同名覆盖/重复投递 | 用内容 digest + effect_ref/channel id |
| 审批前就 spend | 等待也扣费 | wait 为 no-spend，审批后另起 Turn |
| Host 直接写 Dashboard | 双事实源 | 只经 writeback，展示层只读 |
| completion 无 lifecycle | 任务悬空 | 补 successor/active goal/no_followup |
| readback 失败直接重跑 | 重复投递 | 先查 channel/effect，再恢复 |
| 恢复时重跑 Host | 重复生成/副作用 | 从 completed_phases 前缀继续 |

## 8. 通关自测

1. 为什么“文件已生成”不能直接等于交付完成？
2. 审批等待为什么应设计成 no-spend Turn？
3. 渠道重复投递应依赖什么幂等事实？
4. 在 spend 后崩溃，恢复时为什么不能重新生成文档？
5. 为什么 Capability 设计必须同时定义失败分类？
6. 怎样证明 Dashboard 没有成为第二个事实源？

### 参考答案

1. 文件存在只证明本地生成，不证明目标渠道收到、内容一致、权限正确或 owner 已批准。completion 需要渠道 receipt、内容 digest、scope 和 lifecycle 等证据。
2. 审批等待没有推进工作，也没有可证明的交付；扣费会产生无收益成本并让恢复复杂化。保存 resume condition，审批通过后再开启新的交付 Turn。
3. 使用稳定的 effect_ref，并把渠道 message id、目标 scope、内容 digest 一起写入 receipt；重试先 readback，已存在则复用，内容不同则报冲突。
4. Host 执行和 writeback 已完成，只是调度/closeout 未提交。重跑 Host 会重复生成甚至改变内容；恢复只能读 receipt 后补调度/closeout。
5. 不同失败对应不同责任和恢复：Host 失败修执行器，validation 失败补证据，writeback 失败修状态合同，spend 失败查账本，closeout 失败只补终局。没有分类只能盲目重试。
6. 篡改展示后刷新，状态回到 canonical fact；检查所有写操作都经过 typed command、authority、writeback 和 receipt，并确认展示层没有独立持久化。

## 9. 源码坐标

- `loopx/capabilities/catalog.py`
- `loopx/capabilities/registry.py`
- `loopx/control_plane/capability_hooks.py`
- `loopx/control_plane/turn_driver/host_candidate.py`
- `loopx/control_plane/turn_driver/executor.py`
- `loopx/control_plane/turn_driver/settlement.py`
- `loopx/control_plane/turn_transaction_contract.json`
- `loopx/presentation/`
- `tests/test_turn_loop_disposition.py`
- `tests/test_state_recovery.py`

## 10. 完成标准

你应当能把自己的 Capability 放回整条主链，并清楚回答：

```text
为什么现在运行？
运行哪一件事？
Host 只能看到什么、返回什么？
什么证据允许写回？
先写回还是先消费？
哪一步崩溃后只补哪一步？
下一轮 frontier 从哪里重算？
```

能做到这七问，才算真正学完 LoopX 控制面。
