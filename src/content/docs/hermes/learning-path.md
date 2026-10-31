---
title: "Hermes Agent 阶段课 · 导读"
description: "十个源码阶段的阅读顺序、阶段地图、建议节奏与通关标准。"
---

> 基线：发布归档 `hermes-agent-0.22.5`，发布版本 `v0.22.5`。
> 归档不含 `.git`，因此本卷不声称 commit/tag；`pyproject.toml` 里的 `version = "0.0.0"` 是构建占位，不是发布版本。
> 路径相对 `$HERMES_SRC`。
> 已有 `00`～`03` 是总览；本卷按阶段 0～9 沿真实源码深入。

## 为什么要有阶段卷

总览回答“Hermes 有哪些层”，阶段卷回答“下一条语句在哪里、事实归谁、失败后谁接管”。读完总览，你应当已经有下面这条粗线；阶段课负责把每一段拆成可验证的源码因果。

~~~text
入口提交
  → admission（持久排队）
  → durable turn lease（单写者授权）
  → turn context / system prompt
  → preflight 压缩闸门
  → 模型请求 / 流式响应
  → 工具轮次（先持久化，再执行）
  → finalize / transcript
  → delivery / 事件回放
~~~

一句话主线：

**`submit → admission → lease → context → preflight → API/tool loop → finalize → delivery`。**

## 两种“总览”，各读什么

| 材料 | 适合回答 |
| --- | --- |
| `overview.md` | 产品定位、进程拓扑、目录与术语 |
| `turn-lifecycle.md` | 先得到完整生命周期直觉 |
| `core-mechanisms.md` | 按上下文、工具、模型、持久化等主题补齐 |
| `engineering.md` | 排障、修改配方、失败矩阵 |
| 本卷阶段 0～9 | 沿源码逐段建立所有权、状态迁移与恢复因果关系 |

## 每篇固定追问

1. 这一步拥有什么事实？
2. 谁有资格修改这个事实？
3. 失败后，哪个持久行、事件或结果字段能证明做到哪一步？
4. 哪些副作用已经发生，绝不能因为“重试”再发生一次？

## 阶段地图

| 阶段 | 主题 | 完成后应能解释 |
| --- | --- | --- |
| 0 | [环境与源码地图](../stage-0/) | 三种宿主、四个边界、核心目录 |
| 1 | [前端 Admission 与 Lease](../stage-1/) | 输入怎样变成单写者的 durable turn |
| 2 | [ConversationLoop](../stage-2/) | 一轮循环怎样推进与退出 |
| 3 | [Prompt、上下文与压缩](../stage-3/) | 模型实际看到什么，压缩改变了什么 |
| 4 | [工具与 PersistBeforeExecute](../stage-4/) | 工具调用的持久化边界与副作用 |
| 5 | [Provider、凭据与 Fallback](../stage-5/) | 为什么换模型必须重建上下文 |
| 6 | [SessionDB 与恢复](../stage-6/) | transcript、schema、锁与重启恢复 |
| 7 | [扩展平台与多 Agent](../stage-7/) | plugin、cron、delegate、渠道各扩展哪层 |
| 8 | [工程化测试与排障](../stage-8/) | 用证据定位故障层 |
| 9 | [毕业设计](../stage-9/) | 完成一个可恢复、可审计的改造 |

## 建议节奏

- **第一遍只读“源码主线”和“可观察链路”**，不要背字段。
- **第二遍做实验**，至少观察一个 admission 状态、一个 prompt 字节差异或一个失败分支。
- **第三遍回答自测题**，再回源码核对，而不是只对字面答案。
- 每完成一篇，在纸上补一句：“事实源是 ____；失败接管者是 ____；不能重做的副作用是 ____。”

## 全卷完成标准

你应当能够不看总览，独立解释：

- 经典 CLI 为什么只提交并回放事件，真正的 turn 在哪个宿主执行；
- `queued / started / unknown / terminal` 与租约 TTL、刷新、丢失后的关系；
- 为什么工具的 call 必须先持久化，再产生副作用；
- 为什么 provider fallback 必须回到 preflight，而不是原地换客户端；
- 压缩为什么保护头尾、摘要中间，并可能旋转 child session；
- `SessionDB` 的 transcript、admission、lease、compression lock 各自证明什么；
- 同一个 Agent 核心如何被 CLI、TUI、消息平台、cron 和子 Agent 复用。

> 从阶段 0 开始，先把“入口/宿主/Agent/账本”四个词分清；后面所有代码都会落在其中一层。
