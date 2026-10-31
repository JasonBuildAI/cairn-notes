---
title: "阶段 0：环境与源码地图"
description: "阶段 0：环境与源码地图。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：Hermes Agent 源码课 · 阶段卷
> 前置：无
> 对应总览：`overview.md`
> 本阶段目标：在看到任何细节前，先能判断一段代码属于入口、宿主、Agent 还是持久账本。

## 1. 本阶段解决什么

Hermes 最容易犯的读源码错误，是把“能调用 `run_conversation()` 的对象”都当成同一个执行者。实际有四类角色：

~~~text
入口/渲染层   经典 CLI、TUI、Desktop、消息平台
     │ 提交/回放，不拥有 turn
宿主层        Gateway、tui_gateway、消息 adapter 所在进程
     │ admission、FIFO、租约、交付
Agent 层      AIAgent / turn_facade / conversation_loop
     │ 同步执行模型与工具
账本层        SessionDB、transcript、admission、lease、locks
~~~

先建立这张坐标系，后面看到 `GatewayAgent`、`AIAgent`、`TurnRunner`、`SessionAuthority` 时就不会混。

## 2. 先记住一个判断

**执行属于宿主，不属于渲染层；会话事实属于持久账本，不属于某个进程内对象。**

所以：

- 经典 CLI 的 `GatewayAgent` 可以长得像 Agent，但它只是提交与事件回放代理；
- `TurnRunner` 在 Gateway 宿主里搭建回调、审批和交付，不替代核心循环；
- `AIAgent.run_conversation()` 是同步 turn 核心，但先要拿到 durable lease；
- 状态行落库以后，进程重启仍能 readback，而不是靠“我记得刚才跑过”。

## 3. 源码主线

1. `hermes_cli/gateway_agent.py`：经典 CLI 侧代理。它提交 `prompt.submit`，消费 gateway 事件，最后拼出与本地 Agent 同形状的 result。
2. `gateway/run.py::GatewayRunner`：Gateway 宿主，管理 adapter、会话运行时、后台维护和 turn 执行入口。
3. `gateway/run_turn_runner.py::TurnRunner`：一次 turn 的宿主协作者，接上流式输出、工具进度、审批、通知与交付。
4. `gateway/session_authority.py::SessionAuthority`：会话权威，拥有 live session、durable FIFO、admission 与执行 generation。
5. `agent/turn_facade.py::TurnFacadeMixin.run_conversation`：Agent 侧 facade，先取租约，再进入 `agent/conversation_loop.py`。
6. `agent/conversation_loop.py::run_conversation`：真正的同步模型/工具循环。
7. `hermes_state.py::SessionDB` 与 `hermes_state_common.py`：SQLite 账本、schema、锁、消息和恢复辅助。
8. `tui_gateway/`：TUI/Desktop 的共享 Python 后端，自己也构建 `AIAgent`，不是另一套聊天产品。
9. `plugins/`、`cron/`、`tools/`、`providers/`：扩展能力、调度、工具面和模型适配。

## 4. 关键对象与合同

| 对象 | 拥有的事实 | 不能替代 |
| --- | --- | --- |
| `GatewayAgent` | 一个 CLI 连接上的提交与事件回放 | 真正的模型循环 |
| `TurnRunner` | 单 turn 的宿主回调与交付编排 | `AIAgent` 的上下文/工具语义 |
| `SessionAuthority` | FIFO 顺序、admission claim、generation | transcript 的逐消息内容 |
| `DurableTurnLease` | 当前进程是否有权继续写这一 session | 用户意图或模型成功 |
| `AIAgent` | 当前 turn 的内存状态与循环局部量 | 跨进程 durable 事实 |
| `SessionDB` | 可恢复的会话、消息、状态行 | “模型一定回答成功”的证明 |

边界规则：

- 客户端可以给 session id、文本和附件，但不能伪造 principal、operator provenance 或 kanban producer marker；
- 入口可以展示状态，但不能自己把 `unknown` 改成 `queued`；
- Agent 可以产生工具调用，但不能绕过 call/result 配对直接写 transcript；
- 数据库可以证明某行存在，但不能自动证明外部副作用只发生一次。

