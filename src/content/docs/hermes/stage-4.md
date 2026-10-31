---
title: "阶段 4：工具与 PersistBeforeExecute"
description: "阶段 4：工具与 Persist Before Execute。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：Hermes Agent 源码课 · 阶段卷
> 前置：阶段 2、3
> 对应总览：`turn-lifecycle.md` 第 9 节，`core-mechanisms.md` 第 3 节
> 本阶段目标：从模型的 tool call 追到可见工具表、持久化边界、执行器、结果回填与失败终止。

## 1. 本阶段解决什么

工具调用是最容易把“对话错误”升级为“真实世界副作用”的地方。Hermes 的核心约束是：

~~~text
模型提出 tool call
  → 可见性/参数/批次校验
  → assistant call 先进入 canonical transcript
  → 工具执行
  → tool result 再持久化
  → 下一轮模型
~~~

这不是“先跑再记日志”，而是 **persist-before-execute**：如果破坏性工具执行到一半进程重启，恢复时必须已经能看到“我曾要求执行这个调用”。

## 2. 先记住一个判断

**工具调用的事实顺序是“调用先落账，副作用后发生”；持久化失败时，副作用不能继续。**

所以不能用下面的替代方案：

- 先在内存里执行，成功后再批量写 DB；
- 工具失败就不写 call；
- 工具成功但 result 写失败，还继续让模型看到内存结果；
- 为了凑配对凭空删掉一个已发出的 tool call。

## 3. 源码主线

1. `toolsets.py` 定义 toolset、include 关系、平台限制与工具集合。
2. `model_tools.py::get_tool_definitions()` 根据 enabled/disabled toolsets、动态 schema、alias 和平台，生成模型可见的工具定义。
3. 工具可见不等于已授权；执行前还有参数校验、审批、写前检查、预算与 guardrail。
4. `agent/turn_tool_round.py::run_tool_round()` 先 `validate_tool_calls()`，处理截断、混合无效批次与重复调用。
5. 只对这一轮尚未持久化的 tool calls 做 id 规范化、batch 展开、去重和 delegate 数量上限。
6. `stage_tool_call_message()` 构造 assistant tool-call 行，随后立即 `_flush_messages_to_session_db()`。
7. 若 flush 失败，turn 以 `session_persistence_failed` 结束，工具不会执行。
8. 执行器按 batch 语义选择 concurrent、sequential 或 segmented，保持原始顺序、审批、超时和结果配对。
9. 每个 tool result 经提交路径写回；若结果不能成为 canonical，`_incremental_persistence_failed` 会终止本轮，而不是把内存结果发给模型。
10. 工具后处理可能触发压缩，再进入下一轮 API。

## 4. 关键对象与合同

| 对象 | 责任 | 不变量 |
| --- | --- | --- |
| toolset | 声明可暴露的工具面 | 不能绕过 platform/authorization |
| `model_tools.get_tool_definitions` | 生成 schema 与缓存键 | 可见集合必须可解释 |
| `validate_tool_calls` | 结构、名称、截断、批次校验 | 无效 call 也要有结果或明确终止 |
| `stage_tool_call_message` | 生成 call 消息 | 先于任何副作用 |
| `_flush_messages_to_session_db` | 把 call 变成 canonical | 失败即停 |
| `execute_tool_calls_*` | 调度真实执行 | 顺序、审批、超时、配对 |
| tool result commit | 写回结果 | 模型不能先看到未持久结果 |
| `session_persistence_failed` | 明确的失败原因 | 不能伪装成普通模型失败 |

混合批次规则：assistant 消息保留所有已发出的 tool calls，因为每个 call 都需要 result；无效名称的 call 会得到一个错误 result，但不会进入真实执行。这样既守住配对，又不给无效工具执行权限。

## 5. 一条可观察链路

~~~text
assistant_message.tool_calls
  → validate_tool_calls
  → expand batches / dedupe / cap delegate
  → normalize ids
  → stage assistant call
  → flush call to SessionDB
       fail → session_persistence_failed
       ok   → execute
  → approval / policy / timeout / budget
  → commit each tool result
       fail → session_persistence_failed
       ok   → append to messages
  → compress after tool results (optional)
  → next API iteration
