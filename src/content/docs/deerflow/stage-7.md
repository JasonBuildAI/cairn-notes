---
title: "阶段 7：扩展渠道与多 Agent"
description: "阶段 7：扩展渠道与多 Agent。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：DeerFlow 源码课 · 阶段卷
> 前置：阶段 1、2、6
> 对应总览：`core-mechanisms.md`、`engineering.md`
> 本阶段目标：理解为什么所有新入口都应复用 `start_run`，以及子 Agent 为什么不是第二个 Gateway。

## 1. 本阶段解决什么

DeerFlow 同时服务 Web、REST、IM、TUI、嵌入式客户端、定时任务和 MCP 任务。它们形态不同，但都必须满足同一套接单、幂等、租约、事件和交付语义：

~~~text
HTTP / IM / Scheduler / MCP task / SDK
          │  翻译成 RunCreateRequest
          ▼
      services.start_run
          ▼
   RunManager + worker
          ▼
 Lead Agent → task/subagent → 同一 Run 预算与事件空间
~~~

## 2. 先记住一个判断

**入口可以多样，接单规则只能一套。**

渠道适配器只负责把外部消息翻译成可信输入和回复路由；它不能自己造 Run、绕开权限或另写一套循环。子 Agent 也是同一 Run 内受控执行单元，不是独立产品。

## 3. 源码主线

1. `backend/app/channels/` 的适配器把 Feishu、Slack、Telegram 等消息归一化。
2. 渠道服务构造 `RunCreateRequest`，最终调用 `services.start_run`。
3. `backend/app/scheduler/` 与 `launch_scheduled_thread_run` 复用同一接单口。
4. `backend/app/mcp_tasks/` 把外部任务通知转成带来源信息的 Run。
5. `backend/packages/harness/deerflow/tools/builtins/task_tool.py` 等触发子 Agent；`SubagentLimitMiddleware` 限制并发/总量。
6. 子 Agent 共享 run 资源、事件命名空间和预算，但必须隔离上下文与输出。
7. `extensions/` 和 `extension-api` 提供 middleware、工具、构建观察等扩展点。

## 4. 关键对象与合同

| 入口/能力 | 必须复用什么 | 不能自建什么 |
| --- | --- | --- |
| IM channel | `start_run`、回复路由 | 自有 Run 状态机 |
| Scheduler | 幂等、接单、取消、lease | 直接调用模型 |
| MCP task | 来源标记、接单、事件 | 绕过输入清洗 |
| Subagent | 同 Run 预算/容量/事件 | 第二个 Gateway |
| Extension | 合同注册、scope 策略 | 直接修改 Kernel 状态 |

## 5. 一条可观察链路

~~~text
外部输入
  → channel / scheduler / MCP adapter
  → RunCreateRequest（可信 metadata + context）
  → start_run
  → pending
  → worker
  → lead agent
  → task/subagent（受限并发）
  → 父 Run journal / SSE
~~~

观察点：不同入口产生的 Run 应共享同一状态机、事件格式和终态；差异只应存在于输入归一化、回复路由和来源 metadata。

## 6. 实验

### 实验 A：比较两个入口

从 HTTP 和 IM 各创建一次 Run，记录接单后的 `RunRecord`。参考验收：状态迁移、幂等、lease、事件形状一致，来源字段不同。

### 实验 B：触发子 Agent 上限

让模型发起超过 `max_concurrent_subagents` 的 task 调用。参考观察：超出的调用被 middleware 截断/拒绝，而不是由模型自行决定。

### 实验 C：加一个只读扩展

通过 extension 注入一个记录装配信息的 observer。参考验收：不改变 Run 权限和状态，只消费公开合同。

### 实验参考答案

1. 两个入口应产生同一 Run 状态机、幂等、lease 与事件形状，只有 source/metadata 不同；若状态机不同，说明渠道绕过了接单口。
2. 超过 `max_concurrent_subagents` 的调用应由 middleware 拒绝或截断，模型不能自行突破容量。
3. 只读 observer 只能消费公开合同，不改变 Run 权限、状态或写路径；扩展不得成为第二套执行权。

## 7. 失败与恢复

| 失败 | 应检查 | 恢复原则 |
| --- | --- | --- |
| IM 消息重复 | 渠道幂等键 | 复用同一 Run，不重复副作用 |
| 定时任务重放 | `start_run` 幂等 | 不新建第二张工单 |
| 子 Agent 超容量 | 服务端容量与 middleware | 排队/拒绝，不放宽边界 |
| MCP 通知丢失 | task store 与事件 | 从持久记录补发 |
| 扩展抛异常 | scope 与隔离 | 降级扩展，不破坏主 Run |

## 8. 通关自测

1. IM 渠道为什么不能直接调用 Agent 图？
2. 子 Agent 与父 Run 共享什么，隔离什么？
3. 定时任务需要复用哪些能力？
4. 扩展为什么不能直接写 Run 终态？

### 参考答案

1. 直接调用会绕过 `start_run` 的权限、模型白名单、输入清洗、幂等、lease、事件和交付。渠道层只应翻译输入和投递回复。
2. 共享同一 Run 的预算、容量、事件命名空间和生命周期；隔离子任务上下文、工具权限和输出边界，避免互相污染或无限扩张。
3. 复用统一接单、幂等键、线程归属、取消、lease、SSE/事件、交付和审计；调度器只负责决定“何时发起”，不负责“如何执行”。
4. 终态是控制面事实，必须由拥有 lease 的 worker/manager 在交付证据闭合后写入。扩展越权写入会造成某些状态无法证明、与 journal 矛盾或覆盖合法 owner。

## 9. 源码坐标

- `backend/app/channels/`
- `backend/app/scheduler/`
- `backend/app/mcp_tasks/`
- `backend/packages/harness/deerflow/tools/builtins/task_tool.py`
- `backend/packages/harness/deerflow/agents/middlewares/subagent_limit_middleware.py`
- `backend/packages/extension-api/`
- `backend/packages/harness/deerflow/extensions/`

## 10. 下一步

进入阶段 8：功能都接上了，如何用测试、边界和观测证明它没有把系统弄坏？
