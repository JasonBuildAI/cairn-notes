---
title: "阶段 1：入口与 Run 生命周期"
description: "阶段 1：入口与 Run 生命周期。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：DeerFlow 源码课 · 阶段卷
> 前置：阶段 0
> 对应总览：`run-lifecycle.md`
> 本阶段目标：准确说出一次 Run 在什么时刻被接纳、开工、失去所有权和收尾。

## 1. 本阶段解决什么

一次执行不是“调用一个函数并等待返回”，而是一张有身份的工单：

~~~text
POST 请求
  → start_run 授权与清洗
  → create_or_reject 原子登记为 pending
  → 返回 RunResponse / 建立 SSE
  → worker try_start 条件迁移为 running
  → astream 执行
  → journal / checkpoint / delivery receipt
  → success / error / interrupted
~~~

`thread_runs.py` 的 `create_run`、`stream_run`、`wait_run` 只是三种消费姿势，最终都走 `services.start_run`。

## 2. 先记住一个判断

**接单与开工是两次不同的承诺。**

`create_or_reject()` 回答“这张工单是否允许存在”；`try_start()` 回答“现在是否真的有 worker 能拥有它”。把两者合并，会让排队、取消、幂等和并发启动都失去原子边界。

## 3. 源码主线

1. `thread_runs.py::create_run` 调 `start_run`。
2. `start_run` 检查取消能力、模型白名单、线程归属、输入与内部键清洗。
3. `start_run` 组装服务端可信 `RunContext`，再调 `RunManager.create_or_reject`。
4. `create_or_reject` 在一个受控区间内处理幂等键、同线程策略和 `pending` 记录。
5. 后台 worker 进入 `run_agent`，先调用 `run_manager.try_start(run_id)`。
6. `try_start` 只有确认记录仍为 `pending`、owner/lease 成立时，才把它改成 `running`。
7. 图执行期间由 `RunJournal`、`StreamBridge` 和 checkpoint 分别记录事实。
8. 最终以 `set_finalizing`、交付 receipt、状态写入和资源释放收尾。

## 4. 关键对象与合同

| 合同 | 含义 | 失败后果 |
| --- | --- | --- |
| 幂等键 | 同一请求重放不能产生两个工单 | 重复副作用、重复计费 |
| 线程归属 | 只有有权限的 owner 能创建 Run | 跨用户读写 |
| `pending` | 已登记但未开工 | 把“接单”误报成“执行中” |
| `try_start` | 唯一开工门 | 多 worker 同时执行 |
| `ownership_lost` | 本 worker 已失去写权 | 僵尸写入覆盖新 owner |
| finalizing | 终态前的排他收尾区 | 交付与成功状态不闭合 |

## 5. 一条可观察链路

~~~text
create_run
  → start_run
  → create_or_reject: pending
  → background worker
  → try_start: running
  → run_agent / astream
  → finalizing
  → delivery receipt
  → terminal
~~~

重点观察：取消可能发生在 `pending`、等待前面 Run finalizing、模型流中和工具边界；不同位置的收尾不同，但都不能伪造成功。

## 6. 实验

### 实验 A：验证“返回不等于开工”

创建一个 Run 后立刻查询状态；再在 `try_start` 的 `cancelled` 分支观察。参考验收：应能看到 `pending → interrupted`，且不应构造模型或初始化工具。

### 实验 B：验证幂等

用同一个幂等键并发提交两次。参考观察：只产生一个合法工单，另一个走复用或冲突路径，而不是两个 worker 同时跑。

### 实验 C：验证交付门槛

让 Agent 只说“已生成 report.md”但不写文件。参考验收：不能仅凭自然语言标记成功；交付内容必须能对应真实产物。

### 实验参考答案

1. 立即查询应看到 `pending` 尚未执行；若在 `try_start` 前取消，则进入 `interrupted`，且不会构造模型、初始化工具或产生运行副作用。
2. 两次提交只能留下一个可执行工单；第二次应命中幂等复用或冲突，不能出现两个 worker 同时拥有同一 Run。
3. 仅有自然语言“已生成”不能进入干净成功。交付必须能对应真实产物、receipt 或可验证输出；缺产物时应失败或标记未闭合。

## 7. 失败与恢复

| 崩溃位置 | 已有事实 | 恢复原则 |
| --- | --- | --- |
| `create_or_reject` 前 | 无工单 | 客户端可安全重试 |
| pending 后、开工前 | 有工单、无执行 | 取消或重新调度 |
| running 中 | 有 lease、事件、部分 checkpoint | 由接管者恢复，旧 worker 停写 |
| finalizing 中 | 结果已产生，终态未闭合 | 先读 journal/receipt，只补收尾 |
| 终态写入后 | 工单已结束 | 只做幂等回放，不重跑工具 |

## 8. 通关自测

1. 为什么 `create_or_reject()` 和 `try_start()` 都必须存在？
2. Run 在什么条件下才从 `pending` 变成 `running`？
3. `ownership_lost` 为什么必须阻止继续写终态？
4. 取消发生在工具执行中时，哪些动作不能假装回滚？

### 参考答案

1. 前者解决接单竞态：幂等、同线程策略和是否允许创建工单；后者解决开工竞态：取消、并发 worker 和 lease。合并会让“允许存在”和“真的有人执行”混成一个不稳定承诺。
2. 只有 worker 取得开工资格，记录仍为 `pending`，且 owner/lease 条件成立时，`try_start()` 才做条件迁移。HTTP 返回、SSE 建连和任务入队都不能证明已经 running。
3. 失去所有权后，旧 worker 的终态、receipt、标题或用量写入会覆盖新 owner 的合法结果；它应停止持久化收尾，把恢复责任交给接管者。
4. 已发生的外部写文件、网络请求、消息发送等副作用不能被“取消”抹掉；必须记录部分执行、使用幂等键或 readback 判断是否已生效，不能盲目重做。

## 9. 源码坐标

- `backend/app/gateway/routers/thread_runs.py`
- `backend/app/gateway/services.py::start_run`
- `backend/packages/harness/deerflow/runtime/runs/manager.py`
- `backend/packages/harness/deerflow/runtime/runs/worker.py::run_agent`
- `backend/packages/harness/deerflow/runtime/journal.py`

## 10. 下一步

进入阶段 2：Run 已经 `running`，接下来 LangGraph 究竟由哪些模型、工具和 middleware 组装出来？
