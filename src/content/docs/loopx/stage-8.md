---
title: "阶段 8：工程化、测试与恢复"
description: "阶段 8：工程化、测试与恢复。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：LoopX 源码课 · 阶段卷
> 前置：阶段 5～7
> 对应总览：`engineering.md`
> 本阶段目标：用测试、journal、原子写入和恢复审计证明系统在失败下仍守合同。

## 1. 本阶段解决什么

控制面的难点不在成功路径，而在这些情况：

- Host 刚执行完就崩溃；
- writeback 成功但 spend 未提交；
- 两个 worker 同时尝试拥有同一个 Turn；
- 状态文件只写了一半；
- 恢复包路径逃逸或成员类型不安全；
- 投影版本变了，旧 receipt 仍要能读。

LoopX 用“typed contract + ordered journal + readback + fail-closed”处理，而不是靠日志猜测。

## 2. 先记住一个判断

**恢复不是重跑，而是读取已提交前缀后只补缺失阶段；不能证明的前缀一律视为未知并阻断。**

工程化的目标不是让所有失败自动成功，而是让失败有类型、有边界、可审计、不会重复副作用。

## 3. 源码主线

1. `turn_journal.ts` 校验 journal identity、lineage、completed phases 是否有序前缀、status 与阶段是否一致。
2. `recovery.py::assess_existing_turn_recovery()` 形成 typed recovery decision，`require_turn_recovery_continuation()` 拒绝不合法继续。
3. `recovery_audit` 记录 planned vs actual，避免恢复过程无痕覆盖。
4. `runtime/document_io.py::atomic_write_state_text()` 用临时文件/原子替换与 durability 校验保护状态写入。
5. `state_recovery_io.py` 在解包前检查路径、链接、成员类型、大小与摘要，失败不创建目标。
6. 测试按“计划/回执/状态恢复/投影/公共安全”分层固定行为，例如 `test_turn_loop_disposition.py`、`test_state_recovery.py`、`test_state_refresh_projections.py`。

## 4. 关键对象与合同

| 对象 | 保证 | 失败时 |
| --- | --- | --- |
| Turn journal | 计划与实际阶段有单一日志 | 不一致则阻断 |
| `completed_phases` | 有序、连续的已提交前缀 | 跳跃/乱序即无效 |
| effect readback | 外部效果可观察 | 未观察到就不假定发生 |
| atomic write | 读者不会看到半文件 | 保留旧文件/清理 staging |
| recovery audit | 恢复动作有 planned/actual | 不能静默重跑 |
| contract tests | 结果 kind、阶段、公共安全稳定 | 回归立即暴露 |
| archive validation | 路径、类型、大小、摘要受限 | 在写入前 fail closed |

### journal 与普通日志的区别

普通日志可以缺行、乱序、只供人看；journal 是恢复合同。它必须绑定 turn_key、lineage、计划阶段与实际阶段，并明确状态。日志写得多不等于 journal 可信。

### 原子写与“看起来写成功”

只调用一次 `write_text` 可能在崩溃时留下半文件。原子写先写临时文件、校验内容/权限，再替换目标；恢复包还要防止 symlink、hardlink、`..` 与超大成员在解包时逃逸。

## 5. 一条可观察链路

```text
read journal
  → validate turn_key / lineage / phase prefix
  → inspect effect receipts / readback
  → recovery decision
  → if blocked: return typed refusal
  → if continuable: resume_from
  → execute only missing phases
  → append recovery audit
```

调试恢复问题，先回答“journal 是否一致”，再回答“哪个 effect 已读回”，最后才决定重试。

## 6. 实验

### 实验 A：篡改阶段前缀

把 `completed_phases` 改成乱序或缺项。参考验收：recovery 判定无效并阻断，不尝试猜测缺失阶段。

### 实验 B：模拟半写文件

