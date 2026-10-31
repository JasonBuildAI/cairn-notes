---
title: "阶段 6：持久化与恢复"
description: "阶段 6：持久化与恢复。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：DeerFlow 源码课 · 阶段卷
> 前置：阶段 1、3、4
> 对应总览：`02-核心机制.md` 与 `03-工程实战.md`
> 本阶段目标：在崩溃、取消、租约丢失和交付失败时，准确判断哪些事实已提交、哪些动作只能补、哪些绝不能重做。

## 1. 本阶段解决什么

一个 Run 同时写几类状态：

~~~text
RunStore       控制面：状态、owner、lease、幂等键
Checkpoint     执行面：LangGraph 图状态
Event Store    观察面：按序事件、回放
RunJournal     运行账本：token、工具、交付事实
Outputs        产物面：workspace 文件与交付路径
~~~

它们不是冗余副本，而是回答不同问题。恢复时必须先判断缺的是哪一类事实。

## 2. 先记住一个判断

**先有证据，再有终态。**

DeerFlow 刻意先写交付 receipt，再写成功状态，是为了消除“页面显示成功但证据没落盘”的窗口。没有 receipt 的成功不是成功，只是模型说了句话。

## 3. 源码主线

1. `RunRecord` 保存 `status`、`owner_worker_id`、lease 相关字段、幂等键和控制标志。
2. `RunManager.create_or_reject` 原子登记；`try_start` 条件迁移；`set_finalizing` 进入终态排他区。
3. `worker.run_agent` 在开始前读取上次 checkpoint，必要时回滚到 run 前状态。
4. `RunJournal` 作为 callback handler 收集模型、工具、token 与交付事件。
5. `StreamBridge` 把实时事件送到 SSE；event store 提供持久化与回放。
6. checkpointer 保存图状态；checkpoint mode 决定 full/delta 通道兼容性。
7. heartbeat 与 orphan recovery 处理 worker 失联和遗留 Run。
8. 收尾先验证交付、写 receipt，再完成终态与资源释放。

## 4. 关键对象与合同

| 事实 | 事实源 | 恢复用途 |
| --- | --- | --- |
| 谁在跑 | `RunRecord.owner_worker_id` / lease | 防止双 worker |
| 跑到哪 | checkpoint | 续跑图状态 |
| 做了什么 | journal / event store | 审计、重放、交付判断 |
| 交付了什么 | receipt + workspace outputs | 成功门槛 |
| 请求是否重复 | 幂等键 | 防止重复接单 |

## 5. 一条可观察链路

~~~text
checkpoint 读取
  → run 前快照
  → astream
  → journal 事件
  → event store / stream bridge
  → checkpoint 更新
  → 交付扫描
  → delivery receipt
  → terminal status
~~~

SSE 是视图，不是事实源。跨 worker 实时 SSE 需要共享 bridge（如 Redis）或从 event store 回放；不能假设内存队列透明共享。

## 6. 实验

### 实验 A：验证先 receipt 后终态

在 `_persist_delivery_receipt` 附近观察顺序。参考验收：receipt 失败时 Run 不应标记为干净的 `success`，而应进入错误/未闭合路径。

### 实验 B：模拟 worker 失联

暂停 heartbeat 或终止 worker，再启动新的 Gateway。参考观察：orphan recovery 依据租约和持久记录接管，旧 worker 的 `ownership_lost` 阻止继续写。

### 实验 C：对比事件与 SSE

从 event store 读取同一 Run 的历史事件，再断开/重连 SSE。参考验收：实时流可丢连接，但历史事件可按游标恢复；二者语义不同。

### 实验参考答案

1. receipt 失败时不能标记干净 `success`；应进入错误/未闭合路径，恢复者先核对交付事实再补写。
2. 新 Gateway 应依据租约与持久记录接管；旧 worker 继续写时会被 `ownership_lost` 一类围栏阻止。
3. 实时 SSE 断线可丢瞬时连接，持久事件仍可按游标回放；UI 重连不能触发 Run 重跑。

## 7. 失败与恢复

| 崩溃窗口 | 已有事实 | 恢复动作 |
| --- | --- | --- |
| checkpoint 更新前 | 上一 checkpoint、journal | 从上一个可恢复点继续 |
| checkpoint 后、终态前 | 图状态已完成 | 只补交付与终态 |
| receipt 后、状态前 | 交付已证明 | 幂等补写终态 |
| ownership_lost | 本 worker 已无权 | 立即停止持久化 |
| 终态后 | 工单已关闭 | 只允许幂等读取/回放 |

## 8. 通关自测

1. checkpoint、journal、RunStore 能否互相替代？
2. 为什么成功状态必须晚于 delivery receipt？
3. `ownership_lost` 后旧 worker 还能写用量或标题吗？
4. 跨 worker SSE 为什么不能依赖进程内队列？

### 参考答案

1. 不能。RunStore 管控制状态与租约，checkpoint 管图续跑，journal 管过程与审计；三者的读者、写入者和一致性边界不同。
2. 因为“成功”应由可验证交付支撑。先写 receipt 再写状态能让恢复者知道结果已经产出；反过来则会出现成功状态存在但没有任何交付证据的坏账。
3. 不能。所有权已转移，任何旧写入都可能覆盖新 owner 的合法结果；应停止写入并把恢复交给接管者。
4. 进程内 `MemoryStreamBridge` 的队列只属于一个进程。其他 worker 看不到实时事件；需要 Redis bridge 或从 event store 重放，不能把 SSE 当共享状态。

## 9. 源码坐标

- `backend/packages/harness/deerflow/runtime/runs/manager.py`
- `backend/packages/harness/deerflow/runtime/runs/worker.py`
- `backend/packages/harness/deerflow/runtime/journal.py`
- `backend/packages/harness/deerflow/runtime/events/`
- `backend/packages/harness/deerflow/runtime/checkpointer/`
- `backend/packages/harness/deerflow/runtime/stream_bridge/`

## 10. 下一步

进入阶段 7：单个 Run 已经可靠，渠道、定时任务、MCP 和子 Agent 如何复用这套控制面？
