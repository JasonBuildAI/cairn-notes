---
title: "阶段 7：插件、渠道、协议与 UI"
description: "阶段 7：插件、渠道、协议与 UI。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：OpenClaw 源码课 · 阶段卷
> 前置：阶段 1～6
> 对应总览：`02-核心机制.md` 的扩展与界面部分
> 本阶段目标：理解 Plugin、MCP、Skills、渠道、Gateway 事件、UI 与子 Agent 各自扩展什么，不扩展什么。

## 1. 本阶段解决什么

OpenClaw 的入口和扩展非常多。如果每接一个渠道、模型或工具就复制一套 Session/Run 逻辑，系统会迅速分裂。本阶段回答：

- 原生 Plugin 和 MCP Server 有什么区别？
- 渠道扩展和 Agent 扩展分别注册什么能力？
- Gateway 的 ACK、事件、快照、seq/stateVersion 怎样支持断线恢复？
- Control UI、WebChat、TUI 为什么不是第二套 Agent？
- Skills 与 subagent 如何影响上下文和执行，而不改变 Session 所有权？
- MCP 失联时，工具目录和执行可用性为什么不是一回事？

## 2. 先记住一个判断

**扩展只能增加能力或入口，不能新增一套事实源。**

Provider/channel/tool/hook 可以注册，MCP 可以增加外部工具，Skill 可以增加工作方法，subagent 可以开子会话；但 Session/Run、writer、approval、transcript 的边界仍由 Gateway/runner 拥有。

## 3. 源码主线

1. `src/plugins/` 注册 provider、channel、tool、hook 等原生 capability，并通过 `openclaw/plugin-sdk/*` 暴露受控 API。
2. `src/mcp/` 与 `agent-bundle-mcp-runtime.ts` 管理外部 MCP server、工具目录、连接、退避与恢复。
3. `src/skills/` 解析技能文档与资源，把“怎么做”注入 agent 上下文。
4. `src/agents/subagents/` 创建 child session，拥有独立 writer/run 生命周期与 announce。
5. `src/gateway/server-methods/` 暴露 chat、session、approval、agent 等 RPC；事件带 `seq`，快照带 `stateVersion`。
6. `ui/src/`、`src/tui/` 消费 Gateway/runner 合同；渠道适配器只负责 ingress/egress 与 ReplyDispatcher。
7. `src/auto-reply/` 保持渠道回复节奏，不直接改 transcript。

## 4. 关键对象与合同

| 扩展 | 增加什么 | 不拥有什么 |
| --- | --- | --- |
| Plugin provider | 模型/provider 适配 | Session 路由与 writer |
| Plugin channel | 入站/出站渠道 | transcript 事实 |
| Plugin tool | 新工具执行 | 无审批的副作用 |
| Plugin hook | 扩展观察/调整 | 替代最终 approval owner |
| MCP server | 外部工具协议 | Gateway 会话路由 |
| Skill | 工作方法/资源 | 权限与副作用事实 |
| Subagent | 独立 child session | 父 session 的写权 |
| UI/TUI | 消费状态与调用 RPC | 第二套 history |

### 渠道与会话

一个 Telegram 群、一个 WebChat 页面、一个 TUI 都可以映射到 sessionKey；但 channel 本身不是 session。群聊还有默认隔离、线程路由与回复目标，不能由 Agent 自己猜。

### Gateway 事件恢复

- `seq` 保证增量事件顺序，跳号意味着客户端漏事件，需要重同步；
- `stateVersion` 保证快照新旧，旧快照不能覆盖新状态；
- ACK 表示接纳，终态要由事件/快照确认；
- 断线重连先补事件/快照，不重新执行 run。

### MCP 目录与执行

server 失联后，之前发现的工具目录可以保留用于展示/提示，但真正调用需要活连接。工具会出现但返回 unavailable，并按退避重连；不能把“目录还在”当“执行可用”。

## 5. 一条可观察链路

