---
title: "OpenClaw 2026.10.9 阶段课 · 导读"
description: "十个源码阶段的阅读顺序、阶段地图、建议节奏与通关标准。"
---

> 基线：发布归档 `openclaw-2026.10.9`。归档不含 `.git`，不虚构 commit/tag。
> 路径相对 `$OPENCLAW_SRC`。
> `00`～`03` 是总览；本组从阶段 0 到阶段 9 把同一条消息生命周期拆深。

## 一句话理解 OpenClaw

**OpenClaw 是一个常驻 Gateway 驱动的个人 Agent 运行时：渠道和 UI 只负责进出，Session/Run 负责归属与执行，Agent Harness 负责模型与工具循环，transcript 与 writer fence 负责可恢复的历史。**

把它想成一座 24 小时运行的调度中心：

```text
渠道 / WebChat / TUI / Node
        │
        ▼
Gateway：鉴权、路由、幂等、事件
        │
        ▼
Session / Run admission：队列、接管、取消
        │
        ▼
Writer fence：谁有资格写这段历史
        │
        ▼
Agent Loop：模型流 → 工具批次 → steering → 下一轮
        │
        ▼
Compaction / Pruning / Approval / Model fallback
        │
        ▼
Transcript commit → Reply → 原渠道 / UI
```

## 十阶段大脉络

| 幕 | 阶段 | 核心问题 |
| --- | --- | --- |
| 第一幕：进入系统 | 0～2 | 代码在哪、请求归谁、循环怎样推进 |
| 第二幕：控制上下文 | 3 | 哪些历史改写、哪些只影响本次 prompt |
| 第三幕：安全执行 | 4～5 | 工具谁批准、模型/harness 怎样失败转移 |
| 第四幕：留下事实 | 6～7 | transcript 怎样写、插件/渠道怎样扩展 |
| 第五幕：工程闭环 | 8～9 | 测试、迁移、恢复与毕业设计 |

这五幕不是五个模块，而是同一条因果链：**入口归一 → 所有权唯一 → 循环有界 → 上下文可重建 → 工具可放行 → 结果可落账。**

## 十个阶段

| 阶段 | 文档 | 你会得到什么 |
| --- | --- | --- |
| 0 | [环境与源码地图](../stage-0/) | 版本、目录、进程拓扑、六个核心身份 |
| 1 | [Gateway、Session 与 Run](../stage-1/) | `chat.send`、in-flight、lane、writer fence、取消 |
| 2 | [入口与 Agent Loop](../stage-2/) | 渠道 ingress、两层循环、工具批次、steering、follow-up |
| 3 | [上下文压缩与 Pruning](../stage-3/) | system prompt、bootstrap、compaction、cache-TTL pruning |
| 4 | [工具审批与 Sandbox](../stage-4/) | 工具装配、before_tool_call 顺序、deny/defer/report/request、隔离 |
| 5 | [模型认证、Fallback 与 Harness](../stage-5/) | model ref、auth profile、候选链、fallback、auto harness |
| 6 | [Session、Transcript 与 Writer](../stage-6/) | SQLite transcript、分支、rewrite、终态与恢复 |
| 7 | [插件、渠道、协议与 UI](../stage-7/) | Plugin/MCP/Skills、渠道、Gateway 事件、UI/子 Agent |
| 8 | [工程化、测试与运维](../stage-8/) | 检查链、schema 迁移、writer/lane 测试、故障排查 |
| 9 | [毕业设计](../stage-9/) | 设计一个可审批、可回放、可恢复的扩展 |

## 三条贯穿判断

### 1. 消息入口归一，但事实不混用

WhatsApp、Telegram、WebChat、TUI 的传输不同，最终都要进入同一套 Session/Run 语义。渠道消息不是 transcript；`chat.send` 的 ACK 也不是最终回复。

### 2. 所有权必须唯一

session lane 决定谁先执行，writer fence 决定谁写 transcript，approval owner 决定谁放行工具，plugin capability owner 决定哪家 provider/channel 可用。所有权模糊时，系统会出现交错历史、重复副作用或“审批后又被 hook 改参数”。

### 3. 可重建视图与不可重建事实分开

compaction/pruning 是可重建的上下文视图；run 终态、writer 接管、审批结果、幂等键和 transcript commit 是不可随意丢失的事实。

## 一条可以背下来的主链

```text
ingress
  → normalize / admission
  → session binding
  → writer fence
  → model + harness selection
  → context projection
  → agent loop
  → tool policy / approval / sandbox
  → transcript commit
  → reply delivery
```

读每个阶段都问三句：**这条事实属于谁？失败后停在哪？重试时哪些副作用不能重做？**

## 推荐读法

- 第一遍只看主链，不追具体 channel/provider。
- 第二遍打开源码坐标，确认函数、对象和失败返回。
- 第三遍做实验：同 session 并发、工具等待审批、provider fallback、compaction/pruning 对比。

## 学习完成标准

1. `clientRunId`、`sessionKey`、`sessionId`、`runId` 各是什么？
2. `chat.send` 返回 `in_flight` 为什么不是完成？
3. 新 writer 接管时，旧 run 为什么必须 `superseded`？
4. Agent Loop 的内层和外层继续条件分别解决什么？
5. compaction 与 cache-TTL pruning 修改的对象有什么不同？
6. `before_tool_call` 的顺序中，为什么审批必须在普通 hook 前？
7. 模型 fallback 与 harness fallback 为什么不是同一件事？
8. `agent_end` 后为什么还可能继续投递或落账？

### 参考答案

1. `clientRunId` 是客户端重试的幂等身份；`sessionKey` 是 Gateway 的路由身份；`sessionId` 是持久化会话记录身份，可能因重写/分支变化；`runId` 是一次执行的运行身份。
2. 它只表示 Gateway 已接纳请求并建立可恢复的执行，后续模型、工具、transcript 和投递尚未完成。把 ACK 当结果会让客户端在断线后重复提交或误判成功。
3. 旧 writer 如果继续写，会与新 writer 交错追加历史、重复副作用，且无法审计最终所有权。显式 `superseded` 让旧 run 停止写、释放资源并留下可解释终态。
4. 内层处理“当前 turn 还没结束”：还有工具调用或 steering 消息就继续；外层处理“turn 结束后是否有 follow-up”，有则继续同一逻辑执行，没有再进入 `agent_end`。
5. compaction 改写历史/transcript 视图并生成摘要；cache-TTL pruning 只替换本次 prompt 中的过期 tool result，磁盘 transcript 保持原文。
6. 若普通 hook 在审批前运行，它可以修改工具参数或补造证据，让审批看到被“洗过”的调用。审批必须看原始调用；最终 owner approval 还要在 hook 后独立放行。
7. 模型 fallback 在同一个 harness 内换模型/凭据/路由；harness fallback 换的是执行运行时，可能改变工具协议、steering、session 映射和能力。
8. 模型循环结束只表示不再生成；之后还要提交 transcript、记录 terminal outcome、settle reply dispatcher、发送分段回复、更新 session 元数据并释放资源。

## 下一步

从 `stage-0.md` 开始，先认身份和边界，再看一条请求怎样进入同一个 Run。
