---
title: "00 · 全局地图：先建立不会迷路的坐标系"
description: "从产品、运行和源码三个视角，建立 DeerFlow 2.1 的全局坐标系。"
---

> 基线：DeerFlow `v2.1.0`（`345f08be`）。本篇不追细节，只回答四件事：它是什么、由谁组成、代码放在哪里、一次请求会穿过哪些层。

## 1. 它解决的是什么问题

普通聊天机器人只有“模型 + 对话”。DeerFlow 要解决的是更工程化的问题：

- 任务可能持续很久，需要**恢复**；
- 模型需要读文件、跑命令、上网、调用外部服务，需要**隔离与权限**；
- 上下文会超过窗口，需要**压缩、预算和长期记忆**；
- 一个任务可能需要**多个子 Agent**并行；
- 同一次执行要同时服务 Web、API、IM、TUI，需要统一的**事件与状态**；
- 出错后必须知道“哪一步失败、能不能重试、是否已经产生副作用”。

所以 DeerFlow 的核心对象不是一条 chat message，而是一次 **Run**。

## 2. 三种视角看同一个系统

### 产品视角

它既能做深度研究，也能做“超级 Agent”任务：网页检索、文件处理、代码执行、报告生成、定时任务、IM 机器人。

### 运行视角

```text
Browser / IM / SDK
        │
        ▼
Nginx (2026) ──► Next.js frontend (3000)
        │
        └────────► FastAPI Gateway (8001)
                         │
                         ├── Auth / CSRF / Trace
                         ├── start_run()
                         ├── RunManager + worker
                         ├── StreamBridge (SSE)
                         └── Scheduler / Channels / MCP Tasks
                                      │
                                      ▼
                         LangGraph Lead Agent + Middleware
                           │        │         │
                         Model    Tools     Memory
                           │        │         │
                           └── Sandbox / MCP / Skills
                                      │
                                      ▼
                       Checkpoint / Event Store / PostgreSQL
                                      │
                                      ▼
                              outputs + SSE + reply
```

`sandbox provisioner`（默认 8002）是隔离执行面的控制服务；在 Docker 模式下为 sandbox 容器准备/回收资源，在 Kubernetes 模式下创建 sandbox Pod。

### 源码视角

```text
backend/
├── packages/harness/deerflow/   # 可发布的内核：agent、tools、sandbox、models、memory...
├── packages/extension-api/      # 扩展契约
└── app/                         # 不可发布的应用层
    ├── gateway/                 # FastAPI、鉴权、Run API、渠道/调度装配
    ├── channels/                # Feishu / Slack / Telegram / Discord / DingTalk...
    ├── scheduler/               # 定时任务
    └── mcp_tasks/               # 持久化 MCP 任务的通知/回写

frontend/                        # Next.js 产品界面
contracts/                       # 跨组件契约
deploy/                          # Compose / Helm 等部署资产
```

## 3. 最重要的架构边界：Harness 与 App 单向依赖

这是 DeerFlow 源码阅读的第一条硬规则：

```text
app/*  ───────►  deerflow/*     允许
deerflow/* ───►  app/*          禁止
```

原因不是“目录好看”，而是：

- `deerflow` 要能被 Embedded Client、SDK 或其他宿主复用；
- 如果内核反向依赖某个 Web 路由、IM 渠道或数据库表，它就不再是通用 harness；
- 边界由 `backend/tests/test_harness_boundary.py` 在 CI 中强制执行。

读代码时的判断方法：

- 看到 `from deerflow...`：你在读可复用内核；
- 看到 `from app...`：你在读某个产品部署的装配层；
- 看到 `deerflow` 里 import `app`：这是 bug，不是新架构。

## 4. 七块分别落在哪里

| 块 | 核心职责 | 首先打开的文件 |
| --- | --- | --- |
| 循环 | 建图、跑图、消费事件、收尾 | `agents/factory.py`、`runtime/runs/worker.py` |
| 上下文 | 消息状态、压缩、记忆、checkpoint | `agents/thread_state.py`、`agents/middlewares/summarization_middleware.py`、`runtime/journal.py` |
| 工具 | 工具注册、执行、结果预算、审批/围栏 | `tools/tools.py`、`sandbox/tools.py`、`agents/middlewares/read_before_write_middleware.py` |
| 模型 | 模型白名单、provider、推理档位、追踪 | `models/factory.py`、`config/model_config.py` |
| 扩展 | skills、MCP、Python extension、IM | `skills/`、`mcp/`、`extensions/`、`app/channels/` |
| 界面 | REST/SSE、Web、IM、TUI、Python Client | `app/gateway/routers/`、`frontend/src/`、`client.py` |
| 工程 | 鉴权、租约、迁移、测试、可观测性 | `app/gateway/`、`runtime/runs/manager.py`、`persistence/` |