```text
渠道 / UI / plugin channel
  → Gateway RPC / normalized ingress
  → sessionKey/sessionId
  → run admission
  → agent loop
  → tool registry（plugin/MCP/skill）
  → approval/policy
  → transcript
  → events(seq) / snapshot(stateVersion)
  → ReplyDispatcher / UI
```

## 6. 实验

### 实验 A：Plugin 与 MCP 对比

分别追踪一个 plugin tool 和一个 MCP tool。参考验收：plugin 走进程内 capability 注册；MCP 走外部协议与连接生命周期；两者最终都穿过同一 policy/approval。

### 实验 B：MCP 失联

断掉 MCP server。参考验收：工具目录仍可读，执行返回 unavailable；退避重连，不把目录存在当健康。

### 实验 C：子 Agent

启动一个 subagent。参考验收：child session key 独立，拥有自己的 writer/run；父 run 结束不等于 child 自动结束。

### 实验 D：事件缺口

模拟客户端漏掉一个 `seq`。参考验收：客户端检测跳号并重同步，不用旧快照覆盖新状态。

### 实验参考答案

1. plugin tool 走进程内注册，MCP 走外部协议/连接；两者最终都穿过同一 policy 与 approval。
2. MCP 失联时目录仍可读但执行 unavailable，系统退避重连；目录存在不等于健康。
3. subagent 使用独立 child session/writer/run；父 run 结束不自动结束 child。
4. 客户端发现 `seq` 跳号应重同步；旧 `stateVersion` 快照不能覆盖新状态。

## 7. 失败与恢复

| 失败 | 根因 | 恢复 |
| --- | --- | --- |
| 渠道重复入站 | 缺幂等 ingress | 用事件/消息 id 去重 |
| UI 与 Gateway 不一致 | 旧快照/漏事件 | 按 seq/stateVersion 重同步 |
| Plugin 绕过审批 | 注册了执行入口 | 统一走 tool policy |
| Skill 被当权限 | 只注入了文档 | 权限仍由 tool/approval 决定 |
| Subagent 写父历史 | child/父 session 混淆 | 绑定 child session key |
| MCP 工具“可见不可用” | 连接失联 | 返回 unavailable 并退避 |

## 8. 通关自测

1. Plugin 与 MCP Server 的区别是什么？
2. Channel 与 Session 为什么不能等同？
3. `seq` 与 `stateVersion` 分别解决什么？
4. Skill 为什么不能替代权限系统？
5. 父 run 结束会怎样影响 subagent？
6. MCP 目录存在为什么不能证明工具可执行？

### 参考答案

1. Plugin 是进程内原生扩展，可注册 provider/channel/tool/hook；MCP 是外部工具协议，拥有独立连接/进程生命周期。两者最终都受统一工具策略与审批。
2. Channel 是消息来源/回复出口，Session 是 Gateway 拥有的长期上下文身份。一个 session 可跨渠道延续，群聊/线程又有独立路由；混同会导致上下文错位或回复发错地方。
3. `seq` 保证增量事件顺序并检测缺口；`stateVersion` 保证快照新旧，防止旧快照覆盖新状态。前者是流顺序，后者是快照一致性。
4. Skill 只是注入工作方法/资源，不能表达某次调用的权限、审批和副作用边界。越权工具仍必须被 policy/approval/sandbox 拒绝。
5. Child 是独立 session/run，有自己的 writer、lane 和生命周期。父 run 结束不必然终止 child；需要显式取消/回收或由 child 自己完成。
6. 目录只是发现结果，执行需要活的 MCP 连接、健康 server 和可用工具。连接失联时仍可能展示目录，但调用会失败。

## 9. 源码坐标

- `src/plugins/`
- `src/plugin-sdk/`
- `src/mcp/`
- `src/agents/agent-bundle-mcp-runtime.ts`
- `src/skills/`
- `src/agents/subagents/`
- `src/gateway/server-methods/`
- `src/auto-reply/`
- `ui/src/`
- `src/tui/`

## 10. 下一步

进入阶段 8：这些边界靠哪些检查、测试、迁移与运维手段保证？出故障时按什么顺序定位？
