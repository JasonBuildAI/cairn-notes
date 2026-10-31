---
title: "阶段 8：工程化与故障排查"
description: "阶段 8：工程化与故障排查。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：DeerFlow 源码课 · 阶段卷
> 前置：阶段 0～7
> 对应总览：`engineering.md`
> 本阶段目标：用“层次 + 证据”定位问题，而不是从头猜。

## 1. 本阶段解决什么

Agent 系统的故障很少是单点：

~~~text
请求失败
  ├─ 接单/权限/配置
  ├─ worker/lease/状态机
  ├─ 装配/模型/上下文
  ├─ 工具/sandbox/审批
  └─ 持久化/交付/前端
~~~

工程化的工作是把每一层变成可测试、可观测、可回滚的合同。

## 2. 先记住一个判断

**先定位“哪类事实不一致”，再决定看哪层代码。**

页面没显示、SSE 断了、Run 成功但没文件、模型一直重复调用，分别指向不同事实源。不要用一个万能日志搜索替代分层判断。

## 3. 源码主线

1. `backend/tests/test_harness_boundary.py` 强制内核与 app 单向依赖。
2. Run 生命周期测试覆盖 `pending`、取消、幂等、lease、恢复和终态。
3. middleware 测试覆盖工具配对、预算、读前写、空响应和终态保护。
4. sandbox 测试覆盖路径映射、provider、lease、越界与截断。
5. `RunJournal` 与 event store 为调试提供时间顺序；trace/usage 提供跨层关联。
6. `engineering.md` 给出实验和故障矩阵，可作为本章的配套练习册。

## 4. 关键对象与合同

| 证据 | 能回答 | 不能回答 |
| --- | --- | --- |
| RunRecord | Run 是否登记/开工/终态 | 模型为什么这样回答 |
| journal | 过程事件与 token | 完整图状态 |
| checkpoint | 图执行到哪 | 外部消息是否已发送 |
| tool receipt | 工具调用事实 | 副作用是否被用户看到 |
| trace/log | 跨服务调用链 | 业务交付是否真实 |

## 5. 一条可观察链路

~~~text
症状
  → 查 RunRecord：有没有工单/owner/lease
  → 查 journal：最后成功事件是什么
  → 查 checkpoint：图能否续跑
  → 查工具 receipt/outputs：副作用是否发生
  → 查 SSE/event store：观众看到的是否一致
  → 回到对应层写最小复现
~~~

## 6. 实验

### 实验 A：SSE 与事实分离

断开浏览器再重连。参考验收：断线期间实时事件可能丢失，但持久事件和 Run 状态仍可读取；UI 不能据此重跑 Run。

### 实验 B：空回复

让 provider 返回空 AIMessage。参考观察：`TerminalResponseMiddleware` 触发一次重试或可见错误，而不是静默成功。

### 实验 C：边界回归

在 harness 临时 import app 后跑边界测试。参考验收：测试失败，且错误指向依赖方向，不是业务逻辑。

### 实验参考答案

1. 断线重连只恢复实时视图/历史事件，不能据此判定 Run 未完成而重跑；最终事实来自 RunRecord、journal 与 checkpoint。
2. 空回复应触发终态保护、一次受控重试或可见错误，不能静默成功。
3. harness 临时 import app 后边界测试应失败，错误应指向依赖方向违规，而不是业务断言。

## 7. 失败与恢复

| 症状 | 最可能层 | 第一证据 |
| --- | --- | --- |
| 请求 400 | 接单/白名单 | 请求校验与模型配置 |
| Run 一直 pending | worker/队列 | RunRecord 与 lease |
| 重复工具写 | 幂等/middleware | journal 与 receipt |
| 成功但无产物 | 交付验证 | delivery content 与 outputs |
| 前端重复消息 | 事件投影/消费端 | event seq 与消息 id |

## 8. 通关自测

1. 为什么边界测试比 code review 更可靠？
2. 如何判断问题在“图内”还是“图外”？
3. Run 成功但文件不存在，应先查哪两层？
4. 为什么日志不能替代 receipt？

### 参考答案

1. code review 只能抽样；边界测试在 CI 中持续验证所有导入关系，能阻止无意的反向依赖长期积累。
2. 先看 checkpoint/journal 是否记录了图节点与模型/工具事件。若图已正常结束，问题多在交付、事件投影或 UI；若图未推进，问题在装配、模型、工具或状态。
3. 先查交付验证与 receipt，再查 sandbox/outputs 的真实文件与路径映射。不能只看模型文本或 Run 的 `success` 字段。
4. 日志是观测输出，可能缺失、截断或没有顺序保证；receipt 是与调用/Run 绑定的事实凭证。证明副作用是否发生要靠 receipt、readback 和产物，而不是“日志里好像有”。

## 9. 源码坐标

- `backend/tests/test_harness_boundary.py`
- `backend/tests/` 下的 Run、middleware、sandbox 测试
- `backend/packages/harness/deerflow/runtime/journal.py`
- `backend/packages/harness/deerflow/runtime/events/`

## 10. 下一步

进入阶段 9：选一个真实改造，把接单、装配、执行、证据和恢复串成自己的作品。