~~~

观察点：日志里“Processing N tool call(s)”之前已经有参数校验；真正执行前应有一次持久化成功。工具结果打印不等于已经 canonical，必须看 commit/flush 结果。

## 6. 实验

### 实验 A：无效工具名混合批次

让模型同一批返回一个有效只读工具和一个不存在工具。

### 实验 B：持久化在 execute 前失败

在测试中让 `_flush_messages_to_session_db()` 抛错，并给工具设置真实副作用探针。

### 实验 C：工具故意超时

执行一个会超过 batch timeout 的工具，观察 result 是否仍以超时/未完成形式配对。

### 实验参考答案

1. **实验 A**：有效工具正常执行；无效工具得到错误 tool result，但不进入真实执行。assistant 行仍保留两个 call，保证配对。
2. **实验 B**：副作用探针不应触发；turn 以 `session_persistence_failed` 结束。因为 call 没成为 canonical，系统不能假装它未发生后再执行。
3. **实验 C**：执行器应提交一个表示终止/未完成的 result，而不是留下孤立 call；后续模型可以据此解释，但已发生的部分副作用仍需 readback。

## 7. 失败与恢复

| 失败 | 已发生事实 | 正确恢复 |
| --- | --- | --- |
| 参数 JSON 非法 | 未执行 | 生成错误 result，保持配对 |
| 工具不可见 | 未执行 | 拒绝并说明可用工具 |
| call 持久化失败 | 未执行 | 终止 turn，不产生副作用 |
| 审批拒绝 | 未执行 | 产生拒绝 result |
| 执行超时 | 可能部分副作用 | 结果标记超时；外部系统 readback |
| result 持久化失败 | 副作用可能已发生 | 终止；先查真实状态，不能盲重试 |
| 进程在工具中崩溃 | call 已持久化，result 未知 | 恢复时以 call + 外部系统证据判断 |
| lease 丢失 | 执行权不确定 | hard interrupt；新 owner 先对账 |

## 8. 通关自测

1. 为什么必须先持久化 tool call，再执行工具？
2. 无效工具名为什还要生成 tool result？
3. 工具 result 持久化失败后，为什么不能把内存结果继续发给模型？
4. concurrent、sequential、segmented 三种执行方式共同必须守住什么？
5. 工具超时后，为什么不能默认“没执行”？
6. 审批拒绝属于失败还是可解释结果？

### 参考答案

1. 因为工具可能有破坏性副作用。先写 call 后，进程重启时恢复系统能知道“这次执行曾被发起”，再结合 result/外部状态判断是否完成；先执行会导致崩溃后完全失忆。
2. 因为 provider 要求每个 assistant tool call 有对应结果。缺结果会破坏消息交替结构，也可能让后续请求非法；错误 result 不是执行授权。
3. 因为 canonical transcript 与内存投影已经不一致。把未持久结果发给模型会继续基于不可恢复事实推理，而后续重放又看不到它，造成状态分叉。
4. 共同守住原始调用意图、call/result 配对、审批与策略、超时语义、结果提交顺序和失败终止；并发只是调度方式，不改变持久化合同。
5. 超时只说明调用没有在期限内返回，副作用可能发生在超时前、执行中或返回后。必须先查目标系统或幂等键，再决定补做还是报错。
6. 审批拒绝是一个明确、可解释的结果，工具未执行；它不是系统崩溃。应生成拒绝 result，让模型知道边界。

## 9. 源码坐标

- `toolsets.py`
- `model_tools.py::get_tool_definitions`
- `agent/turn_tool_round.py::run_tool_round`
- `agent/turn_tool_round.py::stage_tool_call_message`
- `agent/tool_executor.py::execute_tool_calls_concurrent`
- `agent/tool_executor.py::execute_tool_calls_sequential`
- `agent/tool_executor.py::execute_tool_calls_segmented`
- `agent/tool_executor.py::_commit_tool_result`
- `tests/tools/test_timeout_transport_drain.py`
- `tests/gateway/test_chat_completions_approval.py`

## 10. 下一步

进入阶段 5：工具和请求都准备好了，provider 调用失败时，凭据轮换、retry 与 fallback 怎样在不破坏上下文的前提下恢复。
