---
title: "OpenClaw 2026.10.9 源码课 · 导读"
description: "OpenClaw 2026.10.9 源码课导读：Gateway、Session/Run、七块职责与学习完成标准。"
---

:::note[独立学习笔记]
这是基于 [OpenClaw](https://github.com/openclaw/openclaw) 版本 2026.10.9 发布归档源码与公开文档整理的独立学习笔记，不是官方文档。本站不包含上游源码或归档；下文以 $OPENCLAW_SRC 表示你自己的本地源码目录。
:::

> 基线：发布归档 `openclaw-2026.10.9`，`package.json` 版本为 `2026.10.9`。
> 归档不含 `.git`，因此本文以发布包版本、源码符号和目录为基线，不虚构 commit/tag。
> 运行环境：Node `>=24.22.1 <25 || >=26.12.1`，包管理器 `pnpm@12.15.0`。
> 本文所有路径都相对 `$OPENCLAW_SRC`。

## 一句话理解 OpenClaw

**OpenClaw 是一个以长期运行的 Gateway 为中心的个人 Agent 运行时：它把 WhatsApp、Telegram、Slack、Discord、Signal、iMessage、WebChat、TUI、Node 设备等入口收束到同一个 Session/Run 体系，再通过可替换的 Agent Harness 调用模型、执行工具、做审批、写回 transcript，并把结果送回原来的渠道。**

可以把它想成一座“常驻调度中心”，而不是一个聊天窗口：

```text
渠道消息 / WebChat / TUI / 移动端 / Node
                 │
                 ▼
        Gateway（鉴权、会话路由、幂等、事件）
                 │
                 ▼
     Session / Run admission（串行、排队、接管）
                 │
                 ▼
       Agent Harness（内建 / 插件 / CLI）
                 │
       ┌─────────┼──────────┐
       ▼         ▼          ▼
     Model     Tools     Context
       │         │          │
       └──── transcript / events / approvals
                 │
                 ▼
          Reply Dispatcher
                 │
                 ▼
        原渠道 / UI / 调用方
```

## 七块总表

| 部件 | 要回答的问题 | OpenClaw 的答案 | 主要源码 |
| --- | --- | --- | --- |
| 循环 | 一次 Agent Turn 怎样推进、何时续跑或停？ | `runAgentLoop()` 内的模型流、工具批次、steering checkpoint 和 `prepareNextTurn()` | `packages/agent-core/src/agent-loop.ts` |
| 上下文 | 每次给模型看什么，怎样压缩/清理？ | system prompt + workspace bootstrap + transcript；compaction 改写历史，cache-TTL pruning 只改 prompt 投影 | `src/agents/system-prompt.ts`、`src/agents/bootstrap-files.ts`、`.../compaction/compaction.ts` |
| 工具 | 模型能做什么，谁批准，在哪里执行？ | 按 capability/policy 装配工具；`before_tool_call` 顺序执行 loop admission、可信策略、审批、hook；sandbox backend 承担隔离执行 | `src/agents/agent-tools.ts`、`src/agents/agent-tools.before-tool-call.policy.ts`、`src/agents/sandbox/` |
| 模型接入 | 多 provider、auth、fallback、harness 怎样统一？ | 逻辑 model ref → 静态/动态模型解析 → auth profile → harness 选择 → 失败按 rotate/fallback/surface 决策 | `src/agents/embedded-agent-runner/model.ts`、`src/agents/harness/selection.ts` |
| 扩展 | 新渠道、provider、工具、技能怎样接入？ | 原生 Plugin capability + hook + MCP + Skills + subagent；插件只使用 `openclaw/plugin-sdk/*` | `src/plugins/`、`src/mcp/`、`src/skills/`、`src/agents/subagents/` |
| 界面 | 人、脚本、渠道、设备怎样共用同一引擎？ | Gateway HTTP/WS、Control UI/WebChat、TUI、CLI、移动端、Node 都走同一 Session/Run 合同 | `src/gateway/`、`ui/src/`、`src/tui/`、`src/cli/` |
| 工程 | 为什么改动不会把系统弄坏？ | schema/contract、设备配对、writer fence、幂等、架构检查、类型检查、跨平台测试 | `scripts/check.mts`、`src/state/`、`src/gateway/`、`package.json` |

三条纵线贯穿每一块：

1. **入口归一**：渠道不同，但最终都进入同一套 `SessionKey / Agent / Run / ReplyDispatcher` 语义。
2. **所有权唯一**：Gateway 拥有会话与路由；session writer 拥有 transcript；plugin capability owner 拥有 vendor 适配；Approval owner 拥有放行。
3. **可恢复执行**：runId、幂等键、writer fence、terminal outcome 和 transcript 让“重复请求、并发接管、重启恢复”都有明确边界。

## 阅读顺序

| 顺序 | 文档 | 你会得到什么 |
| --- | --- | --- |
| 0 | [全局地图](overview/) | 产品定位、进程拓扑、核心对象、目录职责、信任边界 |
| 1 | [一条消息的一生](message-lifecycle/) | 从渠道/`chat.send` 到 Agent Loop、工具、transcript 和回复的完整主线 |
| 2 | [核心机制](core-mechanisms/) | 循环、上下文、工具审批、模型/harness、插件/MCP/Skills、Gateway 协议 |
| 3 | [工程实战](engineering/) | 调试路径、源码实验、失败矩阵、扩展练习和工程关卡 |

## 阶段课（源码深入）

总览之后，按 [阶段导读](learning-path/) 从阶段 0 走到阶段 9。`00`～`03` 负责建立全局与机制直觉；阶段卷沿真实源码拆开 ownership、状态迁移、失败恢复和可观察实验，每篇自测与练习均附参考答案。

## 推荐读法

- **第一遍只抓一条线**：`dispatchInboundMessage` 或 `chat.send` → `agentCommandFromIngress` → `runEmbeddedAgent` → `runAgentLoop` → reply。
- **第二遍追问所有权**：这条消息归哪个 session？谁有资格写 transcript？谁批准工具？失败后哪个 receipt 能证明做到哪一步？
- **第三遍做实验**：让同一 session 并发两次、观察排队；让 provider 先失败再 fallback；让一个工具等待审批；对比 compaction 与 pruning 的 transcript 差异。

## 最容易混淆的五件事

1. **Gateway 不是 Agent**：Gateway 负责鉴权、会话、路由、RPC、事件和生命周期；真正调用模型与工具的是 Agent Harness。
2. **Channel 不是 Session**：Channel 是消息来源/回复出口；Session 是 Gateway 拥有的长期上下文身份。一个 session 可以跨渠道延续，群聊又默认隔离。
3. **Compaction 不是 Pruning**：Compaction 会生成摘要并改写 transcript 视图；cache-TTL pruning 只清旧 `toolResult` 的 prompt 投影，不重写原始历史。
4. **Plugin 不是 MCP Server**：Plugin 是进程内原生扩展，可注册 provider/channel/tool/hook；MCP 是外部工具协议，MCP 工具仍要穿过同一套 tool policy 与审批。
5. **发送成功不等于 Turn 完成**：`chat.send` 返回 `in_flight` 只表示已接纳；终态、transcript commit、回复投递和 writer 交接是后续不同事实。

## 学习完成标准

读完后应能不看文档回答：

- 一条 Telegram 消息和一条 Control UI `chat.send` 在哪里汇合？为什么二者共享同一套 Agent 执行器？
- 同一 session 的两个并发请求怎样串行？后一个 writer 接管时，前一个为什么不能继续写？
- `steer`、`followup`、`collect`、`interrupt` 分别改变什么，不改变什么？
- 为什么模型 fallback 不等于 harness fallback？`auto` 怎样选择内建与插件 harness？
- 为什么工具审批顺序不能随便换？`deny`、`defer`、`report`、`request` 的区别是什么？
- 一次自动 compaction 与一次 cache-TTL pruning 分别修改什么、保留什么？

### 学习完成标准参考答案

1. **两条入口在统一 agent command / embedded runner 汇合，随后进入同一个 `runAgentLoop()`。** Telegram 走 `dispatchInboundMessage → finalizeInboundContext → dispatchReplyFromConfig`；Control UI 走 `chat.send → 准入/ACK → detached dispatch`。二者共享 Session/Run、模型与工具策略、审批、writer fence、transcript 和回复投递，所以必须共享执行器；渠道层只负责入站归一化和 `ReplyDispatcher` 出站。
2. **同一 session 先由 session lane 串行，再由 writer fence 决定 transcript 写权。** 新 run 用 CAS 比较 `sessionId` 后写入 `activeWriterRunId`；发现旧 writer 就把它显式标成 `superseded`。旧 run 不能继续写，因为它的写权已被撤销；若静默忽略，旧进程仍可能追加交错历史或重复副作用，也无法审计谁拥有最终状态。
3. **`steer`** 在安全边界把消息注入当前 run，运行中的工具会完成；串行尾部中尚未启动的调用可生成配对的 skipped/error 结果，已进入执行边界的并行批次不会因 steering 被跳过，且不创建第二个 run；**`followup`** 不打断当前 run，把消息排到它结束后的下一 turn；**`collect`** 在 quiet window 后把路由、授权和执行设置兼容的多条消息合并成一个 followup turn，不改变当前 run，durable ingress 渠道可能仍保持独立 turn；**`interrupt`** 取消该 session 的活跃 run，再运行最新消息，且不会通过 Gateway 重启恢复旧 turn。四者改变排队/注入时机，不改变 Session 所有权或已提交的历史事实。
4. **模型 fallback 仍在同一个 harness 内换模型/凭据/路由；harness fallback 换的是执行运行时。** 前者保持工具循环与会话协议，后者可能改变 steering、session 映射、工具策略和运行时能力。`auto` 会枚举已注册的插件 harness，按 provider/model、tool policy 等支持条件过滤，再选优先级最高者（同优先级按 id）；没有可用插件 harness 时回到内建 OpenClaw。显式指定插件 runtime 时默认 fail closed，除非插件声明 OpenClaw 是无损 fallback。
5. **顺序是 loop admission → owner probes → voice confirmation → trusted policies → approvals → normal hooks → final owner approval。** 审批必须在普通 hook 前，否则 hook 可以先改工具参数或补造证据，再让审批看到“洗过”的调用；最终 owner approval 还要在 hook 之后独立放行。**`deny`** 直接拒绝；**`defer`** 推迟到执行边界再决定；**`report`** 只报告、不阻塞；**`request`** 立即请求人工审批；非交互 surface 可以直接 deny。
6. **compaction 改写历史/transcript 视图**：把较早内容总结成摘要并保留近期尾部，属于 harness/`packages/agent-core`；失败时也不能丢掉近期原文。**cache-TTL pruning 只改本次 prompt 投影**：把过期 tool result 替换成占位内容，磁盘 transcript 不变，重启后可从原文重建，属于 embedded-agent runner 的 truncation 层。前者改变“账本视图”，后者只改变“这次给模型看什么”。

---

*基于 OpenClaw 2026.10.9 发布源码编写 · 2026-10-31*
