---
title: "阶段 1：前端 Admission 与 Lease"
description: "阶段 1：前端 Admission 与 Lease。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：Hermes Agent 源码课 · 阶段卷
> 前置：阶段 0
> 对应总览：`turn-lifecycle.md` 第 1～4 节
> 本阶段目标：追清“输入先落成持久工作项，再由唯一租约持有者执行”的双重边界。

## 1. 本阶段解决什么

用户按回车不等于 turn 已经开始。Hermes 先把输入变成 durable admission，再由 SessionAuthority 的 FIFO 领取，最后由 durable turn lease 保证同一 session 只有一个写者。

~~~text
输入
  → 鉴权
  → payload 规范化
  → session_admissions: queued
  → drain / claim: started
  → TurnRunner 搭舞台
  → AIAgent 取 turn lease
  → 执行
  → 终态 + 交付
~~~

这套设计解决四个现实问题：跨进程并发、长任务重启、重复提交、以及“旧进程还活着但已经不该继续写”的脑裂。

## 2. 先记住一个判断

**Admission 决定“这条输入有没有被系统接收”，lease 决定“这个执行者现在有没有资格继续写”。**

两者不能合并：

- admission 是持久队列事实，跨进程可见；
- lease 是短时单写者授权，会过期、会刷新、会被后继者重新获取。

## 3. 源码主线

1. 经典 CLI 的 `hermes_cli/gateway_agent.py` 提交 `prompt.submit`，消费事件；它不执行 turn。
2. Gateway 的 `SessionAuthority.submit()` 先做 `session:submit` 鉴权，再在 session mutation lock 下进入 `_submit()`。
3. `_submit()` 校验 intent/payload，规范化 attachments、surface、display、finite、CLI turn 等字段，并调用 `admit_session_input()` 提交持久行。
4. 同一 session 的提交进入 durable FIFO；drain 按 `seq` 只领取队首，避免两个 turn 交叉写 transcript。
5. `TurnRunner` 绑定交付 adapter、流式回调、审批与工具进度；真正的 `AIAgent` 仍由 session 运行时提供。
6. `TurnFacadeMixin.run_conversation()` 第一件关键事是 `admit_durable_turn_lease()`；失败则返回 early result。
7. `DurableTurnLease` 在后台每约 `60s` 刷新，TTL 为 `300s`；等待上限 `1800s`。
8. 执行结束的 `finally` 依次停止刷新、join、清理由本 lease 产生的 interrupt、释放租约。

## 4. 关键对象与合同

| 对象/字段 | 含义 | 不变量 |
| --- | --- | --- |
| `Submission` | 一次逻辑提交 | 身份、session、request id 必须稳定 |
| `session_admissions` | 持久工作项 | 客户端不能伪造 principal 或 producer marker |
| `queued` | 已提交，尚未执行 | 可跨重启保留 |
| `started` | 已由某 owner claim | 只有一个有效 claim |
| `unknown` | claim/提交边界无法证实 | 必须 readback/reconcile，禁止猜改 |
| 终态 | 完成、失败或取消 | 要与 transcript 边界一起提交 |
| `DurableTurnLease` | 当前执行权 | holder-qualified 续约与释放 |
| `generation` | 会话执行代次 | 单调推进，不能被旧 claim 复用 |

`holder` 不是简单的 session id，而是包含进程、turn、platform 等信息的持久身份。这样旧 refresher 即使晚到，也不能续上后继者的租约。

## 5. 一条可观察链路

~~~text
prompt.submit
  → SessionAuthority.submit(actor, submission)
  → authorize(session:submit)
  → mutation_lock
  → _submit: payload normalization
  → admit_session_input: queued
  → drain claim: started + owner epoch
  → TurnRunner
  → AIAgent.run_conversation
  → admit_durable_turn_lease: holder + expires_at
  → loop/finalize
  → terminal transition
  → delivery
~~~

观察重点：

- 在 `queued` 时还没有模型调用；
- 在 `started` 时已有执行 owner，但工具副作用未必发生；
- `unknown` 不是自动失败，而是“必须查账”的暂停状态；
- lease 正常释放只释放自己的 holder，不能清掉后继者。

## 6. 实验

### 实验 A：提交后立即观察

