---
title: "阶段 3：Prompt、上下文与压缩"
description: "阶段 3：Prompt、上下文与压缩。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：Hermes Agent 源码课 · 阶段卷
> 前置：阶段 1、2
> 对应总览：`01-一次Turn的一生.md` 第 5～6 节，`02-核心机制.md` 第 2 节
> 本阶段目标：区分 `messages`、`api_messages` 与 system prompt，理解压缩为什么是唯一允许改变历史字节的边界。

## 1. 本阶段解决什么

模型看到的不是 SessionDB 里的消息原样，也不是简单的 `messages + system prompt`。Hermes 同时维护：

- transcript：持久、可恢复、给 UI/审计看的会话记录；
- wire copy：这一次真正发给 provider 的结构化消息；
- system prompt 的三层缓存带；
- 压缩后的摘要、工具结果剪枝与 session 旋转。

如果分不清这些副本，就会把“本地看起来一样”误当成“prompt cache 命中”，或者把“压缩后还能恢复”误当成“原 session 被原地改写”。

## 2. 先记住一个判断

**同一会话在一段稳定历史内必须发送字节稳定的前缀；只有显式压缩可以改变这段历史。**

这条规则约束了：

- system prompt 为什么分 stable/context/volatile；
- 为什么 workspace snapshot 要冻结；
- 为什么 `api_content` sidecar 要保存“实际发出去的字节”；
- 为什么工具执行中可以追加 tail，但不能偷偷重写历史；
- 为什么 fallback 必须重新走 preflight，而不是拿旧请求直接换 provider。

## 3. 源码主线

1. `agent/turn_context.py::build_turn_context()` 先恢复可能已旋转的 session，再绑定日志、turn id、platform 和 per-turn state。
2. 它通过 `_refresh_mcp_tools_between_turns()` 处理轮间工具变化，但这不等于允许轮中任意换 toolset。
3. `_stage_turn_user_message()` 把本轮用户输入放入消息序列；`_hydrate_from_history()` 恢复历史与压缩状态。
4. `_restore_or_build_system_prompt()` 优先复用已持久 prompt；只有首次或压缩后才能重建。
5. `agent/system_prompt.py::build_system_prompt_parts()` 生成 `stable → context → volatile` 三层。
6. `build_api_messages()` 从 canonical history 克隆出 wire copy，移除持久化专用字段，并注入只在 API 时可见的 memory/hook 上下文。
7. `_stamp_api_content_sidecar()` 把本轮实际发送内容记入 `api_content`，使后续回放可以复用同一字节。
8. `agent/turn_preflight.py::run_preflight_compression()` 在每次 API 调用前估计 token，决定 fallthrough、continue、break 或 return。
9. `agent/context_compressor.py::ContextCompressor.compress()` 先剪旧 tool result，再分 head/middle/tail，摘要中间并清理孤儿 tool pair。
10. 压缩可产生 child session，但保留 parent/child 账本关系；原历史仍可由原 session 和摘要边界解释。

## 4. 关键对象与合同

| 对象 | 保存什么 | 不能混同 |
| --- | --- | --- |
| `messages` | 本轮内存中的会话序列 | provider 最终字节 |
| `api_messages` | 本次 wire copy | 持久 transcript |
| `api_content` | 实际发送过的用户/助手文本 | 展示文本或模型原始 reasoning |
| stable prompt | 身份、通用指导、稳定编码 posture | 当前时间、memory、skills index |
| context prompt | 调用方 system message、项目上下文、冻结 workspace | 每轮变化的随机状态 |
| volatile prompt | skills、memory、profile、时间与运行时提示 | 稳定前缀 |
| summary message | 被压缩中间段的可继续工作摘要 | 原始历史 |
| child session | 压缩后继续工作的会话 | 已删除原账本 |

压缩默认参数（源码可配置，不是永远固定）：

- `threshold_percent = 0.50`；
- `summary_target_ratio = 0.20`；
- `protect_first_n = 3`；
- `protect_last_n = 20`；
- `tail_mode = "lean"`。

实际阈值还会受模型特定阈值、小上下文 floor、输出预留与上限修正影响，因此课程里不能说成“固定 75%”。

## 5. 一条可观察链路

~~~text
conversation_history
  → build_turn_context
  → stage user message / hydrate history
  → build or restore system prompt
  → build_api_messages
       clone
       pop api_content + persistence fields
       replay exact api_content
       inject ephemeral memory/hooks
  → estimate request tokens
  → preflight gate
       under threshold → provider
       over threshold  → prune + compress
       still over      → continue / fail closed
  → API request
~~~