## 5. 一条可观察链路

~~~text
hermes CLI
  → GatewayAgent.run_conversation()
  → prompt.submit
  → GatewayRunner / TurnRunner
  → SessionAuthority.submit()
  → session_admissions: queued
  → drain claim: started
  → AIAgent.run_conversation()
  → turn lease
  → conversation loop
  → finalize + transcript
  → delivery event
  → CLI 回放事件并打印
~~~

注意最后一步仍属于入口：模型和工具已经在宿主完成，CLI 只是把事件变成终端输出。

## 6. 实验

### 实验 A：定位经典 CLI 的执行边界

用 `rg -n "prompt\.submit|class GatewayAgent" hermes_cli/gateway_agent.py`，再找 `AIAgent` 是否在该文件里被构造。

### 实验 B：定位一次 turn 的四层

用 `rg -n "class SessionAuthority|class TurnRunner|class TurnFacadeMixin|def run_conversation" gateway agent`，把命中路径分别归入宿主与 Agent 两层。

### 实验 C：确认版本语义

读取 `pyproject.toml` 的 `version`，再检查归档根目录是否有 `.git`。不要用 `0.0.0` 覆盖课程基线 `v0.22.5`。

### 实验参考答案

1. **实验 A**：`GatewayAgent` 负责连接和提交，不构造真正的 `AIAgent`；实际 turn 在 Gateway/TUI 宿主内执行。
2. **实验 B**：`SessionAuthority`、`TurnRunner` 属宿主；`TurnFacadeMixin`、`AIAgent` 与 `conversation_loop` 属 Agent；`SessionDB` 属账本。
3. **实验 C**：`0.0.0` 是构建占位；发布基线是归档名与 `v0.22.5`。没有 `.git` 就不能编造 commit。

## 7. 失败与恢复

| 误判 | 后果 | 正确做法 |
| --- | --- | --- |
| 把 CLI 当执行者 | 在错误进程查模型/工具日志 | 先找 `prompt.submit` 和宿主日志 |
| 把内存 Agent 当账本 | 重启后重复执行 | 查 `SessionDB` 和 admission 行 |
| 把 adapter 当 Agent | 在多渠道各自造状态 | 入站统一构造成 admission |
| 把数据库存在当业务成功 | 重复发送外部副作用 | 同时检查工具结果与 delivery receipt |

## 8. 通关自测

1. `GatewayAgent` 与 `AIAgent` 的最关键区别是什么？
2. `SessionAuthority` 和 `SessionDB` 分别拥有什么？
3. 为什么 TUI/Desktop 不必和经典 CLI 走完全相同的进程路径？
4. 看到一次 turn 卡住，第一步应先判断什么？

### 参考答案

1. `GatewayAgent` 是入口侧代理，提交请求并回放事件；`AIAgent` 持有 turn 上下文、模型调用、工具轮次和 finalize，是实际执行核心。
2. `SessionAuthority` 管实时会话与 durable FIFO、claim、generation；`SessionDB` 是可恢复的 SQLite 账本，保存 session、messages、admission、lease 等持久事实。
3. 因为原则是“执行属于宿主，不属于渲染层”。TUI/Desktop 的共享 Python 后端可以自己构建 `AIAgent`；经典 CLI 则把提交交给 Gateway。入口不同，核心语义相同。
4. 先判断它在哪个进程、是否已 admission、是否拿到 lease；不要直接怀疑模型或改上下文。

## 9. 源码坐标

- `hermes_cli/gateway_agent.py`
- `gateway/run.py`
- `gateway/run_turn_runner.py`
- `gateway/session_authority.py`
- `agent/turn_facade.py`
- `agent/conversation_loop.py`
- `hermes_state.py`
- `hermes_state_common.py`
- `tui_gateway/`

## 10. 下一步

进入阶段 1：一条输入怎样从入口变成持久 admission，再由 durable lease 保证同一 session 只有一个写者。
