---
title: "阶段 8：工程化测试与排障"
description: "阶段 8：工程化测试与排障。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：Hermes Agent 源码课 · 阶段卷
> 前置：阶段 0～7
> 对应总览：`engineering.md`
> 本阶段目标：用最小复现和证据链定位问题，避免把“本地能跑”当成“契约没坏”。

## 1. 本阶段解决什么

Hermes 的故障往往不在一个函数里，而在两个边界之间：

- admission 已提交，但 worker 没 claim；
- 工具已执行，但 result 没 canonical；
- fallback 已激活，但没重建请求；
- 压缩成功，但 session 读错；
- UI 已显示，但 transcript 没闭合；
- 两个 profile 共用一个进程，后台 ticker 落错 home。

工程化的目标不是“多写测试”，而是让每类事实都有可观察证据和独立验证点。

## 2. 先记住一个判断

**先判断“是否已经发生/提交”，再判断“为什么没有表现为预期”。**

同一句“工具没反应”可能是：

- 根本没开始：admission 还 queued；
- 已开始但没执行：lease 或审批卡住；
- 已执行但模型没看到：result 未 canonical；
- 已写入但 UI 没显示：event/delivery 问题；
- 已投递但被平台去重：receipt/幂等问题。

五种问题的修复完全不同。

## 3. 源码主线

1. 先找进程：经典 CLI、Gateway、TUI Python 后端、Desktop、cron worker 的日志与状态不在一起。
2. 再找 turn：`prompt.submit`、`SessionAuthority.submit()`、admission id、generation、`TurnRunner`。
3. 再找执行权：lease holder、`expires_at`、refresh 日志、liveness watchdog。
4. 再找上下文：system prompt 来源、`build_api_messages()`、preflight 次数、compression lock。
5. 再找调用：request id、provider、model、retry、credential rotation、fallback。
6. 再找工具：call flush、executor、result commit、guardrail、timeout。
7. 最后找收尾：finalizer、assistant row、transcript tail、delivery receipt、event replay。
8. 测试目录按层组织：`tests/gateway`、`tests/agent`、`tests/tools`、`tests/hermes_cli`、`tests/cron`、`tests/tui_gateway`、`tests/acp_adapter` 等。
9. 最小复现应使用临时 `HERMES_HOME`、假 provider、假 adapter、临时 SessionDB；不要对着真实 state.db 做破坏性实验。
10. 修改持久化/协议时，先从现有测试找 contract，再补“成功、边界、失败、恢复、重放”五类用例。

## 4. 关键证据与合同

| 症状 | 第一证据 | 不能直接假定 |
| --- | --- | --- |
| turn 卡住 | admission status + lease holder | 模型慢 |
| 工具没结果 | call row + executor log + result row | 工具没执行 |
| 回答重复 | request id + delivery receipt + event seq | 模型重复生成 |
| 上下文不降 | pressure + threshold + lock/cooldown | 压缩器坏了 |
| fallback 失败 | retry trace + fallback route + preflight | 新 provider 不可用 |
| 多 profile 串线 | thread/task 的 profile scope | session id 错了 |
| DB 锁 | writer、busy timeout、lock holder | 直接删 WAL |
| schema 不兼容 | 二进制版本 + DB 版本 | 手改表结构 |

测试分层建议：

- **纯合同测试**：verdict、payload 规范化、状态转换、错误分类；
- **组件测试**：SessionAuthority、lease、compressor、tool round；
- **集成测试**：Gateway/TUI 提交到 finalize；
- **恢复测试**：进程中断、`unknown`、stale lease、orphan tool pair；
- **兼容测试**：provider adapter、schema migration、RPC wire contract；
- **端到端冒烟**：只验证主链可达，不替代前五类。

## 5. 一条可观察链路

~~~text
复现命令
  → 记录进程 / profile / HERMES_HOME / session id
  → 查 admission
  → 查 lease 与 generation
  → 查 request id / provider / preflight
  → 查 tool call / result
  → 查 finalizer / transcript tail
  → 查 delivery receipt / event seq
  → 形成“已发生/未发生”的结论
  → 写最小失败测试
  → 修复后再跑相邻层测试
~~~

## 6. 实验

### 实验 A：临时环境跑一条 turn

