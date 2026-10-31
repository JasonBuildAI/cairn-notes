---
title: "阶段 6：Session、Transcript 与 Writer"
description: "阶段 6：Session、Transcript 与 Writer。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：OpenClaw 源码课 · 阶段卷
> 前置：阶段 1～5
> 对应总览：`message-lifecycle.md` 的落账部分
> 本阶段目标：理解 transcript 的 canonical 地位、append/rewrite、分支、修复与 writer 提交。

## 1. 本阶段解决什么

模型结束后，系统仍要决定：

- 哪些消息算已提交历史；
- 失败候选、assistant error、reasoning 是否写入；
- compaction 怎样改写旧历史；
- tool call 与 result 怎样保持配对；
- rewrite 后 sessionId/branch 是否变化；
- 旧 writer 和终态错误怎样留下可审计事实；
- 重启后从哪里读取同一段 transcript。

这些不是 UI 展示问题，而是会话可恢复性的核心。

## 2. 先记住一个判断

**transcript 是会话事实，prompt 是本轮投影；append/rewrite 必须由当前 writer 提交。**

看到模型输出不等于 transcript 已提交；看到 compaction 摘要也不等于原文一定消失。恢复时以数据库/transcript 合同为准。

## 3. 源码主线

1. `agent-session-transcript.ts` 负责会话 transcript 的读取、追加与投影。
2. `src/state/openclaw-agent-db-schema.ts` 与 session migrations 定义 SQLite 表、版本与迁移。
3. `transcript-rewrite.ts` 生成可控的历史重写；compaction 通过 rewrite 边界落账。
4. `session-bootstrap.ts` 在 writer barrier 下绑定 sessionId 与 activeWriterRunId。
5. `transcript-policy.ts` 决定哪些内容可写、需脱敏或投影。
6. `session-transcript-repair.ts` 修复缺失/孤立 tool result 等协议问题。
7. `assistant-error-transcript.ts` 与 terminal error 记录把失败变成有类型的会话事实。

## 4. 关键对象与合同

| 对象 | 事实 | 注意 |
| --- | --- | --- |
| transcript entry | 已提交消息/事件 | 有序、可分支、可重放 |
| session row | 会话元数据与当前分支 | 与 sessionKey 不混用 |
| writer | 当前写入资格 | 非 writer 不能 append/rewrite |
| rewrite | 一次历史变换 | 必须原子提交并保留边界 |
| tool pair | call 与 result | 不能出现孤立 call |
| terminal error | run 结局 | 不能伪装成正常 assistant 回复 |
| branch | 历史分叉 | 读取必须指定当前分支 |

### append 与 rewrite

- append 适合新消息、tool result、正常终态；
- rewrite 适合 compaction、修复、分支重写；
- 两者都要受 writer 权限约束；
- rewrite 必须先构造完整新历史，再原子发布，不能逐条删改让读者看到中间态。

### 为什么错误也要落账

如果 provider 失败、工具拒绝或 abort 不写入任何事实，下一轮就无法知道发生了什么，也无法解释为什么没有回复。错误应是 typed transcript event，而不是空白。

## 5. 一条可观察链路

```text
accepted candidate messages
  → tool result pairing / redaction
  → append or rewrite plan
  → writer authority check
  → SQLite transaction / branch publication
  → transcript cursor
  → reply/event projection
```

## 6. 实验

### 实验 A：比较 append 与 compaction rewrite

正常回复后 append 一条消息；触发 compaction 后观察 rewrite。参考验收：append 保留原历史结构；rewrite 原子替换视图并保留边界/近期尾部。

### 实验 B：孤立 tool call

删除一个 tool result 或让工具跳过但未生成 result。参考验收：修复/校验逻辑发现配对缺失，拒绝发布不合法历史。

### 实验 C：旧 writer 写入

supersede 旧 run 后，让它尝试追加。参考验收：writer 检查拒绝写入，不产生交错条目。

### 实验 D：错误落账

让 provider 返回 terminal error。参考验收：记录 typed error，不写成正常 assistant 成功文本；后续恢复能识别终态。

### 实验参考答案

1. append 保留原历史；compaction rewrite 原子替换视图并保留边界与近期尾部，不能半写。
2. 缺 result 的 tool call 应被校验/修复或拒绝发布；不能留下不合法历史。
3. 旧 writer 尝试追加时应被 writer fence 拒绝，避免交错条目。
4. provider terminal error 应写成 typed error，不能伪装成正常 assistant 成功文本。

## 7. 失败与恢复

| 失败 | 事实风险 | 恢复 |
| --- | --- | --- |
| rewrite 半提交 | 读者看到不完整历史 | 原子发布/回滚 staging |
| 旧 writer 追加 | 交错与重复 | 拒绝写权，保留 superseded |
| tool result 缺失 | 协议不合法 | 修复或补 synthetic result |
| 错误未落账 | 无法解释终态 | 写 typed terminal event |
| 分支读错 | 基于 sibling 历史继续 | 绑定当前 branch/cursor |
| schema 迁移失败 | 数据库不可读 | fail closed，先迁移/备份 |

## 8. 通关自测

1. transcript 与 prompt 的区别是什么？
2. 为什么 transcript rewrite 必须原子发布？
3. append 与 rewrite 各适合什么场景？
4. 为什么 terminal error 也要写进 transcript？
5. 非当前 writer 为什么不能 append？
6. 分支读取错误会导致什么？

### 参考答案

1. transcript 是持久会话事实，prompt 是从 transcript、system prompt 和 pruning 规则生成的本轮投影。投影可重建，transcript 的提交需受 writer 与事务约束。
2. 读者可能在中间态看到缺消息、孤立 tool call 或半摘要。原子发布保证历史要么完整旧版，要么完整新版。
3. append 用于新增消息/结果/终态；rewrite 用于 compaction、修复和分支级历史变换。两者都必须经过 writer 与校验。
4. 否则系统无法解释 run 为何没有成功、是否可重试、错误是否已暴露给用户；空白历史还会让下一轮误以为从未发生。
5. writer 是唯一写权所有者。非 writer 写入会与当前 run 交错，破坏顺序、tool 配对和终态因果。
6. 系统可能读取 sibling branch 的旧消息，把已放弃的历史当成当前上下文，导致重复工具调用或错误完成判断。

## 9. 源码坐标

- `src/agents/sessions/agent-session-transcript.ts`
- `src/agents/embedded-agent-runner/transcript-rewrite.ts`
- `src/agents/embedded-agent-runner/run/session-bootstrap.ts`
- `src/agents/transcript-policy.ts`
- `src/agents/session-transcript-repair.ts`
- `src/agents/assistant-error-transcript.ts`
- `src/state/openclaw-agent-db-schema.ts`
- `src/state/openclaw-agent-db-session-migrations.ts`
- `src/state/openclaw-agent-session-snapshots-schema.ts`

## 10. 下一步

进入阶段 7：transcript 之外，插件、MCP、Skills、渠道和 UI 怎样扩展系统而不复制内核？
