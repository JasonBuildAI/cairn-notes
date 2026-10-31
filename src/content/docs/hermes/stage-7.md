---
title: "阶段 7：扩展平台与多 Agent"
description: "阶段 7：扩展平台与多 Agent。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：Hermes Agent 源码课 · 阶段卷
> 前置：阶段 1、4、6
> 对应总览：`02-核心机制.md` 第 6～7 节，`03-工程实战.md` 第 6 节
> 本阶段目标：理解 Hermes 怎样长出工具、provider、渠道、调度与子 Agent，而不是复制一套核心循环。

## 1. 本阶段解决什么

一个长期演进的 Agent 平台会遇到持续的扩展需求：

- 给模型增加一个只读工具；
- 增加一个新 toolset；
- 接入一个新模型 provider；
- 从 Telegram、Slack、Discord 或 Web 收消息；
- 每天定时执行任务；
- 启动一个子 Agent 处理可并行的子问题；
- 给 TUI 增加一个 RPC 方法；
- 用 plugin 在不改核心的情况下组合能力。

难点不是“加代码”，而是每类扩展应接在哪个所有权边界上。

## 2. 先记住一个判断

**扩展点只扩展一层能力，不复制整条 turn 语义。**

正确姿势：

~~~text
新工具         → tools/ + toolsets.py + model_tools 可见性
新 provider    → ProviderProfile + adapter + credential/fallback
新渠道         → adapter 入站构造 admission，出站走 delivery
新 RPC/UI      → tui_gateway method + contract，执行仍归宿主
新定时任务     → cron 产生 internal event/admission
新子 Agent     → delegate tool + 独立执行上下文 + 父级收回结果
新 plugin      → register 能力，不绕过权限与持久化
~~~

反例：渠道 adapter 自己构造 `AIAgent` 并直接写 transcript；cron 绕过 FIFO 直接调用模型；子 Agent 共享父 transcript 乱写；plugin 把任意副作用藏在 import 阶段。

## 3. 源码主线

1. `plugins/plugin_loader.py` 支持目录插件、模块加载、相对 import、注册和 bounded wait。加载锁与 deadlock 检测说明插件 import 本身就是高风险管理。
2. 插件通常通过 `register(ctx)` 或继承已定义的 ABC 注册工具、provider、渠道/能力；它不是权限沙箱，拥有执行任意 Python 的信任。
3. `toolsets.py` 与 `model_tools.py` 决定工具面；新增工具必须同时考虑 schema、平台、授权、预算、错误与投影。
4. `providers/base.py` 与 `providers/__init__.py` 是模型 provider 的扩展点；用户 provider 更适合放 `$HERMES_HOME/plugins/model-providers/`。
5. `gateway/run.py::GatewayRunner` 持有 Gateway 宿主、adapter、session runtime 和后台维护；消息平台入站最终仍走 SessionAuthority。
6. `tui_gateway/session_registry.py` 构建并缓存共享后端 Agent；`prompt_turn.py` 负责 prompt 输入、执行、结果吸收和事件。
7. `gateway/run_turn_runner.py::TurnRunner` 把流式输出、工具进度、审批和最终交付接到一次 turn。
8. `cron/scheduler.py` 处理 due jobs、tick lock、外部 worker、重试、崩溃恢复与 delivery；它产生的是带 source 的任务，不是另一套 Agent 语义。
9. `tools/delegate_tool.py` 暴露子 Agent 能力；父子各自有上下文与执行边界，父 Agent 通过工具结果获得子任务输出。
10. `acp_adapter/`、消息 adapter 与 `ui-tui/`、`apps/desktop/` 展示不同入口，但都应以统一 admission/event 协议连接宿主。

## 4. 关键对象与合同

| 扩展 | 接入点 | 不能绕过 |
| --- | --- | --- |
| tool | `tools/` + schema | toolsets、授权、审批、持久化 |
| toolset | `toolsets.py` | platform gating、include 环、递归 |
| provider | `ProviderProfile` + adapter | credential、preflight、tool schema |
| plugin | `plugin_loader` + context | 信任边界、加载超时、顺序 |
| skill | skills index + volatile prompt | 权限逻辑不能写进 skill 文本 |
| channel | adapter + SessionAuthority | 鉴权、FIFO、去重、delivery |
| RPC/UI | `tui_gateway` contract | 执行归属、session scope |
| cron | scheduler + internal event | lease、session 隔离、重启恢复 |
| subagent | delegate tool | 容量、超时、父子生命周期 |
| MCP | server/tool bridge | 工具可见性、审批、输出预算 |

插件信任模型尤其要记住：plugin 能注册能力，也能执行任意 Python。它不是一个因为叫“插件”就自动安全的沙箱。安装前审查来源，加载失败和超时必须有确定降级。

## 5. 一条可观察链路

### 渠道消息

