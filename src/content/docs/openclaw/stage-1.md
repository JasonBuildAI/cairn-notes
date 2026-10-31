---
title: "阶段 1：Gateway、Session 与 Run"
description: "阶段 1：Gateway、Session 与 Run。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：OpenClaw 源码课 · 阶段卷
> 前置：阶段 0
> 对应总览：`01-一条消息的一生.md` 的准入部分
> 本阶段目标：掌握 chat.send 接纳、幂等、lane、writer fence 与 superseded 的真实语义。

## 1. 本阶段解决什么

同一个 session 可能同时收到两条请求：用户在 WebChat 连续发送，Telegram 又补一条，自动任务也刚好唤醒。系统必须回答：

- 这次请求是否重复，能否复用原结果？
- 先 ACK 还是等模型结束？
- 两条请求是并行还是排队？
- 谁有资格写同一段 transcript？
- 旧 run 还活着时，新 run 怎样接管？
- 断线、取消、重启后，怎样判断 run 的真实状态？

OpenClaw 把这些问题放在 Gateway/Session/Run 层，不让模型循环自己解决。

## 2. 先记住一个判断

**`chat.send` 返回 `in_flight` 只表示已接纳；Session lane 决定先后，writer fence 决定谁有写权。**

接纳、执行、提交历史和发送回复是四个不同事实。把它们混成一个“成功”会让断线重试、并发接管和取消都变得不可判定。

## 3. 源码主线

1. `chat-send-handler.ts` 接收 RPC，调用 admission，完成幂等/权限/会话绑定后发送 ACK。
2. `chat-send-admission.ts` 在 writer barrier 下冻结 sessionId、run authority 与幂等记录，避免准备期间被并发替换。
3. `agent-run-handler.ts` 启动 detached agent execution；RPC 连接断开不取消 run。
4. `agent-command.ts` 与 embedded runner 处理 session lane/global lane，确保同会话串行、全局资源有界。
5. `embedded-agent-runner/run/session-bootstrap.ts` 以 CAS 比较 sessionId 并写入 `activeWriterRunId`。
6. 发现旧 writer 时调用 supersede，旧 run 以 `superseded` 终止，不能继续写 transcript。
7. `chat-abort-runtime.ts` 处理取消；取消是独立控制事实，不等于删除历史。

## 4. 关键对象与合同

| 对象 | 作用 | 关键不变量 |
| --- | --- | --- |
| `clientRunId` | 客户端幂等键 | 同一键最多对应一份接纳/执行 |
| `runId` | 服务端执行身份 | 与事件、终态、transcript commit 绑定 |
| `sessionKey` | 路由身份 | 决定消息归属哪段逻辑对话 |
| `sessionId` | 持久化记录身份 | writer CAS 比较它是否变化 |
| `activeWriterRunId` | 当前写者 | 同一时刻只有新 owner 可写 |
| lane | 并发控制 | 同 session 串行，全局有上限 |
| terminal outcome | run 结局 | success/error/abort/superseded 等可审计 |

### ACK 的状态

- 新建接纳：返回 `in_flight`，表示 run 已建立；
- 同一幂等键仍在执行：返回已有 `in_flight`，不新建 run；
- 已有终态：返回原结果或明确状态；
- 准入失败：返回权限/参数/冲突错误，不创建执行。

### writer 接管

```text
读取 session 当前 sessionId 与 activeWriterRunId
  → 条件写入新 runId
  → CAS 成功：新 run 拥有写权
  → 旧 run 存在：标记 superseded 并停止写
  → CAS 失败：重新读取/冲突，不能无条件覆盖
```

## 5. 一条可观察链路

```text
chat.send
  → admission / idempotency
  → ACK in_flight
  → detached dispatch
  → sessionKey → sessionId
  → session lane
  → writer fence CAS
  → embedded runner
  → transcript commit
  → terminal outcome
  → event/reply
```

调试时分别记录 admission id、runId、sessionKey、sessionId、activeWriterRunId 和 terminal outcome，避免只看一个 `in_flight`。

## 6. 实验

### 实验 A：重复 chat.send

