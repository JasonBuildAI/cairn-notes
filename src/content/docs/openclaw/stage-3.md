---
title: "阶段 3：上下文压缩与 Pruning"
description: "阶段 3：上下文压缩与 Pruning。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：OpenClaw 源码课 · 阶段卷
> 前置：阶段 2
> 对应总览：`core-mechanisms.md` 的上下文部分
> 本阶段目标：区分 system prompt、workspace bootstrap、compaction 与 cache-TTL pruning 的所有者和副作用。

## 1. 本阶段解决什么

模型每次请求只能看到有限上下文。OpenClaw 同时面对四类压力：

- system prompt 与工作区 bootstrap 越来越长；
- transcript 超过模型窗口；
- 旧 tool result 占据大量 token；
- 工具目录、渠道提示和动态日期每轮变化，破坏缓存前缀。

这些压力不能都用“删消息”解决。不同层改的对象不同，恢复能力也不同。

## 2. 先记住一个判断

**compaction 改写历史视图，cache-TTL pruning 只改本次 prompt 投影。**

前者会影响后续轮次看到的 transcript；后者不写磁盘历史，重启后仍可从原文重建。把二者混为一谈，会错误判断“原文是否还在”。

## 3. 源码主线

1. `buildAgentSystemPrompt()` 组装 stable prefix、动态后缀与工具/渠道说明，并生成 `stablePrefixCacheKey`。
2. cache boundary 之上的内容保持稳定；日期、session、渠道与运行期提示放在后缀，避免整段前缀失效。
3. `bootstrap-files.ts` 解析 workspace 文件、hooks、预算与 injection mode，把项目上下文注入受控位置。
4. `prepareCompaction()` 测量上下文，保留近期尾部，选择需要摘要的中间历史。
5. `compact()` 调用摘要模型；`compactWithoutSummary()` 在摘要失败时仍保留近期原文并插入明确降级标记。
6. `tool-result-truncation.ts` 的 cache-TTL pruning 替换过期 tool result 为 placeholder，或在超限时截断/落盘引用。
7. transcript rewrite 由 harness/runner 提交；pruning 只生成请求投影，不改 canonical 历史。

## 4. 关键对象与合同

| 对象 | 所有者 | 修改对象 | 可恢复性 |
| --- | --- | --- | --- |
| system prompt stable prefix | agent/system prompt | 每轮 prompt | 可重建 |
| bootstrap context | workspace bootstrap | 本轮上下文 | 可重读文件 |
| compaction summary | harness/agent-core | 历史/transcript 视图 | 依赖摘要与原文策略 |
| kept recent tail | compaction | 历史尾部 | 保留近期原文 |
| cache-TTL pruning | embedded runner | 本次 prompt 投影 | 磁盘原文仍在 |
| spill file | tool-result truncation | 外部大结果 | 通过路径回读 |

### compaction 的默认预算

源码默认 `reserveTokens: 16384`、`keepRecentTokens: 20000`。触发不是“感觉太长”，而是估算上下文超过 `contextWindow - reserveTokens`。保留尾部必须能容纳完整消息原子，不能切出半个 tool pair。

### pruning 的占位语义

`CACHE_TTL_DEFAULT_PLACEHOLDER = "[Old tool result content cleared]"` 是给模型看的投影标记。图片也有单独 marker。它表示“这次不发送旧内容”，不表示“历史已被删除”。

## 5. 一条可观察链路

```text
transcript + bootstrap + system prompt
  → estimate context
  → compaction?（改写历史视图）
  → cache-TTL pruning?（清旧 tool result 投影）
  → truncate oversized results?（投影/落盘）
  → provider request
```

调试时要同时看磁盘 transcript、发给 provider 的 messages 和 pruning checkpoint。只看其中一份会得出错误结论。

## 6. 实验

### 实验 A：比较 compaction 与 pruning

构造一段含旧 tool result 的长历史。分别触发 compaction 与 cache-TTL pruning。参考验收：compaction 后历史视图出现摘要/边界；pruning 后磁盘 transcript 不变，只有请求投影出现 placeholder。

