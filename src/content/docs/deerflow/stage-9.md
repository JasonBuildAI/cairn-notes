---
title: "阶段 9：毕业设计"
description: "阶段 9：毕业设计。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：DeerFlow 源码课 · 阶段卷
> 前置：阶段 0～8
> 本阶段目标：不再“读懂了”，而是完成一个能解释、能验证、能恢复的端到端改造。

## 1. 任务定位

从下面三个题目中选一个。共同要求是：不绕过 `start_run`，不直接调用宿主 shell，不伪造成功终态。

| 题目 | 改造点 | 主要源码 |
| --- | --- | --- |
| A. 新增只读审计工具 | 工具注册 + middleware + receipt | `tools/`、`middlewares/` |
| B. 新增受控渠道入口 | 输入归一化 + 复用接单 | `app/channels/`、`services.py` |
| C. 新增交付验证实验 | workspace changes + receipt | `worker.py`、`routers/thread_runs.py` |

## 2. 必答的五个设计问题

1. 新能力的事实源是什么？
2. 谁有权创建/修改它？
3. 它是否会改变 Run 状态或产生外部副作用？
4. 失败后哪条 receipt/journal 能证明进度？
5. 哪些动作绝不能重做？

把答案写在代码改动之前。答不出来，说明还没找到边界。

## 3. 参考方案 A：只读审计工具

**做法**：

- 在 `tools/` 定义带严格参数的只读工具；
- 在 Agent 装配时按权限加入；
- 用现有工具 middleware 保证参数、输出预算和 receipt；
- 不新增 Run 状态，不写 workspace。

**验收点**：

- 无权限时工具不可见；
- 超长输出被有界化，receipt 记录调用；
- 工具失败返回结构化结果，图可继续；
- 不产生新的成功终态路径。

## 4. 参考方案 B：受控渠道

**做法**：

- 适配器只负责把外部消息变成统一的 `RunCreateRequest`；
- 生成稳定幂等键与来源 metadata；
- 调用 `start_run`，复用 lease、事件、回复路由；
- 对重复消息和回复失败做明确处理。

**验收点**：

- 同一外部消息重放不会产生两个副作用 Run；
- 权限和模型白名单仍由服务端决定；
- 回复只消费 Run 的交付/事件，不自行改终态。

## 5. 参考方案 C：交付验证

**做法**：

- 观察 `_produced_output_paths`、delivery content 与 receipt；
- 构造“模型声称完成但没有产物”的案例；
- 再构造真实写入并展示的案例；
- 记录两种终态差异。

**验收点**：

- 无产物时不能干净成功；
- 有产物时 receipt 能找到路径；
- 重启/重放不会把已交付的 Run 再跑一遍。

## 6. 失败与恢复演练

必须至少演示一次：

- 在开工前取消；
- 在工具执行后制造失败；
- 在 receipt 前后制造写入中断；
- 解释旧 worker 为什么不能继续写。

参考恢复原则：**先读事实，再决定补哪一步；已提交的 effect 不重做。**

## 7. 交付物

- 一份改动说明：边界、事实源、失败路径、恢复路径；
- 一组测试或可重复实验；
- 一张端到端时序图；
- 一份“我没有改什么”的边界清单。

## 8. 通关自测

1. 你的改造为什么不绕过 `start_run`？
2. 新能力产生的副作用如何证明发生？
3. 如果进程在交付前崩溃，恢复者怎样判断不要重跑工具？
4. 你修改的代码属于 harness 还是 app，为什么？

### 参考答案

1. 因为入口只翻译输入并调用统一接单口，权限、幂等、模型白名单、lease、事件和交付才能一致；绕开后任何新入口都会形成第二套状态机。
2. 通过工具 receipt、journal 事件、workspace 产物和交付 receipt 形成链条；模型文本只是声明，不是证据。
3. 读取 RunRecord、journal 和 checkpoint，确认工具/交付事实是否已提交；只补缺失阶段，已提交的外部副作用不能重放。
4. 能从具体产品入口抽离、可被其他宿主复用的能力放 harness；依赖某个 Web/IM/调度实现的装配放 app。边界测试是最终裁判。

## 9. 源码坐标

- `backend/app/gateway/services.py`
- `backend/app/gateway/routers/thread_runs.py`
- `backend/packages/harness/deerflow/runtime/runs/worker.py`
- `backend/packages/harness/deerflow/runtime/journal.py`
- `backend/packages/harness/deerflow/runtime/checkpoint_state.py`
- `backend/packages/harness/deerflow/agents/middlewares/tool_receipt.py`
- `backend/tests/test_run_journal.py`
- `backend/tests/test_tool_receipt_middleware.py`

## 10. 评分标准

| 维度 | 合格 | 优秀 |
| --- | --- | --- |
| 生命周期 | 能说出接单→终态 | 能解释每个失败窗口 |
| 信任边界 | 不伪造 owner/终态 | 能指出客户端可伪造点并封住 |
| 工具安全 | 经过 middleware/sandbox | 有幂等与 readback 设计 |
| 证据 | 有日志 | 有 receipt + 可重放实验 |
| 工程 | 测试通过 | 边界、恢复、负例都覆盖 |

## 11. 最后一句话

DeerFlow 的核心不是“让模型多调几次工具”，而是**把一次 Agent 执行变成可接单、可隔离、可恢复、可审计、可交付的 Run**。毕业设计必须证明你守住了这句话。
