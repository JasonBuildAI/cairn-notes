---
title: "阶段 2：ConversationLoop"
description: "阶段 2：Conversation Loop。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：Hermes Agent 源码课 · 阶段卷
> 前置：阶段 1
> 对应总览：`01-一次Turn的一生.md` 第 7～9 节
> 本阶段目标：把“一次模型调用”扩成“一轮可停止、可重试、可执行工具的同步 turn”。

## 1. 本阶段解决什么

拿到 lease 只说明“可以执行”，还不说明怎样执行。Hermes 的主循环要同时处理：

- 模型什么时候可以再看一次；
- 工具调用后怎样进入下一轮；
- `max_iterations`、token budget、interrupt、压缩失败怎样停止；
- API retry 与 fallback 在哪里退出重试环；
- 循环异常退出后，谁负责把 transcript 和结果闭合。

## 2. 先记住一个判断

**Loop 不是 `while model_has_tool_calls`，而是一台有多个闸门的 phase machine。**

每一轮都经过相同阶段，但任何阶段都可以通过 verdict 表达 `continue / break / return`。理解 verdict，比背 while 条件更重要。

## 3. 源码主线

1. `agent/turn_facade.py` 的 `run_conversation()` 先取消同 session 的后台 review，建立 relay/accounting/interrupt scope。
2. 它调用 `admit_durable_turn_lease()`；拿到 lease 后执行 `lease.start()`，再调用 `agent/conversation_loop.py::run_conversation`。
3. `_run_conversation_turn()` 先 `build_turn_context()`，得到本轮 messages、system prompt、history、task/turn id 等局部量。
4. 入口清空 per-turn 状态：interim 去重、持久化失败标记、压缩采纳失败、credential refresh 计数等，防止缓存 Agent 串轮。
5. 构造 `_LoopState`，然后处理可选的特殊执行路径，例如 `codex_app_server` 和 scripted prelude。
6. 主循环条件是迭代次数与 `iteration_budget.remaining`，并允许一次显式 grace call。
7. 每轮依次经过 `begin_iteration → prepare_iteration → assemble_api_request → run_preflight_gate`。
8. 通过闸门后进入 `_run_api_retry_loop()`：`build_api_request → perform_api_call → handle_api_error`。
9. 响应归一化后，若有 `tool_calls` 进入 `run_tool_round`，否则进入 `finish_text_response`。
10. 循环退出后统一调用 `finalize_turn()`；即使循环因预算、错误或中断结束，也要闭合结果和 transcript。

## 4. 关键对象与合同

| 对象 | 责任 | 不能做 |
| --- | --- | --- |
| `TurnFacadeMixin` | 租约、relay scope、外层 finally | 执行模型工具循环 |
| `_LoopState` | 本轮所有可变局部量 | 被跨 turn 复用 |
| `PreflightGateVerdict` | 是否调用、重测、终止 | 直接发 provider 请求 |
| `ApiCallVerdict` | 流式/非流式调用结果 | 决定上下文压缩策略 |
| `ApiErrorVerdict` | retry/fallback/终止 | 绕过 preflight 直接换 provider |
| `ToolRoundVerdict` | 工具轮次是否继续/结束 | 跳过 call/result 配对 |
| `finalize_turn` | 结果、transcript 尾部、后处理 | 恢复已丢失的 lease |

关键不变量：

- 同一轮上下文在 API 调用之间尽量保持字节稳定；
- 工具结束后可以压缩，但压缩是显式的上下文边界；
- 任何 `return` 都要有结果字段，任何 `break` 都要交给 finalizer；
- 外层 `finally` 必须释放租约，即使循环抛异常。

## 5. 一条可观察链路

~~~text
TurnFacade.run_conversation
  → cancel background review
  → admit lease
  → lease.start
  → conversation_loop.run_conversation
  → _run_conversation_turn
  → build_turn_context
  → while budget:
       begin_iteration
       prepare_iteration
       assemble_api_request
       run_preflight_gate
       retry loop:
         build_api_request
         perform_api_call
         handle_api_error
       normalize response
       tool round OR finish text
  → finalize_turn
  → lease.stop/join/clear/release
~~~