~~~text
Telegram/Discord/Slack event
  → adapter 鉴权与身份映射
  → 规范化 payload
  → SessionAuthority admission
  → FIFO / turn lease
  → 同一个 AIAgent 核心
  → deliver through adapter
~~~

### 子 Agent

~~~text
parent assistant tool_calls
  → delegate_task
  → child execution context / budget / timeout
  → child result
  → tool result persisted
  → parent continues
~~~

### Cron

~~~text
due job
  → tick lock / owner check
  → internal event or worker
  → session-scoped admission
  → turn execution
  → delivery / retry / crash recovery
~~~

观察重点：所有路径最终都应落到同一条“admission → lease → loop → finalize”的主线，而不是各写一个 while。

## 6. 实验

### 实验 A：新增只读工具

实现 `list_recent_notes`，加入 toolset，并验证模型可见、平台限制、错误和超大输出。

### 实验 B：cron 与人工输入并发

让同一 session 的 cron 任务和用户输入同时到达，观察 FIFO、lease 和 transcript 顺序。

### 实验 C：子 Agent 超时

启动一个会超时的 delegate，检查父 turn 是否收到有界错误结果，子执行是否被清理。

### 实验参考答案

1. **实验 A**：工具应在允许的 toolset 中可见，参数 schema 拒绝未知输入，结果有输出预算，失败返回可解释错误；不应直接暴露宿主路径。
2. **实验 B**：两者应按 admission 顺序串行化，同一 session 不能双写；cron 的 source 可区分，但不能绕过 lease。
3. **实验 C**：父级应得到超时/失败 tool result，而不是悬挂；子执行应停止或标记为可回收，父 transcript 仍保持 call/result 配对。

## 7. 失败与恢复

| 失败 | 风险 | 正确恢复 |
| --- | --- | --- |
| plugin import 死锁 | 启动卡住 | bounded load wait，记录并降级 |
| plugin 注册重复 | 工具/渠道冲突 | 明确命名空间与覆盖规则 |
| toolset include 成环 | 递归展开失控 | 构建期检测并拒绝 |
| channel 重投 | 重复 turn | request id/平台 message id 幂等 |
| cron 与用户同时提交 | 双写 | SessionAuthority FIFO + lease |
| cron worker 崩溃 | 任务半执行 | inflight/owner/lease 恢复与 idempotency |
| subagent 超时 | 父 turn 悬挂 | 超时结果 + 生命周期清理 |
| RPC 旧 generation | 控制错 turn | generation fencing |

## 8. 通关自测

1. 新增工具为什么不能只写 handler？
2. plugin 为什么不等于安全沙箱？
3. 消息渠道为什么不能直接调用模型并写 transcript？
4. cron 任务与普通用户输入在哪些层共享，哪些层不同？
5. 子 Agent 和父 Agent 如何交换结果？
6. 新增 provider 为什么优先做用户插件而不是直接改核心？
7. 新增 RPC 方法时，执行权应放在哪里？

### 参考答案

1. 因为模型可见性、toolset 选择、授权、审批、参数校验、输出预算、错误投影和持久化都决定它能否安全执行；只写 handler 会绕过这些边界。
2. plugin 在宿主进程中执行任意 Python，注册行为可能改工具、provider 或渠道。加载隔离只能减少故障影响，不能替代来源审查和权限设计。
3. 直接调用会绕过统一 admission、FIFO、lease、幂等、审批和恢复，造成多入口状态分叉。adapter 应只做平台语义到统一协议的转换。
4. 共享 Agent 核心、admission/lease、transcript 和交付语义；不同在 source、触发方式、调度、重试策略与是否需要投递到某个渠道。
5. 父 Agent 发出 delegate tool call，子执行产生结果，结果作为 tool result 持久化后再回到父模型；不是共享同一条可随意写的 transcript。
6. 用户插件能降低核心耦合与升级成本，便于隔离实验和第三方维护；只有确实需要内置发现、稳定合同或性能路径时才进核心。
7. 执行权属于宿主/Agent 运行时。RPC 方法只负责校验、鉴权和调度，不能因为来自 TUI 就在 UI 进程里另跑一套 turn。

## 9. 源码坐标

- `plugins/plugin_loader.py`
- `toolsets.py`
- `model_tools.py::get_tool_definitions`
- `providers/base.py::ProviderProfile`
- `gateway/run.py::GatewayRunner`
- `gateway/run_turn_runner.py::TurnRunner`
- `tui_gateway/session_registry.py`
- `tui_gateway/prompt_turn.py`
- `cron/scheduler.py::_run_one_job_body`
- `tools/delegate_tool.py`
- `acp_adapter/`

## 10. 下一步

进入阶段 8：扩展越多，越需要测试、日志、失败矩阵和最小复现来守住前面七层，而不是靠“本地试了一下能跑”。
