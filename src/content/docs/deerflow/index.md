---
title: "DeerFlow 2.1 源码课 · 导读"
description: "DeerFlow 2.1 源码课导读：七块总表、阅读顺序、关键边界与学习完成标准。"
---

:::note[独立学习笔记]
这是基于 [DeerFlow](https://github.com/bytedance/deer-flow) 版本 v2.1.0（提交 345f08be）源码与公开文档整理的独立学习笔记，不是官方文档。本站不包含上游源码；下文以 $DEERFLOW_SRC 表示你自己的本地源码目录。
:::

> 基线：`deer-flow-2.1`，Git tag `v2.1.0`，提交 `345f08be00c8a9495079b732a39b46aa9af1584e`（2026-09-24）。
> 本文所有路径都相对 `$DEERFLOW_SRC`。
> 旧版讲义不在本仓库中；本课只以 v2.1.0 源码为准，旧版结论不再作为依据。

## 一句话理解 DeerFlow

**DeerFlow 是一个以 LangGraph 为执行内核的“超级 Agent Harness”：Gateway 负责可信地创建 Run，RunManager/worker 负责让 Run 可靠地跑完，Lead Agent 及其 middleware/tools 负责一轮轮调用模型和工具，checkpoint、event store 与 sandbox 则负责让结果可恢复、可审计、可交付。**

把它想成一座工厂：

```text
用户/渠道
   │ 请求
   ▼
Gateway（门卫 + 接单台）──► RunManager（工单系统）──► worker（车间主任）
                                                       │
                                                       ▼
                                           Lead Agent / LangGraph（生产线）
                                             │        │        │
                                           Model    Tools   Middleware
                                             │        │        │
                                             └──► Sandbox / MCP / Skills
                                                       │
                                                       ▼
                                   Checkpoint + Event Store + Outputs（账本与仓库）
                                                       │
                                                       ▼
                                                SSE / IM / 前端
```

## 七块总表

| 部件 | 要回答的问题 | DeerFlow 的答案 | 主要源码 |
| --- | --- | --- | --- |
| 循环 | 一轮怎样推进，何时停？ | LangGraph graph + middleware 链，worker 消费 `astream` | `packages/harness/deerflow/agents/`、`runtime/runs/worker.py` |
| 上下文 | 给模型看什么，怎样压缩和恢复？ | `ThreadState.messages` + checkpoint + summarization + memory | `agents/thread_state.py`、`middlewares/summarization_middleware.py` |
| 工具 | 模型能做什么，在哪里执行？ | built-in tools、sandbox tools、MCP、skills、tool search | `tools/`、`sandbox/`、`mcp/` |
| 模型接入 | 怎样统一多厂商、多推理档位？ | `create_chat_model()` + 配置白名单 + provider adapters | `models/factory.py` |
| 扩展 | 核心之外怎样长能力？ | skills、MCP、extension API、plugins、IM channels | `skills/`、`extensions/`、`app/channels/` |
| 界面 | 人、程序、IM 怎样使用同一引擎？ | Web UI、REST/SSE、IM、TUI、Embedded Python Client | `frontend/`、`app/gateway/`、`client.py` |
| 工程 | 为什么改动不会把系统弄坏？ | harness/app 边界、测试、迁移、租约、鉴权、追踪 | `backend/tests/`、`gateway/`、`persistence/` |

三条纵线贯穿每一块：

1. **事件流**：HTTP/IM 输入 → Run 事件 → SSE/数据库 → 前端/渠道。
2. **信任边界**：客户端输入、服务端 RunContext、sandbox、模型和外部 MCP 各自能信什么。
3. **Token/成本**：上下文预算、summarization、tool output budget、token usage、模型选择。

## 阅读顺序

| 顺序 | 文档 | 你会得到什么 |
| --- | --- | --- |
| 0 | [全局地图](overview/) | 产品定位、服务拓扑、目录职责、术语 |
| 1 | [一次 Run 的一生](run-lifecycle/) | 从 HTTP 请求到终态的完整源码主线 |
| 2 | [核心机制](core-mechanisms/) | 上下文、工具、沙箱、多 Agent、模型、平台与可靠性 |
| 3 | [工程实战](engineering/) | 调试路径、源码实验、设计取舍、自测与迁移练习 |

## 阶段课（源码深入）

总览之后，按 [阶段导读](learning-path/) 从阶段 0 走到阶段 9。`00`～`03` 负责建立全局与机制直觉；阶段卷沿真实源码拆开 ownership、状态迁移、失败恢复和可观察实验，每篇自测与练习均附参考答案。

## 推荐读法

- **第一遍不要追每个 middleware**。先抓住 `start_run → worker → make_lead_agent → astream → 终态`。
- **第二遍带着三个问题读**：这个状态谁拥有？失败后从哪里恢复？哪些字段绝不能被客户端伪造？
- **第三遍做实验**：改一个 run 字段、加一个 middleware、读一条 SSE 事件，再从测试反推契约。

## 最容易混淆的四件事

1. **Thread 不是 Run**：Thread 是长期会话账本；Run 是其中一次有开始、状态和终点的执行。
2. **Checkpoint 不是业务数据库**：checkpoint 保存 LangGraph 的可恢复状态；用户、项目、定时任务等业务数据走 app 的持久化层。
3. **Memory 不是当前上下文**：当前上下文在 `messages` 里；长期 memory 是跨会话检索/注入的另一条通路。
4. **Subagent 不是另起一个产品**：它仍是同一 Run 体系下的受控执行单元，有独立事件命名空间、预算和容量限制。

## 学习完成标准

读完后应能不看文档回答：

- 一次 `POST /api/threads/{id}/runs` 经过哪些对象，Run 在什么时刻从 `pending` 变 `running`？
- 为什么 `start_run` 是授权与 RunContext 的唯一咽喉点？
- SSE 事件、Run journal、checkpoint、长期 memory 各自保存什么？
- 工具执行为什么必须经过 sandbox lease 和 middleware，而不是直接调用宿主 shell？
- 多 Agent、定时任务、IM 渠道为什么都复用 `start_run`，而不是各自写一套循环？

### 学习完成标准参考答案

1. **请求对象链**：路由 `create_run` → `gateway.services.start_run()` 做权限、模型白名单、线程归属和上下文清洗 → `RunManager.create_or_reject()` 原子写入 `pending` → 同步挂接后台 worker → worker 在 `RunManager.try_start()` 中做条件状态迁移并取得 lease → 才变成 `running` → `make_lead_agent()` 组装 LangGraph → `astream` 执行 → `RunJournal`/`StreamBridge` 产出事件 → 交付验证与 receipt → 终态。**HTTP 返回时通常还只是 pending；pending→running 发生在 `try_start()` 接受开工、记录仍为 pending 且 lease/owner 成立之后。**
2. **因为 Run 创建有多条入口，但只能有一套接单规则。** `start_run()` 统一做取消权限、模型白名单、线程 owner 检查、secret 清洗、客户端上下文白名单合并、认证用户注入和原子准入；如果把这些规则放到某个 router，定时任务、IM 或内部调用就能绕过。它同时构造服务端可信的 RunContext，确保客户端只能表达偏好，不能伪造身份、项目归属、租约或终态。
3. **SSE** 是事件流的传输/订阅视图，默认绑定 owner worker；`RunJournal` 记录运行期事件、token、工具与交付事实，可被 event store 持久化并回放；**checkpoint** 保存 LangGraph 的图状态和恢复点；**长期 memory** 保存跨会话检索的偏好与事实。SSE 不是事实源，checkpoint 不是审计日志，memory 也不是当前上下文。
4. **sandbox lease** 负责隔离执行、虚拟路径到真实环境的映射、资源占用和并发使用；**middleware** 负责工具可见性、授权/审批、输出预算、结果配对、错误分类和取消收尾。直接调用宿主 shell 会把模型参数变成宿主机权限，绕过路径越界检查、用户授权、资源回收和审计，也无法在多 worker 下证明谁在执行。工具是“受控能力”，不是任意进程调用的薄包装。
5. **所有新 Run 的创建都复用 `start_run()`，子 Agent 则复用同一 Run 的受控 runtime。** 定时任务、IM 渠道、批量和内部通知只负责把输入翻译成 `RunCreateRequest`，然后共享接单、幂等、取消、lease、SSE、交付和审计语义；子 Agent 在同一 Run 内分配预算、事件命名空间和容量，而不是另建一套模型循环。否则不同入口的策略会漂移，安全与恢复边界也无法统一。

> **一句话总结：DeerFlow 的核心不是“让模型多调几次工具”，而是把一次 Agent 执行变成可接单、可隔离、可恢复、可审计、可交付的 Run。**