观察一条日志即可看到：同一 `turn_id` 下会有多个 `api_call_count`，每次 API 后可能跟一个 tool round；只有循环退出才进入 finalize。

## 6. 实验

### 实验 A：单轮文本回复

让模型只返回文本，记录 `api_call_count`、tool round 是否发生、finalize 是否执行。

### 实验 B：一轮工具后再回答

让模型先调用只读工具，再根据结果回答。观察第二轮 API 的 messages 是否新增 assistant tool call 与 tool result。

### 实验 C：耗尽迭代预算

把 `max_iterations` 设为很小，观察是否仍允许 grace call，最终结果是正常结束、预算结束还是异常。

### 实验参考答案

1. **实验 A**：应只有一次成功 API 调用，没有 tool round，随后仍进入 finalize 闭合 transcript。
2. **实验 B**：第一轮 assistant 的 tool call 和对应 tool result 必须先持久化；第二轮模型看到配对后的历史，再生成最终文本。
3. **实验 C**：循环条件由迭代次数和 `iteration_budget` 共同决定，`_budget_grace_call` 可提供收尾机会；耗尽后由 finalizer 产出解释性结果，而不是让循环无限继续。

## 7. 失败与恢复

| 失败 | 发生位置 | 恢复点 |
| --- | --- | --- |
| preflight 压缩超时 | API 调用前 | 返回压缩超时结果，保留 transcript |
| provider 可重试错误 | retry loop | 递增 retry；必要时重新请求 |
| fallback 已激活 | error handler | 离开 retry loop，重新进入 preflight |
| 工具参数非法 | tool round | 生成配对错误结果，继续或结束 |
| 工具执行中断 | executor | 补齐未完成/跳过的 tool result |
| 持久化失败 | 工具执行前 | `session_persistence_failed` 终止，禁止副作用继续 |
| 预算耗尽 | 主循环条件 | grace/finish，finalize 补解释 |
| lease 丢失 | 后台 refresher | hard interrupt，旧 loop 停止 |

## 8. 通关自测

1. `TurnFacade` 和 `conversation_loop` 的职责怎样分？
2. 为什么每轮都要重新经过 preflight，而不是只在 turn 开始时做一次？
3. `action=break` 与 `action=return` 的差别是什么？
4. 工具调用为什么会让 `api_call_count` 增加？
5. 循环退出后为什么还要 finalize？
6. 哪些状态必须在每轮 turn 开始时清空？

### 参考答案

1. `TurnFacade` 管租约、外层作用域、后台 review 互斥和 finally 清理；`conversation_loop` 管本轮上下文、API 重试、工具轮次与 finalize，是同步执行核心。
2. 因为工具结果、压缩和 fallback 都会改变请求大小或 provider 上下文窗口；每次真正发请求前都要重新判断能否 fit。
3. `return` 直接携带一个完整 result 结束；`break` 只退出当前循环/重试环，后面仍要交 finalizer 或进入下一阶段统一收尾。
4. 模型返回 tool calls 后，Hermes 执行工具并把这些消息写回历史，再发起下一次模型请求；每次模型请求都计一次 API call。
5. 因为模型停止不等于 turn 完成。需要恢复流式文本、闭合 transcript 尾部、处理预算解释、持久化后处理和产出最终 result。
6. 包括 interim 去重集合、incremental persistence failure、压缩采纳失败、one-shot reasoning 状态、credential refresh 计数和本轮 usage 等。

## 9. 源码坐标

- `agent/turn_facade.py::TurnFacadeMixin.run_conversation`
- `agent/conversation_loop.py::_run_conversation_turn`
- `agent/conversation_loop.py::_run_api_retry_loop`
- `agent/conversation_loop.py::run_conversation`
- `agent/turn_context.py::build_turn_context`
- `agent/turn_preflight.py::PreflightGateVerdict`
- `agent/turn_tool_round.py::run_tool_round`
- `agent/turn_finalizer.py::finalize_turn`
- `tests/agent/test_context_token_tracking.py`

## 10. 下一步

进入阶段 3：进入循环后，`messages` 并不等于发给 provider 的字节；system prompt、api sidecar 和压缩共同决定模型究竟看到什么。