用同一 `clientRunId` 在 run 执行期间发两次。参考验收：第二次返回同一 run 的 `in_flight`，没有新增执行或 transcript commit。

### 实验 B：同 session 并发

不同 `clientRunId` 同时发到同一 `sessionKey`。参考验收：按 lane 串行/排队；不会出现两个 writer 同时追加历史。

### 实验 C：writer 接管

构造新 run 在旧 run 未结束时取得写权。参考验收：CAS 更新 `activeWriterRunId`，旧 run 收到 supersede 并以 `superseded` 收尾，旧 writer 不再写。

### 实验 D：断线重连

ACK 后断开 WebSocket，再读取 run 状态。参考验收：执行继续，客户端通过事件/快照恢复；不是重新提交一次模型调用。

### 实验参考答案

1. 同一 `clientRunId` 的第二次请求应复用同一 run，返回 `in_flight`，不新增执行或 transcript commit。
2. 不同 `clientRunId` 属于同一 session 时按 lane 串行/排队，任一时刻只有一个 writer 能追加历史。
3. 新 run 通过 CAS 更新 `activeWriterRunId`；旧 run 被 supersede，之后写操作应被 writer fence 拒绝。
4. ACK 只表示已接纳。断线后执行继续，客户端靠事件/快照恢复，不应重新提交模型调用。

## 7. 失败与恢复

| 现象 | 先查 | 恢复 |
| --- | --- | --- |
| 客户端重复执行 | clientRunId 幂等记录 | 复用原 run，不新建 |
| 历史交错 | lane 与 writer fence | 阻断旧 writer，修 CAS |
| run 永远 in_flight | terminal outcome/事件流 | 查进程/心跳，按恢复策略收尾 |
| 新 run 覆盖旧历史 | sessionId 是否变化 | 重新绑定或返回冲突 |
| abort 后仍写 | writer 权限/取消传播 | 撤销写权并记录取消终态 |
| ACK 成功但无 run | admission 持久化/调度 | 修复接纳事务，不静默丢请求 |

## 8. 通关自测

1. `in_flight` 为什么不是完成？
2. `clientRunId` 与 `runId` 有什么区别？
3. 为什么同 session 需要 lane，writer fence 又解决什么？
4. CAS 比较 `sessionId` 的意义是什么？
5. 旧 writer 为什么必须显式 `superseded`？
6. 断线后为什么不能直接重发请求？

### 参考答案

1. 它只证明请求已被接纳并可恢复执行；模型、工具、transcript commit 和回复投递都还没完成。把它当完成会误判成功并可能重复执行。
2. `clientRunId` 是客户端重试的幂等键，`runId` 是服务端一次执行的内部身份。前者用于去重，后者用于事件、终态、写权和恢复。
3. lane 控制执行顺序，避免同 session 并发跑多个 agent turn；writer fence 控制历史写权，防止执行顺序之外的重写/接管交错。两者解决不同层。
4. `sessionId` 变化意味着底层持久化记录已重写、切换分支或被替换。CAS 若只比较 writer 而忽略 sessionId，就可能把新记录的 id 写到旧记录上。
5. 只有显式 supersede 才能让旧 run 停止写、释放资源并留下可审计终态。静默忽略仍可能由旧进程追加历史或产生副作用。
6. 断线不等于服务端 run 丢失。重发会创建新执行或制造冲突；应先按 runId 查询/订阅事件，确认终态后再决定是否补发。

## 9. 源码坐标

- `src/gateway/server-methods/chat-send-handler.ts`
- `src/gateway/server-methods/chat-send-admission.ts`
- `src/gateway/server-methods/agent-run-handler.ts`
- `src/gateway/server-methods/chat-abort-runtime.ts`
- `src/agents/embedded-agent-runner/run/session-bootstrap.ts`
- `src/agents/embedded-agent-runner/runs.ts`
- `src/agents/agent-command.ts`
- `src/agents/command/session-store.ts`

## 10. 下一步

进入阶段 2：请求已接纳且拿到写权，Agent Loop 怎样把模型输出、工具调用、steering 和 follow-up 组织成一次有界执行？
