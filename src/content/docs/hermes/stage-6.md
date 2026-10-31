---
title: "阶段 6：SessionDB 与恢复"
description: "阶段 6：SessionDB 与恢复。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：Hermes Agent 源码课 · 阶段卷
> 前置：阶段 1、4
> 对应总览：`turn-lifecycle.md` 第 10 节，`core-mechanisms.md` 第 5 节
> 本阶段目标：理解 transcript、admission、lease、compression lock 与 migration 怎样组成可恢复账本。

## 1. 本阶段解决什么

Hermes 的恢复不是“把进程内 messages pickle 起来”，而是把不同生命周期的事实分开存：

- session 的长期身份和当前生成代次；
- 每条消息及其 call/result 结构；
- 每次 admission 的排队与终态；
- 谁暂时持有 turn lease；
- 谁持有 compression lock；
- FTS 搜索索引与 schema 版本。

这些事实有的必须原子提交，有的可以最终一致。恢复时最重要的是 **不把不确定当成确定**。

## 2. 先记住一个判断

**数据库里的行证明“系统记录过什么”，不自动证明“外部副作用完成到什么程度”。**

例如：

- `started` admission 说明某 owner 接手，不说明工具成功；
- tool call 已持久化，不说明对应命令已经结束；
- assistant 最终文本已落库，不说明消息平台已成功投递；
- lease 过期说明可以重新获取执行权，不说明旧进程一定死亡。

恢复必须结合 admission、transcript、工具结果、外部幂等键和 delivery receipt。

## 3. 源码主线

1. `hermes_state.py::SessionDB` 是 SQLite 账本，默认位于 profile 的 state 路径；支持 WAL 读写、锁等待、损坏隔离与连接生命周期管理。
2. `hermes_state_common.py` 定义 `SCHEMA_VERSION = 32`、`FTS_STORAGE_VERSION = 3` 以及迁移/索引/锁辅助。
3. `AsyncSessionDB` 把同步 DB 操作暴露给异步宿主，避免在 event loop 中直接阻塞。
4. 消息写入采用 canonical append/flush 语义；`repair_alternation=True` 恢复时会修正 user/assistant/tool 的交替结构。
5. `_strip_stale_tool_call_markers()` 处理旧会话中不完整的 tool-call 标记，避免 resume 后 provider 拒绝。
6. admission 相关行记录 request id、principal、session、payload 摘要、status、owner epoch 和 outcome，是 FIFO 与幂等的基础。
7. session turn lease 行记录 holder 与 `expires_at`；获取时可回收已过期行，续约必须匹配 holder。
8. compression lock 防止同一 session 同时做两次摘要/旋转；失败冷却与 lock 是不同概念。
9. 压缩旋转会创建 child session，并保留 parent/child 来源；resume 时先 resolve 当前 canonical session。
10. admission 终态与 transcript 边界应尽量一起提交，避免出现“状态已完成但答案还没闭合”或“答案已写但队列仍可重跑”。

## 4. 关键对象与合同

| 事实 | 持久载体 | 能证明 | 不能证明 |
| --- | --- | --- | --- |
| 会话身份 | session row | session 存在、来源、generation | 当前 turn 成功 |
| 消息 | messages/transcript | 模型曾看到/产生什么 | 外部副作用完成 |
| admission | session admissions | 已接收、排队、claim、终态 | 工具成功 |
| turn lease | lease row | 当前执行权归属与期限 | 模型回答正确 |
| compression lock | lock row | 谁在压缩 | 压缩一定成功 |
| FTS index | FTS tables | 可搜索文本 | 业务事务已提交 |
| delivery receipt | 宿主/平台状态 | 已投递到某渠道 | 用户已读 |

版本与兼容：

- schema `32` 与 FTS storage `3` 是当前归档的持久格式，不是可以随手改的注释；
- migration 必须在隔离副本上验证，不能对着 live writer 手删表；
- WAL 允许并发读和单 writer，不等于多个 writer 可随意同时写；
- 数据库文件被替换、WAL generation 丢失或结构损坏时，要继续使用必须走官方 quarantine/repair 路径。

## 5. 一条可观察链路

~~~text
turn start
  → session row / admission row
  → lease acquire
  → user message staged + flushed
  → assistant tool call committed
  → tool result committed
  → assistant final committed
  → finalize / terminal transition
  → delivery receipt

process crash / restart
  → open SessionDB
  → verify schema / integrity / generation
  → list queued + started + unknown admissions
  → resolve canonical session
  → inspect transcript tail and tool pairs
  → reclaim expired lease / resolve unknown
  → resume or settle