### 实验 B：摘要失败降级

让摘要模型报错。参考验收：走 `compactWithoutSummary()`，保留近期原文并插入“无摘要删除”的明确提示，而不是静默丢历史。

### 实验 C：稳定前缀

修改日期或渠道提示，比较 `stablePrefixCacheKey`。参考验收：动态字段在后缀时 key 不变；若 key 变化，说明字段被放进了 stable prefix。

### 实验 D：工具结果超限

让工具返回超大文本。参考验收：模型收到截断或 spill 引用，receipt 仍能定位原始输出；不把半截内容当完整结果。

### 实验参考答案

1. compaction 改变 transcript/view 语义并产生摘要边界；cache-TTL pruning 只改本次 prompt 投影，原始 transcript 不变。
2. 摘要失败应走 `compactWithoutSummary()`，保留近期原文并显式说明无摘要删除，不能静默丢历史。
3. 日期、渠道等动态字段应位于后缀，`stablePrefixCacheKey` 不因它们变化；若变化，说明字段放错层级。
4. 模型侧应收到截断或 spill 引用，原始输出仍可定位；半截内容不能伪装成完整结果。

## 7. 失败与恢复

| 失败 | 事实在哪 | 恢复 |
| --- | --- | --- |
| 摘要失败 | 原 transcript + compaction 边界 | 降级保留近期原文 |
| 上下文仍超窗 | usage/估算与 provider 错误 | 重新测量，不能假装成功 |
| pruning 后历史“消失” | 磁盘 transcript | 从 canonical 重建投影 |
| stable prefix 抖动 | cache key/动态后缀 | 把易变字段移到 boundary 后 |
| 大工具结果截断 | spill 引用/truncation marker | 按路径回读原文 |
| bootstrap 变化未察觉 | workspace 文件/版本 | 重建 context，记录来源 |

## 8. 通关自测

1. compaction 与 pruning 的所有者和修改对象分别是什么？
2. 为什么 pruning 后重启仍可能看到完整旧 tool result？
3. compaction 摘要失败为什么不能直接丢掉全部历史？
4. 动态日期为什么不能放在 stable prefix？
5. `keepRecentTokens` 保护的是什么？
6. bootstrap 文件与 transcript 是什么关系？

### 参考答案

1. compaction 属于 harness/agent-core 的历史机制，改写 transcript 视图并生成摘要；pruning 属于 embedded runner 的请求投影，只替换本次 prompt 中的旧 tool result。
2. pruning 的 placeholder 只存在于发送给模型的 messages，磁盘 transcript 没被改写。重启或换请求时可从 canonical 历史重新投影。
3. 丢掉全部历史会让模型失去任务事实和未完成工作。正确降级是保留近期原文、插入明确的“无摘要删除”提示，并让系统知道摘要不完整。
4. 日期每轮变化，会改变整个 prompt 前缀和 cache key，让 provider 前缀缓存失效。它应放在 cache boundary 之后的动态后缀。
5. 它保护近期完整消息和 tool call/result 配对，确保模型仍能理解当前工作，不会因摘要切到半条消息。
6. bootstrap 是从 workspace 文件解析出的上下文投影，不是 transcript。它可以每轮重建，来源和截断事实应可追溯。

## 9. 源码坐标

- `src/agents/system-prompt.ts`
- `src/agents/bootstrap-files.ts`
- `packages/agent-core/src/harness/compaction/compaction.ts`
- `src/agents/sessions/agent-session-compaction.ts`
- `src/agents/embedded-agent-runner/tool-result-truncation.ts`
- `src/agents/embedded-agent-runner/transcript-rewrite.ts`
- `src/agents/embedded-agent-runner/run/session-bootstrap.ts`

## 10. 下一步

进入阶段 4：模型已经看到上下文并决定调用工具。工具由谁装配、谁审批、在哪里隔离执行？