在原子写临时文件阶段中断，保留旧目标。参考验收：旧状态仍可读，临时文件可清理；不会把半截 JSON 当新状态。

### 实验 C：构造恢复包路径逃逸

加入 `../outside`、symlink 或异常成员类型。参考验收：在创建目标目录/解包前拒绝，live state 不变。

### 实验 D：运行定向测试

```powershell
pytest -q tests/test_turn_loop_disposition.py tests/test_turn_envelope.py
pytest -q tests/test_state_recovery.py tests/test_state_refresh_projections.py
```

参考验收：测试覆盖计划阶段、envelope 预算、journal/status 一致、恢复包拒绝和投影重算。

### 实验参考答案

1. `completed_phases` 乱序/缺项应被判定为无效恢复并阻断，不能猜测补齐。
2. 半写临时文件不应替换旧目标；旧状态仍可读，临时文件可清理，半截 JSON 不能被当成新事实。
3. 恢复包必须在创建目标或解包前拒绝 `../outside`、symlink 和异常成员类型；live state 保持不变。
4. 定向测试应验证计划阶段、envelope 预算、journal/status 一致、恢复包拒绝与投影重算；测试失败时先定位是哪条契约被破坏。

## 7. 失败与恢复

| 故障 | 处理 | 禁止 |
| --- | --- | --- |
| journal 缺 lineage | 阻断并要求修日志 | 猜同一 Turn |
| completed_phases 跳跃 | 报结构化 violation | 补齐中间阶段 |
| effect 不可读回 | 标记 unknown，等待人工/外部证据 | 直接重放 |
| 原子写失败 | 保留旧状态、清理 staging | 覆盖成空文件 |
| 恢复包不安全 | 在解包前拒绝 | 先解压再检查 |
| 测试失败于公共安全 | 删除泄漏字段/修投影 | 放宽断言掩盖 |

## 8. 通关自测

1. Turn journal 与普通运行日志的关键区别是什么？
2. 为什么 `completed_phases` 必须是有序前缀？
3. effect 已执行但 readback 不确定时，为什么不直接重试？
4. 原子写解决的是什么失败模式？
5. 恢复包为什么要“先验证再解包”？
6. 一个改动怎样证明没有破坏控制面合同？

### 参考答案

1. journal 是恢复合同，必须绑定 turn identity、lineage、计划/实际阶段和可判定状态；普通日志只用于观察，缺行或乱序不能作为提交依据。
2. 七阶段有因果顺序，前缀表示“到此为止已提交”。跳跃或乱序意味着无法确定前置 effect 是否发生，恢复会重复副作用或越过验证。
3. readback 不确定说明不知道 effect 是否已落地。直接重试可能重复写文件、发消息、扣费；应先读 receipt/外部状态，无法证明时 fail closed。
4. 它避免读者看到半写文件、崩溃后留下损坏目标，并通过临时文件/替换/校验保持旧状态可用。
5. 解包本身就会创建目录、链接或消耗资源，恶意路径/成员类型可能已造成影响。必须先检查路径、链接目标、成员类型、大小和摘要，再落盘。
6. 运行对应计划/回执/恢复/投影测试，确认阶段顺序、result kind、journal consistency、公共安全字段和失败路径；再用一个崩溃场景验证只补缺失 effect。

## 9. 源码坐标

- `loopx/control_plane/turn_driver/turn_journal.ts`
- `loopx/control_plane/turn_driver/recovery.py`
- `loopx/control_plane/runtime/document_io.py`
- `loopx/control_plane/state_recovery_io.py`
- `loopx/control_plane/turn_driver/host_process.ts`
- `tests/test_turn_loop_disposition.py`
- `tests/test_turn_envelope.py`
- `tests/test_state_recovery.py`
- `tests/test_state_refresh_projections.py`

## 10. 下一步

进入阶段 9：把前面七阶段、投影、恢复和测试合成一个可交付的 Capability 设计，而不是只停留在阅读。