~~~

观察点：重启后的第一件事不是“重跑最后一轮”，而是先判断 admission 与 transcript 已经走到哪一步。

## 6. 实验

### 实验 A：schema 与索引

在临时 `HERMES_HOME` 创建 DB，读取 `PRAGMA user_version`、表清单和 FTS 状态，对照 `SCHEMA_VERSION=32` 与 `FTS_STORAGE_VERSION=3`。

### 实验 B：工具中途崩溃

在测试工具已持久化 call、尚未提交 result 时终止进程。重启后检查 transcript 和恢复策略。

### 实验 C：压缩旋转

触发压缩并旋转 child session，比较 parent/child id、resume 结果和 messages。

### 实验参考答案

1. **实验 A**：应看到当前 schema/version 与源码常量一致，FTS 表存在且可查询；这只是格式验证，不代表业务数据完整。
2. **实验 B**：重启后能看到已持久化 tool call，却可能没有 result。不能凭空重跑破坏性工具；要结合 result、外部幂等键和恢复策略补齐或终止。
3. **实验 C**：resume 应解析到 canonical child；父 session 仍保留来源与历史边界，child 上的 messages 从压缩后的上下文继续。

## 7. 失败与恢复

| 失败 | 风险 | 恢复原则 |
| --- | --- | --- |
| DB locked | 写入超时，lease 可能无法续 | 区分短暂锁与到期前无法刷新 |
| DB 文件被替换 | 旧连接写错新文件 | 检测 generation，停止旧 writer |
| WAL 丢失 | 已提交视图不确定 | 官方恢复/隔离，不手拼数据库 |
| 结构损坏 | 静默错误或崩溃 | quarantine + 从备份恢复 |
| orphan tool call | provider 拒绝或历史不完整 | 按 call id 修配对，不凭空删 call |
| stale lease | 后继者无法及时执行 | 确认 owner 死亡/过期后官方回收 |
| admission unknown | 可能重复执行 | readback/reconcile 后提交明确终态 |
| compression lock 卡住 | 上下文无法继续压缩 | 确认 holder 已死，再释放 |
| transcript 过大 | resume 失败 | 使用明确上限与导出/裁剪策略 |

## 8. 通关自测

1. `SCHEMA_VERSION` 与 `FTS_STORAGE_VERSION` 分别是什么？
2. WAL 下为什么仍然只能有一个 writer？
3. admission 行和 transcript 行分别证明什么？
4. 为什么压缩要 child session，而不是只覆盖原 messages？
5. 工具 call 已落库、result 未落库时，重启后应怎样判断？
6. stale lease 和 `unknown` admission 的处理有什么区别？
7. 为什么不能手工删除 compression lock 文件或表行？

### 参考答案

1. 当前基线分别是 schema `32`、FTS storage `3`。它们描述持久格式，迁移必须走受控路径。
2. WAL 提升读写并发，但 SQLite 的写事务仍是单 writer；多 writer 会争锁、超时，甚至让 lease/终态提交失去可预测性。
3. admission 证明系统接收、排队、claim 和终态；transcript 证明消息内容与 call/result 结构。两者不能互相替代。
4. 覆盖原 messages 会让摘要伪装成原始历史，且破坏审计与恢复边界。child session 保留新上下文，同时用 parent/child 关系保留旧账本。
5. 先用 call id 查结果和外部系统，判断执行是否完成；再把结果补齐或将 turn 结算为失败/未知。不能因为 result 缺失就重跑破坏性工具。
6. stale lease 是执行权过期问题，确认 owner 不再持有后可回收；`unknown` 是 admission 执行边界不确定，必须 readback 和 reconcile 后提交终态。
7. lock 可能是仍存活的 writer 持有。强删会造成并发压缩、双写或 child session 分叉；必须先确认 holder 已死并走官方释放/修复流程。

## 9. 源码坐标

- `hermes_state.py::SessionDB`
- `hermes_state.py::AsyncSessionDB`
- `hermes_state.py::_strip_stale_tool_call_markers`
- `hermes_state_common.py::SCHEMA_VERSION`
- `hermes_state_common.py::FTS_STORAGE_VERSION`
- `agent/session_persistence.py`
- `gateway/session_settlement_recovery.py`
- `agent/conversation_compression.py`
- `tests/gateway/test_managed_turn_contract.py`
- `tests/gateway/test_compression_failure_session_sync.py`

## 10. 下一步

进入阶段 7：账本和核心循环都稳定后，plugin、cron、delegate、消息渠道和 UI 如何在不复制核心语义的前提下扩展系统。
