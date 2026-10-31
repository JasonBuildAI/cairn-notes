---
title: "阶段 0：环境与源码地图"
description: "阶段 0：环境与源码地图。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：DeerFlow 源码课 · 阶段卷
> 前置：会读 Python、TypeScript，知道 HTTP 与异步任务
> 对应总览：`00-全局地图.md`
> 本阶段目标：在看到任意文件时，能判断它属于“可复用内核”“产品装配层”还是“运行资产”。

## 1. 本阶段解决什么

DeerFlow 的代码量不小，但入口并不多。先建立三层地图：

~~~text
backend/packages/harness/deerflow/   可复用内核：agent、tools、sandbox、models、runtime
backend/packages/extension-api/      扩展合同
backend/app/                         产品装配：Gateway、渠道、调度、MCP 任务
frontend/ + contracts/ + deploy/     界面、跨端合同、部署资产
~~~

最重要的硬边界是：

~~~text
app/*        → deerflow/*       允许
deerflow/*   → app/*            禁止
~~~

这不是目录洁癖。`deerflow` 要能被嵌入式客户端、SDK 和其他宿主复用；一旦内核 import 了某个 Web 路由或 IM 表，它就不再是通用 harness。`backend/tests/test_harness_boundary.py` 把这条规则变成 CI 失败。

## 2. 先记住一个判断

**“这段代码能否脱离 DeerFlow 的某个具体产品入口存在？”**

能，通常属于 harness；不能，通常属于 app。看到 `from deerflow...`，你在读内核；看到 `from app...`，你在读宿主装配。内核里出现 `app` 依赖，是边界退化，不是“方便复用”。

## 3. 源码主线

1. ASGI 入口在 `backend/app/gateway/app.py`，路由在 `backend/app/gateway/routers/`。
2. 统一接单函数是 `backend/app/gateway/services.py::start_run`。
3. Run 控制面在 `runtime/runs/manager.py`，执行面在 `runtime/runs/worker.py::run_agent`。
4. Agent 工厂是 `agents/__init__.py::make_lead_agent`，最终进入 `agents/lead_agent/agent.py` 和 `agents/factory.py`。
5. 能力边界由 `tools/`、`sandbox/`、`models/`、`mcp/`、`skills/` 分别承接。
6. 状态与证据由 `runtime/checkpointer/`、`runtime/journal.py`、`runtime/events/` 承接。
7. 产品扩展在 `backend/app/channels/`、`backend/app/scheduler/`、`backend/app/mcp_tasks/`。

## 4. 关键对象与合同

| 对象 | 拥有的事实 | 不应被谁伪造 |
| --- | --- | --- |
| `RunRecord` | run 状态、owner、租约、幂等键 | 客户端、单个 middleware |
| `ThreadState.messages` | 当前图的对话状态 | 外部请求中的任意 metadata |
| checkpoint | LangGraph 可恢复状态 | 业务数据库记录 |
| `RunJournal` | 运行事件、工具/交付事实 | SSE 消费端 |
| sandbox lease | 某次隔离执行的使用权 | 模型生成的路径参数 |

## 5. 一条可观察链路

~~~text
frontend / SDK
  → app.gateway.app
  → routers/thread_runs.py
  → services.start_run
  → RunManager
  → worker.run_agent
  → make_lead_agent
  → tools / sandbox / model
  → journal / checkpoint
~~~

观察点：请求返回时 Run 往往还是 `pending`；真正的 `running` 在 worker 的 `try_start()` 之后出现。不要用 HTTP 返回时间推断模型已经开始执行。

## 6. 实验

### 实验 A：确认边界

~~~powershell
rg -n "from app" backend/packages/harness/deerflow
~~~

参考验收：不应出现内核依赖 app 的合法命中；若出现，先判断是不是测试或兼容桥。

### 实验 B：确认配置入口

打开根目录 `config.example.yaml`，找出模型白名单、sandbox provider、summarization、memory、channel 五类配置。参考观察：配置是“允许什么”，不是“客户端想用什么”。

### 实验 C：画端口图

把 `3000`、`8001`、`8002`、`2026` 分别标到前端、Gateway、sandbox provisioner、反向代理。验收点是每个端口只承担一个清晰角色。

### 实验参考答案

1. 合法结果应只在测试、样例或明确的兼容桥出现 `from app`；harness 生产代码若依赖 app，说明内核边界被反转。
2. 应能分别定位模型白名单、sandbox provider、summarization、memory 和 channel 配置；它们约束服务端允许什么，客户端请求只能在这些约束内选择。
3. 按仓库实际配置确认每个端口的唯一职责：前端、Gateway/API、sandbox provisioner、反向代理不要互相串用；端口图的价值是暴露错误耦合。

## 7. 失败与恢复

| 现象 | 首先检查 | 不应做什么 |
| --- | --- | --- |
| 启动即 import error | 依赖、Python 版本、工作目录 | 改业务代码掩盖环境问题 |
| harness 反向依赖 app | `test_harness_boundary.py` | 把测试删掉 |
| 前端连不上 | Gateway 端口、代理、鉴权 | 直接绕过 `start_run` |
| sandbox 无法启动 | provisioner 与 provider 配置 | 改用宿主 shell“先跑通” |

## 8. 通关自测

1. `deerflow` 为什么不能 import `app`？
2. `RunRecord`、checkpoint、`RunJournal` 各保存什么？
3. 为什么不能通过 HTTP 返回判断 Run 已经 `running`？
4. 端口 `8001` 和 `8002` 的职责如何区分？

### 参考答案

1. 因为 `deerflow` 是可复用内核，`app` 是某个产品宿主的装配层。反向依赖会把内核绑死到具体 Web/IM/数据库，损失嵌入式客户端、SDK 和其他宿主的复用能力，也会被边界测试阻断。
2. `RunRecord` 保存控制面状态、owner、租约和幂等；checkpoint 保存 LangGraph 的可恢复图状态；`RunJournal` 保存过程事件、token、工具和交付事实。前者管调度，中者管续跑，后者管观察与审计。
3. 路由返回的是接单结果，Run 可能仍是 `pending`。只有 worker 通过 `try_start()` 完成状态迁移并取得所有权后才是 `running`；这段延迟正是排队、取消和并发竞争的窗口。
4. `8001` 是 FastAPI Gateway，负责接单、鉴权、SSE 和产品装配；`8002` 是 sandbox provisioner 控制服务，负责隔离环境的准备与回收，不承担 Run 生命周期。

## 9. 源码坐标

- `backend/tests/test_harness_boundary.py`
- `backend/app/gateway/app.py`
- `backend/app/gateway/services.py`
- `backend/packages/harness/deerflow/agents/__init__.py`
- `backend/packages/harness/deerflow/runtime/runs/manager.py`

## 10. 下一步

进入阶段 1：把“接单”拆成可验证的状态迁移，并解释为什么 `pending` 不是装饰状态。