三条纵线：

- **事件流**：`Run journal → event store → StreamBridge → SSE/IM`，用于“看见过程”。
- **信任边界**：`HTTP 输入 → 白名单 RunContext → middleware/tool → sandbox`，用于“谁能影响什么”。
- **Token/成本**：`上下文测量 → summarization → tool output budget → token budget → usage 聚合`，用于“花多少、何时停”。

## 5. 六个最容易混的对象

| 对象 | 是什么 | 不是什么 |
| --- | --- | --- |
| `Thread` | 长期对话容器，多轮 Run 共享历史 | 一次执行 |
| `Run` | 一次有状态、有终点的执行 | 一条消息 |
| `RunRecord` | Run 在内存/持久化层的控制记录 | 完整聊天记录 |
| `Checkpoint` | LangGraph 的可恢复状态快照 | 业务数据库 |
| `Journal/Event Store` | 过程事件账本，供审计、回放、SSE | 模型上下文本身 |
| `Memory` | 跨会话长期事实/偏好 | 当前窗口里的消息 |

再补两个：

- **Sandbox** 是工具的执行环境，不等于“工具本身”；工具是接口，sandbox 是承载动作的边界。
- **Subagent** 是同一 Run 内受容量/预算/权限约束的执行单元，不是另一个 Gateway。

## 6. 配置与运行入口

主配置是仓库根部的 `config.yaml`，扩展配置是 `extensions_config.json`。配置负责模型白名单、sandbox provider、summarization、memory、MCP、渠道、调度、鉴权等。

常见启动方式：

```powershell
# 本地全栈开发（具体以 Makefile / 当前环境脚本为准）
make dev

# Docker 生产入口，默认聚合成一个入口
make up
```

源码入口：

- Gateway ASGI：`backend/app/gateway/app.py` 的 `app`
- LangGraph 工厂：`backend/packages/harness/deerflow/agents/__init__.py` 的 `make_lead_agent(config)`
- 嵌入式客户端：`backend/packages/harness/deerflow/client.py`
- 前端：`frontend/src/`

## 7. 一张“读源码路线图”

```text
① 找请求入口
   app/gateway/app.py
   app/gateway/routers/*

② 找统一接单口
   app/gateway/services.py::start_run

③ 找 Run 生命周期
   runtime/runs/manager.py
   runtime/runs/worker.py

④ 找 Agent 组装
   agents/__init__.py::make_lead_agent
   agents/lead_agent/agent.py
   agents/factory.py::create_deerflow_agent

⑤ 找中间件/工具/模型
   agents/middlewares/
   tools/
   models/factory.py

⑥ 找持久化与输出
   runtime/journal.py
   runtime/checkpointer/
   runtime/stream_bridge/
   app/gateway/services.py 的终态/交付逻辑
```

## 8. 本篇自测

1. 为什么 `deerflow` 不能 import `app`？如果破坏了，会损失哪种复用能力？
2. `Thread`、`Run`、`Checkpoint`、`Memory` 各回答什么问题？
3. 8001/8002/3000/2026 这四个端口分别对应什么角色？
4. 一次 Run 的事件要经过哪几层才能到浏览器？
5. 如果只看 `messages`，会漏掉哪类系统事实？

### 参考答案

1. **因为 `deerflow` 是可复用内核，`app` 是某个宿主的装配层。** 内核反向依赖 Web 路由、IM 渠道或某个数据库表后，Embedded Client、SDK、测试宿主和其他产品就不能独立复用；`backend/tests/test_harness_boundary.py` 会把这种退化变成 CI 失败。
2. **Thread** 回答“这段长期对话是什么、历史归谁”；**Run** 回答“其中哪一次执行正在发生、处于什么状态”；**Checkpoint** 回答“LangGraph 执行到哪、恢复需要哪些图状态”；**Memory** 回答“跨会话还应记住哪些偏好/事实”。四者生命周期和一致性目标不同，不能合并。
3. `2026` 是 Nginx 入口；`3000` 是 Next.js 前端；`8001` 是 FastAPI Gateway；`8002` 是 sandbox provisioner 控制服务。
4. 主链路是：worker 产生 `RunJournal` 事件 → `StreamBridge`（memory 或 Redis）→ Gateway 的 SSE consumer/路由 → 浏览器。断线重放时还要经过 event store 的持久化事件与 `Last-Event-ID` 语义。
5. 只看 `messages` 会漏掉控制面事实：Run 状态、租约/owner、幂等键、取消、工具失败分类、token/usage、事件顺序、交付 receipt、workspace 产物和审计信息。`messages` 是模型上下文投影，不是系统账本。

下一篇将只沿一条主线走：`POST /api/threads/{id}/runs` 如何变成一次可恢复、可观察、可交付的 Run。