在测试库里提交一条输入，但在模型调用前暂停 drain。检查 admission 行。

### 实验 B：模拟执行边界不确定

在 claim 与 stale recovery 之间制造异常，使状态进入 `unknown`，再走官方 resolve/readback 路径。

### 实验 C：验证 holder 围栏

用旧 holder 直接调用 release 或刷新，再让新 holder 获取同一 session 的租约。

### 实验参考答案

1. **实验 A**：应看到 `queued`，且没有新的 assistant transcript；这证明“已接收”不等于“已执行”。
2. **实验 B**：应先根据已有 claim、generation、captured result 和 transcript 判断是否完成；不能把 `unknown` 直接改回 `queued`，否则可能重复执行。
3. **实验 C**：旧 holder 的更新应因 holder 不匹配而失败；新 holder 获得新租约。释放只影响仍在 lease 中记录的 session/owner。

## 7. 失败与恢复

| 失败 | 已发生事实 | 恢复原则 |
| --- | --- | --- |
| admission 写入失败 | 不该执行 | 返回错误，保留 captured media 的释放规则 |
| 等待 lease 超时 | 输入已被接收但未执行 | 返回 early result；不要把输入当已消费 |
| 等待中被新输入打断 | 原输入可能只在内存 | 用 `carry_unadmitted_user_message` 交给下一轮持久化 |
| lease 刷新丢失 | 执行权可能已转移 | hard interrupt；旧 owner 停止继续推进 |
| SQLite 锁持续到期限 | 下一次刷新赶不上过期 | 主动停止，保护 transcript |
| admission `unknown` | 完成情况不确定 | readback/reconcile，终态与 transcript 边界一起提交 |
| 进程重启 | 内存回调丢失 | 从 durable FIFO 与 lease 行恢复 |

特别提醒：lease 丢失时，已经开始的工具副作用不会自动回滚。必须先查工具结果和外部系统，再决定是否重试。

## 8. 通关自测

1. 为什么不能只用内存队列管理同一 session 的输入？
2. `queued`、`started`、`unknown` 分别意味着什么？
3. 为什么 admission 和 turn lease 不能合并成一个锁？
4. lease 的 TTL、等待上限和刷新间隔大约是多少？
5. lease 丢失后，为什么不能悄悄让旧进程继续收尾？
6. 遇到 `unknown` 时，正确的第一动作是什么？

### 参考答案

1. 因为 CLI、TUI、Gateway、后台任务可能在不同进程同时操作同一 session。内存队列跨不过重启，也无法形成跨进程的稳定顺序和幂等 judge。
2. `queued` 是已持久化但尚未 claim；`started` 是某 owner 已接手；`unknown` 是提交/执行边界无法证实，需要 readback 和 reconciliation。终态则是完成、失败或取消。
3. admission 管持久工作项和 FIFO 顺序，生命周期长；lease 管短时单写者授权，有 TTL、刷新和 holder 围栏。把两者合并会让排队事实和执行权互相污染。
4. TTL `300s`，等待上限 `1800s`，刷新间隔默认约 `60s`，并由源码常量/配置约束。
5. 因为执行权可能已被新 owner 获取；旧进程继续写会造成双写、重复工具副作用或 transcript 分叉。lease 丢失要用 hard interrupt 结束旧执行，再由新 owner 按其 claim 接管。
6. 先 readback admission、claim、generation、captured result 与 transcript，判断是否已完成；再走 `resolve_unknown` 类路径提交一个确定的终态，不能直接重置为 queued。

## 9. 源码坐标

- `hermes_cli/gateway_agent.py`
- `gateway/session_authority.py::SessionAuthority.submit`
- `gateway/session_authority.py::SessionAuthority.resolve_unknown_as_owner`
- `gateway/run_turn_runner.py::TurnRunner`
- `agent/turn_facade.py::TurnFacadeMixin.run_conversation`
- `agent/turn_facade_lease.py::admit_durable_turn_lease`
- `agent/turn_facade_lease.py::DurableTurnLease.refresh_tick`
- `hermes_state.py::SessionDB`
- `tests/gateway/test_managed_turn_contract.py`

## 10. 下一步

进入阶段 2：拿到租约之后，`AIAgent` 的同步循环怎样一轮轮推进，并在什么条件下退出到 finalize。
