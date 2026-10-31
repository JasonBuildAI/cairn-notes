---
title: "阶段 3：上下文与记忆"
description: "阶段 3：上下文与记忆。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：DeerFlow 源码课 · 阶段卷
> 前置：阶段 2
> 对应总览：`02-核心机制.md` 的上下文部分
> 本阶段目标：区分当前消息、压缩结果、checkpoint 与长期 memory。

## 1. 本阶段解决什么

模型不会自动“记得项目”。每一轮看到的都是被投影出来的上下文：

~~~text
ThreadState.messages
  + 动态日期/记忆/技能提醒
  + 当前工具结果
  - 超出预算的旧内容
  → 本次模型请求
~~~

DeerFlow 用多种 middleware 分别处理“注入什么”“压缩什么”“花多少 token”“哪些结果可回放”。

## 2. 先记住一个判断

**当前上下文是投影，checkpoint 是恢复点，memory 是跨会话事实。**

三者生命周期不同。把 memory 当成当前窗口，会重复注入；把 checkpoint 当成聊天记录，会丢失事件和交付；把 journal 当成模型上下文，会把审计数据塞进 prompt。

## 3. 源码主线

1. `agents/thread_state.py` 定义图状态，核心是消息及运行期字段。
2. `DynamicContextMiddleware` 在首条 HumanMessage 前后注入日期、记忆等动态提醒，保持 system prompt 稳定。
3. `MemoryMiddleware` 在 `after_agent` 回收本轮可长期保留的事实；`agents/memory/manager.py` 负责后端。
4. `SummarizationMiddleware` 在模型调用前测量并压缩历史，生成摘要以继续对话。
5. `TokenBudgetMiddleware` 对整轮预算设硬上限；`TokenUsageMiddleware` 记录实际用量。
6. `DurableContextMiddleware` 让关键动态上下文可恢复，而不是只存在于一次请求。
7. worker 在 checkpoint 中保存图状态；`RunJournal` 保存运行事件和交付事实。

## 4. 关键对象与合同

| 对象 | 保存内容 | 典型错误 |
| --- | --- | --- |
| `ThreadState.messages` | 当前图消息 | 把 UI 列表当模型上下文 |
| summarization 摘要 | 压缩后的可继续对话视图 | 把摘要当归档原文 |
| checkpoint | 图状态和恢复身份 | 用业务数据库替代 |
| memory | 跨会话偏好/事实 | 每轮全量注入 |
| `RunJournal` | 事件、token、工具、交付 | 让模型直接读取 |
| token budget | 本轮成本上限 | 只在 UI 层限流 |

## 5. 一条可观察链路

~~~text
checkpoint 读取历史
  → DynamicContext / memory 注入
  → token 测量
  → Summarization 压缩
  → 工具结果预算
  → 模型请求
  → usage 记录
  → 新 checkpoint
~~~

重点观察：`messages` 变短不一定代表数据丢失，可能是发送前的投影；checkpoint 仍然保留可恢复状态，journal 仍然保留事实。

## 6. 实验

### 实验 A：制造一次压缩

把 summarization 阈值调低，发送足够长的对话。参考验收：模型请求中出现摘要或压缩标记，原始事件仍可在 journal/checkpoint 链路中找到证据。

### 实验 B：比较 memory 开关

关闭 `MemoryMiddleware`，重复同一会话。参考观察：当前消息仍在，但跨会话偏好注入消失；这说明 memory 与 transcript 是两条路。

### 实验 C：验证工具输出预算

让工具返回超大文本。参考验收：模型看到的是被截断/摘要化的结果，而 tool receipt 仍能定位原始输出及截断事实。

### 实验参考答案

1. 请求侧应出现摘要或压缩标记；原始历史仍应由 journal/checkpoint/事件链保留，压缩不能销毁审计证据。
2. 关闭 memory 后，当前 transcript 仍存在，但跨会话偏好注入消失；这证明 memory 是额外注入通道，不是会话消息本身。
3. 模型侧输出应有界，receipt/日志仍能定位原始结果和截断事实；截断是显式信息，不是静默丢失。

## 7. 失败与恢复

| 失败 | 事实在哪 | 恢复原则 |
| --- | --- | --- |
| 压缩模型失败 | 原消息与压缩事件 | 保留原历史，重试或降级 |
| 上下文仍超窗 | token 估算与 provider 错误 | 重新测量，不要假装已压缩 |
| memory 写入失败 | 当前候选事实 | 不阻断主 Run，记录失败 |
| checkpoint 损坏 | journal 与事件 | 从可恢复点重建，不伪造消息 |
| 动态上下文重复 | 注入 middleware 与首条消息 | 去重，不修改历史原文 |

## 8. 通关自测

1. 为什么 `messages` 短了不等于历史丢了？
2. checkpoint、journal、memory 能否互相替代？
3. 为什么动态上下文要尽量不破坏 system prompt 前缀？
4. 工具输出预算与上下文压缩解决的是同一个问题吗？

### 参考答案

1. `messages` 是发送给当前模型轮的投影，可能经过 summarization、工具输出截断或动态注入。恢复状态仍在 checkpoint，过程事实仍在 journal；投影变短不等于 canonical 历史被删除。
2. 不能。checkpoint 管图恢复，journal 管过程与审计，memory 管跨会话偏好；它们面对的生命周期和一致性目标不同。
3. 稳定前缀有利于 prompt cache、复现和审计。把日期、记忆等易变内容放到受控位置，可以避免每轮重写整个 system prompt。
4. 不是。上下文压缩处理消息历史的窗口压力；工具输出预算限制单次工具结果和聚合结果。两者都影响 token，但作用对象和恢复语义不同。

## 9. 源码坐标

- `backend/packages/harness/deerflow/agents/thread_state.py`
- `backend/packages/harness/deerflow/agents/middlewares/dynamic_context_middleware.py`
- `backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py`
- `backend/packages/harness/deerflow/agents/middlewares/memory_middleware.py`
- `backend/packages/harness/deerflow/agents/memory/manager.py`
- `backend/packages/harness/deerflow/runtime/journal.py`

## 10. 下一步

进入阶段 4：模型看到上下文后决定调用工具，这个工具最终在哪里执行？
