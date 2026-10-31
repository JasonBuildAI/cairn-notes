---
title: "阶段 2：Agent 装配与 LangGraph 循环"
description: "阶段 2：Agent 装配与 LangGraph 循环。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：DeerFlow 源码课 · 阶段卷
> 前置：阶段 1，了解 LangGraph 的 graph/checkpoint
> 对应总览：`run-lifecycle.md`、`core-mechanisms.md`
> 本阶段目标：从 `make_lead_agent()` 一路追到模型调用与工具轮次。

## 1. 本阶段解决什么

Run 只是外壳，真正做事的是被组装出来的图：

~~~text
make_lead_agent(config)
  → assemble_lead_agent
  → 解析模型/Agent 配置
  → 创建工具
  → 构建 middleware 顺序
  → create_deerflow_agent
  → 编译 graph
  → worker astream
~~~

装配不是把所有能力一股脑塞进去，而是先判断身份、权限和运行模式，再决定哪些工具、middleware 和预算进入这一轮。

## 2. 先记住一个判断

**模型只看到装配结果，不看到装配过程。**

`messages` 里没有“这个工具为什么被隐藏”“为什么这个 middleware 在审批前”，但这些装配决定会直接改变模型的可用动作。排查 Agent 行为时，先看装配描述，再看模型输出。

## 3. 源码主线

1. `agents/__init__.py::make_lead_agent` 是 LangGraph 兼容入口。
2. `lead_agent/agent.py::assemble_lead_agent` 冻结 checkpoint 模式并返回 `LeadAgentAssembly`。
3. `_assemble_lead_agent` 解析 user、agent、model、thinking/reasoning、subagent 和 skill 配置。
4. 工具由 `tools/`、sandbox tools、memory tools、MCP、skills 等按权限合并。
5. `build_middlewares()` 按运行时条件装配动态上下文、技能、工具策略、子 Agent 限制、预算、终态保护等。
6. `agents/factory.py::create_deerflow_agent` 把 model、tools、middlewares 和 state 组装成图。
7. worker 通过 `astream` 消费 values/updates/messages 等模式，并转成 journal/SSE 事实。

## 4. 关键对象与合同

| 对象 | 作用 | 关键点 |
| --- | --- | --- |
| `LeadAgentAssembly` | 图 + 装配描述 | 让观测者不必猜私有 runtime 字段 |
| `build_middlewares` | 行为链 | 顺序决定“谁先看见/改写调用” |
| `create_deerflow_agent` | 通用图工厂 | 负责结构，不负责产品接单 |
| `SubagentLimitMiddleware` | 并发/总量限制 | 能力上限不能由模型自行放宽 |
| `TerminalResponseMiddleware` | 空响应/静默结束保护 | 避免“没回答却显示成功” |
| `ClarificationMiddleware` | 收尾门 | 固定在链尾，防止后续篡改 |

## 5. 一条可观察链路

~~~text
config
  → model_name 解析与授权
  → tools 合并
  → middleware 顺序
  → create_deerflow_agent
  → graph.astream
  → AIMessage(tool_calls)
  → tool middleware/执行
  → ToolMessage
  → 下一轮模型
  → 终态或澄清
~~~

不要只看 `agent.astream()` 的返回值；真正决定工具可见性、预算和终态的，是装配阶段形成的工具表与 middleware 链。

## 6. 实验

### 实验 A：打印装配描述

在存在 assembly observer 的路径上观察 `build_assembly_descriptor()`。参考验收：能看到 namespace、模型、工具 schema、middleware 与策略摘要。

### 实验 B：验证 middleware 顺序

在 `build_middlewares()` 前后记录列表，重点观察 `SubagentLimitMiddleware`、`TokenBudgetMiddleware`、`TerminalResponseMiddleware`、`ClarificationMiddleware` 的相对位置。参考观察：限制与终态保护在模型/工具轮次中持续生效，而不是只运行一次。

### 实验 C：对比计划模式

分别用 `is_plan_mode=false` 与 `true` 创建图，比较 `TodoMiddleware` 和工具集合。验收点是差异来自装配策略，而不是模型“自己决定”。

### 实验参考答案

1. 描述中应出现 namespace、模型、工具 schema、middleware 和策略摘要，且可由配置/装配代码解释，而不是模型运行时自报。
2. 应确认限制、预算、终态和澄清 middleware 的相对顺序；它们必须在模型与工具轮次中持续生效，顺序改变会改变谁先截断、谁先闭合。
3. 计划模式应通过不同 middleware/tool 装配改变行为；若只靠 prompt 让模型“别执行”，就不算装配级隔离。

## 7. 失败与恢复

| 装配失败 | 根因层 | 恢复方式 |
| --- | --- | --- |
| 模型配置为空 | 配置/授权 | 先修配置，不要改图 |
| 工具名冲突 | 工具注册 | 命名与去重规则 |
| 子 Agent 超限 | 容量/策略 | 调整服务端容量，不是放宽校验 |
| 空回复被当成功 | 终态 middleware | 检查 `TerminalResponseMiddleware` |
| checkpoint 模式不一致 | 运行时模式 | 保持进程级冻结模式一致 |

## 8. 通关自测

1. `make_lead_agent`、`assemble_lead_agent`、`create_deerflow_agent` 各负责什么？
2. 为什么 middleware 顺序会改变安全语义？
3. 模型的 thinking 开关为什么在装配阶段就要决定？
4. 子 Agent 的并发上限为什么不能由模型自行设置？

### 参考答案

1. `make_lead_agent` 是 LangGraph 兼容的图工厂入口；`assemble_lead_agent` 负责冻结运行模式并返回图及装配描述；`create_deerflow_agent` 负责把模型、工具、middleware 和状态结构组合成可执行图。接单、权限和产品入口不在它们里面。
2. 因为 middleware 能看到并改写模型请求、工具调用和结果。审批若放在可改写参数的 hook 之后，审批看到的就不是原始调用；预算若放在终态保护之后，可能来不及阻止超额。顺序本身就是合同。
3. thinking/reasoning 会影响模型能力与请求形状，也会影响是否启用某些视觉/上下文 middleware；先解析并授权，才能在构造模型和装配工具时做一致决策。
4. 并发子 Agent 会消耗同一 Run 的容量、事件命名空间和预算。容量是宿主资源，不是模型的愿望；模型只能请求，服务端必须按启动时冻结的上限执行。

## 9. 源码坐标

- `backend/packages/harness/deerflow/agents/__init__.py`
- `backend/packages/harness/deerflow/agents/lead_agent/agent.py`
- `backend/packages/harness/deerflow/agents/factory.py`
- `backend/packages/harness/deerflow/agents/middlewares/`
- `backend/packages/harness/deerflow/agents/assembly_descriptor.py`

## 10. 下一步

进入阶段 3：图已经会调用模型，但模型这一轮到底看见哪些消息、记忆和预算？
