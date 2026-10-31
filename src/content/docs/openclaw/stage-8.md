---
title: "阶段 8：工程化、测试与运维"
description: "阶段 8：工程化、测试与运维。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：OpenClaw 源码课 · 阶段卷
> 前置：阶段 1～7
> 对应总览：`03-工程实战.md`
> 本阶段目标：建立检查链、测试层次、schema 迁移和故障排查顺序。

## 1. 本阶段解决什么

OpenClaw 同时运行 Gateway、模型、工具、SQLite、插件、渠道和沙箱。常见故障不是单点语法错误，而是：

- 同一 session 并发写入；
- schema 升级后旧快照不可读；
- provider/harness 回退后 transcript 多写一次；
- MCP 失联但 UI 仍显示工具；
- 沙箱配置不安全；
- 取消后旧进程仍持有 writer；
- 跨平台路径、编码、进程清理差异。

工程化要让这些问题在提交前或启动前被发现，而不是靠线上猜测。

## 2. 先记住一个判断

**测试要覆盖“所有权 + 失败边界”，不只是 happy path 输出。**

真正有价值的测试会问：谁写、谁不能写、重试是否重复、迁移是否可读、失败是否 fail closed。

## 3. 源码主线

1. `scripts/check.mts` 与仓库 scripts 串起类型检查、架构边界、格式和测试入口。
2. `tsconfig*.json`、lint/format 配置固定导入边界与代码质量。
3. `src/state/` 的 schema、migration、snapshot、lease 测试覆盖数据库升级与并发。
4. `src/gateway/server-methods/` 的 admission/writer/abort/cancellation 测试覆盖幂等、接管与取消。
5. `packages/agent-core` 与 `src/agents/` 的 session/loop/compaction 测试覆盖 tool 配对、steering、follow-up 与历史重写。
6. `src/agents/sandbox/` 的边界测试覆盖 mount、路径、env、backend 和生命周期。
7. `src/agents/subagents/` 测试覆盖 child session、恢复、超时与父/子所有权。

## 4. 关键对象与合同

| 测试层 | 要证明什么 | 典型失败 |
| --- | --- | --- |
| contract/unit | 类型、决策、纯函数 | 语义漂移 |
| loop/session | 工具配对、steering、follow-up | 孤立 call/重复回复 |
| gateway | 幂等、ACK、writer fence、abort | 重复 run/旧 writer 写入 |
| state/migration | schema 升级、快照、lease | 旧库不可读/并发覆盖 |
| sandbox | 路径、mount、env、生命周期 | 越界/残留 |
| plugin/MCP | 注册、连接、退避、权限 | 能力绕过/可见不可用 |
| cross-platform | 路径、编码、进程清理 | Windows/Linux 差异 |

### 排障顺序

```text
1. 先看 admission/run 终态，确认请求是否被接纳
2. 再看 sessionKey/sessionId/writer，确认归属与写权
3. 看 harness/model 候选，确认执行运行时
4. 看 tool policy/approval/sandbox，确认副作用边界
5. 看 transcript cursor/branch，确认历史提交
6. 看 reply/event seq，确认用户是否收到
7. 最后才看模型文本本身
```

从后往前查，容易把“回复没到”误判成模型问题。

## 5. 一条可观察链路

```text
source change
  → type/lint/architecture check
  → focused unit/contract tests
  → loop/gateway/state integration
  → migration/recovery tests
  → cross-platform smoke
  → release archive
```

## 6. 实验

### 实验 A：writer 接管测试

阅读 `chat-send`/session-bootstrap 相关测试。参考验收：能列出幂等、CAS 失败、supersede、旧 writer 拒绝写入四条断言。

### 实验 B：schema 迁移

找一组 session migration 测试，观察旧版本 fixture 如何升级。参考验收：迁移后旧 session/transcript 可读，失败时不会静默降级到空数据。

### 实验 C：沙箱边界测试

阅读 mount/path/env 测试。参考验收：越界路径、只读/读写挂载、秘密环境变量在启动前被验证，而不是等工具执行后才发现。

### 实验 D：断线恢复

用 Gateway 事件/快照测试模拟漏事件。参考验收：按 seq 重同步，旧 stateVersion 快照不覆盖新状态。

### 实验参考答案

1. 应能列出幂等命中、CAS 失败、supersede、旧 writer 拒绝写入四条断言。
2. 迁移应让旧 session/transcript 可读；失败时明确报错，不静默变成空数据。
3. 越界路径、挂载权限和秘密环境应在启动前验证，不能等工具执行后才检查。
4. 漏事件后按 `seq` 重同步；旧 stateVersion 快照不得覆盖新状态。

## 7. 失败与恢复

| 故障 | 先查 | 恢复原则 |
| --- | --- | --- |
| 请求重复执行 | clientRunId/idempotency | 复用原 run |
| 历史交错 | writer fence/lane | 撤销旧写权 |
| 回复丢失 | ReplyDispatcher/event seq | 重放/重发，不重跑模型 |
| 旧库打不开 | schema/migration | 备份后迁移，fail closed |
| MCP 工具不可用 | 连接/退避 | 保留目录，执行返回 unavailable |
| 沙箱越界 | mount/env/authority | 启动前拒绝，不执行 |
| 子 Agent 失控 | child run/超时 | 显式取消与回收 |

## 8. 通关自测

1. 为什么排障要先看 admission/终态，而不是模型回复？
2. writer 接管测试至少要覆盖哪些断言？
3. schema 迁移失败为什么不能回退成空数据库？
4. MCP 失联时正确用户语义是什么？
5. 为什么沙箱边界要在启动前验证？
6. 如何处理“回复没到但模型已完成”？

### 参考答案

1. 模型回复只是执行的一部分。若请求没被接纳、run 已被 supersede 或 writer 写错，继续追模型文本会误判。先确认事实链的上游。
2. 幂等命中、CAS 成功/失败、旧 writer supersede、旧 writer 之后不能 append，以及最终 terminal outcome 可审计。
3. 空库会让用户以为历史丢失，还可能让新 run 覆盖旧记录。正确做法是备份、阻断启动、修迁移或显式恢复。
4. 工具目录可保留，但调用返回 unavailable；后台按退避重连。不能把目录存在当可执行，也不能静默删除用户配置。
5. 一旦容器/进程启动，越界挂载、秘密暴露或路径逃逸已经可能造成影响。必须在启动前 fail closed。
6. 检查 ReplyDispatcher、event seq 和 run 终态；若回复未 settle，重放/重发回复，不能重新执行模型或工具。

## 9. 源码坐标

- `scripts/check.mts`
- `package.json`
- `src/state/openclaw-agent-db-session-migrations.ts`
- `src/state/openclaw-agent-session-snapshots-schema.ts`
- `src/gateway/server-methods/chat-send-admission.ts`
- `src/agents/embedded-agent-runner/run/session-bootstrap.ts`
- `packages/agent-core/src/agent-loop.ts`
- `src/agents/sandbox/validate-sandbox-security.ts`
- `src/agents/subagents/registry/`

## 10. 下一步

进入阶段 9：把 ingress、loop、context、approval、fallback、transcript 与测试合成一个可交付扩展设计。