观察点：同一条历史用户消息在 transcript 与 wire copy 中可能有不同 `content`；这不是 bug，而是展示/恢复与 provider 字节的职责分离。

## 6. 实验

### 实验 A：比较 transcript 与 wire copy

记录一轮带 ephemeral memory 的消息，在 `build_api_messages()` 前后打印。

### 实验 B：验证 prompt 前缀稳定

连续两轮不改 memory/skills/workspace，比较 stable + context 前缀。

### 实验 C：触发压缩

构造超阈值历史，观察 prune 数量、head/tail 边界、summary、孤儿 tool pair 和 session id。

### 实验参考答案

1. **实验 A**：transcript 保存持久内容与元数据；wire copy 去掉 `api_content`、`_row_id`、display 等字段，只保留 provider 能接受的字段，并注入本轮 API-only 上下文。
2. **实验 B**：两轮 stable/context 部分应保持一致；volatile 中的 timestamp 等可变字段可能不同，因此真正的缓存前缀应停在稳定边界。
3. **实验 C**：旧 tool result 可能先被摘要/剪枝；头尾受保护，中间被摘要；若有孤儿 tool call/result，需要补配对或安全清理；旋转时产生 child session 并保留来源关系。

## 7. 失败与恢复

| 失败 | 事实 | 恢复 |
| --- | --- | --- |
| system prompt 被提前落库 | 可能存成 NULL 或旧字节 | 构建 prompt 后再创建/更新 session 行 |
| 轮中重载 memory | 历史前缀改变，缓存失效 | 只在显式压缩边界重建 |
| `api_content` 丢失 | replay 字节漂移 | 保留 sidecar；压缩时按规则重建 |
| 压缩被锁/冷却阻塞 | 请求仍过大 | 退款本次压缩尝试，按 gate 继续或失败 |
| 压缩无进展 | 不能无限重试 | 达到上限 fail closed，保留可恢复 transcript |
| 压缩超时 | 未到 provider | 返回压缩超时结果，不把请求原样发送 |
| 孤儿 tool pair | provider 可能拒绝 | 清理或补配对，保持 call/result 结构 |
| 旋转后读错 session | 后续写入 child 或旧账本 | 先 resolve 当前 canonical child |

## 8. 通关自测

1. `messages`、`api_messages`、transcript 三者有什么区别？
2. system prompt 为什么分 stable/context/volatile？
3. 为什么 workspace snapshot 要冻结？
4. `api_content` 解决什么问题？
5. 压缩为什么保护头、尾，只摘要中间？
6. 压缩后为什么要可能旋转 child session？
7. fallback 为什么不能沿用旧 `api_messages`？

### 参考答案

1. `messages` 是 turn 内的工作序列；`api_messages` 是本次实际发送给 provider 的克隆；transcript 是持久账本，供恢复、展示、审计和后续轮次回放。
2. 为了让不会变化的内容形成最长公共前缀，减少 prompt cache miss；同时把 memory、skills、时间和 profile 等易变内容放到尾部，避免一变化就重算全部前缀。
3. 同一 session 中工作目录、项目上下文和环境提示如果每轮重读，会改变 stable/context 字节；冻结快照保证缓存前缀稳定，只有 session/压缩边界才更新。
4. 它记录模型实际收到过的精确文本，回放时复用同一字节，避免展示层清洗、代理注入或 sanitize 导致每轮 wire copy 漂移。
5. 头部通常含系统约束和最早的上下文，尾部是最近工作与当前 turn；直接摘要会把最需要保留的行为约束和即时任务弄丢。中间历史信息密度较低，适合压缩成摘要。
6. 旋转把“压缩后的新工作上下文”与“原账本”分开，避免把摘要伪装成原始消息，同时保留 parent/child 关系供恢复、审计和继续对话。
7. 新 provider 的上下文窗口、adapter、消息格式和 token 预算都可能不同；必须回到 preflight 重新估计、压缩和构造请求，否则可能超窗或发送不兼容字段。

## 9. 源码坐标

- `agent/turn_context.py::build_turn_context`
- `agent/turn_context.py::build_api_messages`
- `agent/turn_context.py::_stamp_api_content_sidecar`
- `agent/system_prompt.py::build_system_prompt_parts`
- `agent/system_prompt.py::invalidate_system_prompt`
- `agent/turn_preflight.py::run_preflight_compression`
- `agent/context_compressor.py::ContextCompressor.compress`
- `agent/context_compressor.py::_compress_window`
- `tests/agent/test_context_token_tracking.py`
- `tests/gateway/test_runner_compressed_receipt.py`

## 10. 下一步

进入阶段 4：上下文里出现工具调用后，谁先把 call 写进账本，谁才有资格产生真实副作用。