~~~powershell
$env:HERMES_HOME = Join-Path $env:TEMP ("hermes-test-" + [guid]::NewGuid())
python -m pytest tests/gateway/test_managed_turn_contract.py -q
~~~

记录测试前后临时目录中的 DB 和日志，确认没有写入真实 home。

### 实验 B：为工具超时写最小测试

用假工具阻塞到 timeout，断言存在对应 tool result，且后续模型能看到终止事实。

### 实验 C：为 fallback 写契约测试

让假 provider 返回可 fallback 错误，断言 fallback 后 preflight 重新执行，而不是复用旧 request。

### 实验参考答案

1. **实验 A**：所有状态应落在临时 `HERMES_HOME`；测试结束后可安全删除。真实 profile 不应出现新 session。
2. **实验 B**：断言 tool call 已持久化、超时结果已 canonical、turn 不悬挂；不要只在假工具里断言“被调用过”。
3. **实验 C**：断言新 provider 的 request 由重新 assemble/preflight 生成，旧 messages/headers 没有被无脑复用。

## 7. 失败与恢复

| 症状 | 常见根因 | 正确处理 |
| --- | --- | --- |
| turn 永远 queued | 没有 drain/ticker，前一个 claim 未结算 | 查 owner、lease、event，不要强改终态 |
| turn 一直无输出 | provider stream、工具审批、clarify、锁 | 查 request id、tool status、watchdog |
| 工具结果缺失 | result persist 失败或中断未补 skipped | 保持配对，先查副作用 |
| 页面有答案、DB 没有 | finalize/transcript tail 未闭合 | 查 finalizer 与 delivery 顺序 |
| 压缩反复失败 | lock、cooldown、summary provider、窗口不足 | 等/释放/修 provider，不能无限重试 |
| fallback 后 400/overflow | 未重建 wire copy | 重新 preflight |
| 重启后重复工具 | `unknown` 被当 queued | readback/reconcile + 幂等 |
| 多 profile 串线 | 后台线程/RPC 未绑定 scope | 显式绑定 home/profile |
| state.db locked | 长事务、错误锁、另一 writer | 查 holder、备份、官方 repair |
| prompt cache 命中下降 | 非压缩路径重建 prompt | 比较 stable 字节与重建调用栈 |

## 8. 通关自测

1. 排障时为什么要先分清进程？
2. 如何区分“工具没执行”和“执行了但结果没到模型”？
3. 为什么临时 `HERMES_HOME` 是测试底线？
4. 一条恢复测试至少要覆盖哪些事实？
5. 为什么 schema migration 不能直接在 live DB 上手改？
6. 修复一个 fallback bug 后，为什么还要跑 preflight 与 provider adapter 测试？

### 参考答案

1. 因为入口、宿主、Agent、cron、UI 可能是不同进程；在错误进程里找日志会得到“没有执行”的假结论。
2. 查 canonical call、executor 日志、result 行和 `_incremental_persistence_failed`。若只有调用日志没有 result，可能是执行中失败/持久化失败；若有 result 没到模型，查提交与循环回填。
3. 它隔离真实 session、lease、admission、skills 和凭据，避免测试污染用户账本或触发真实外部副作用；也让失败可重复。
4. 至少覆盖：已提交的 call、未知/缺失的 result、admission 状态、lease 归属、canonical session、最终 transcript 与外部副作用核对。
5. live DB 上可能有并发 reader/writer，手改会破坏事务、索引、generation 和 FTS；必须先停写、备份，在副本上走官方迁移并验证旧数据可读。
6. 因为 fallback 改变 provider，容易连带影响请求字段、上下文窗口、工具 schema 和 preflight；只测“最终成功”会漏掉协议不兼容与重复压缩。

## 9. 源码坐标

- `gateway/session_authority.py::SessionAuthority`
- `gateway/run_turn_runner.py::TurnRunner`
- `agent/turn_facade_lease.py::DurableTurnLease`
- `agent/turn_tool_round.py::run_tool_round`
- `agent/turn_api_error.py::handle_api_error`
- `agent/context_compressor.py::ContextCompressor`
- `hermes_state.py::SessionDB`
- `tests/gateway/`
- `tests/tools/`
- `tests/agent/`
- `tests/cron/`
- `tests/tui_gateway/`

## 10. 下一步

进入阶段 9：把前八阶段的边界合成一个可落地、可恢复、可测试的毕业改造。
