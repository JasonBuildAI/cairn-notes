---
title: "阶段 9：毕业设计"
description: "阶段 9：毕业设计。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：OpenClaw 源码课 · 阶段卷
> 前置：阶段 0～8
> 对应总览：`engineering.md` 的扩展练习
> 本阶段目标：设计一个能进入 OpenClaw 主链的扩展，并证明它在并发、审批、fallback 与崩溃下仍可解释。

## 1. 本阶段解决什么

前面八阶段分别讲了入口、循环、上下文、工具、模型、transcript 与扩展。真正的检验是：给定一个新需求，能否判断它应当扩展在哪一层，并写出失败边界。

本设计题：**增加一个“代码审查闸门”渠道/工具扩展**。用户在任意渠道提出“审查当前分支”，系统运行只读检查、生成审查报告、在高风险修改前请求 owner 审批，并把结果发回原渠道。

难点不是调用一次模型，而是：

- 审查任务归属于哪个 session；
- 只读工具能否真正隔离；
- 报告生成后怎样落 transcript；
- 高风险动作谁审批；
- 模型/harness 失败能否无损转移；
- 断线或重启后怎样不重复审查/不重复发消息。

## 2. 先记住一个判断

**扩展设计的第一问不是“代码写在哪”，而是“新增了哪种事实，谁拥有它”。**

如果新增了审批、审查结果、渠道回执，就必须给出所有者、幂等键、持久化位置和失败恢复。

## 3. 源码主线：照着一等公民接入

1. Plugin 在 `src/plugins/` 注册 channel/tool/hook，只使用 `openclaw/plugin-sdk/*`。
2. 渠道 ingress 经 `src/auto-reply/` 或 Gateway RPC 归一化，不直接写 transcript。
3. Gateway 用 `sessionKey` 路由、`clientRunId` 幂等、`runId` 标识执行。
4. Agent Loop 只接受装配后的工具；审查工具走统一 policy/approval/sandbox。
5. 只读代码读取使用 workspace authority 与只读 mount；禁止把“工具名里有 read”当隔离。
6. 模型候选/harness 选择走现有 selection 与 fallback 合同。
7. 报告作为 assistant/结构化结果，经 transcript writer 落账。
8. 渠道回执使用稳定 message id/幂等收据；事件通过 Gateway 推送。

## 4. 关键对象与合同

### 新增对象

| 对象 | 所有者 | 幂等/恢复 |
| --- | --- | --- |
| review request | Gateway session/run | `clientRunId` 去重 |
| review tool invocation | agent tool layer | tool call id + runId |
| review report | transcript | writer 提交 |
| approval request | approval owner | approval id，绑定 run/tool call |
| channel delivery | ReplyDispatcher/adapter | message id/回执 |
| risk finding | report schema | 稳定 fingerprint |

### 必须定义的工具边界

- `review.repo_read`：只读、限定 workspace，不可执行仓库代码；
- `review.test`：在 sandbox 中执行，限制网络、挂载与超时；
- `review.comment_post`：外部写操作，必须审批并幂等；
- `review.approve`：owner-only，不能被模型自行调用；
- 任何写文件/推送/合并工具都不应默认出现在只读审查 profile 中。

### 失败分类

| 类型 | 事实 | 处理 |
| --- | --- | --- |
| 准入失败 | 无 run | 返回权限/参数错误 |
| 模型失败 | run 有 typed error | 候选转移或暴露 |
| 工具拒绝 | 成对拒绝 result | 继续或终止，取决于策略 |
| 审批等待 | approval pending | 不把它写成完成 |
| 沙箱超时 | 工具 error result | 保留证据，允许修复 |
| report commit 失败 | 未提交历史 | 不发送“已完成”回复 |
| 回复失败 | transcript 已提交 | 只重发，不重跑审查 |

## 5. 一条可观察链路

```text
用户：审查当前分支
  → channel ingress
  → chat.send / auto-reply dispatch
  → session lane
  → writer fence
  → review tool profile
  → sandbox readonly/test
  → model synthesis
  → report transcript commit
  → high-risk finding? approval
  → ReplyDispatcher
  → 原渠道
```

注意“审查报告已生成”和“报告已送达”是不同事实；前者看 transcript，后者看 reply receipt。

## 6. 实验：必须完成的六项交付物

### A. 扩展定位

写一页说明：为什么做成 plugin channel/tool，而不是新 Agent 或新 Session 系统；列出它复用的 Gateway/runner 合同。

### B. 工具与审批矩阵

为每个工具标出 read/write、scope、是否需要审批、是否允许 sandbox、失败结果格式。验收标准：模型无法通过改名绕过只读限制。

### C. 并发与幂等

用同一 `clientRunId` 重复请求、同 session 并发两次、run 中点击取消。验收标准：最多一份审查 transcript、最多一条外部评论、旧 writer 不再写。

### D. fallback 实验

让主模型失败，候选模型成功；再让显式插件 harness 失败。验收标准：模型 fallback 继续同一 run；未声明无损的 harness 失败 fail closed，不偷偷换运行时。

### E. 崩溃恢复

在 report 已提交但 reply 未发送时中断。验收标准：恢复只补 reply，不重跑审查工具。再在审批 pending 时重启，批准后继续原 run/工具调用。

### F. 测试矩阵

至少覆盖：准入幂等、workspace 越界、审批拒绝、tool pair、transcript 提交、ReplyDispatcher 重发、MCP/plugin 不可用、schema 迁移。

### 实验参考答案

1. 应说明扩展复用 Gateway/runner 合同，而不是新 Agent/Session；并列出它不拥有的状态。
2. 工具矩阵必须给出 read/write、scope、审批、sandbox 和失败格式；改名不能改变权限。
3. 同一 `clientRunId` 最多一份审查 transcript、最多一条外部评论；取消/接管后旧 writer 不再写。
4. 模型 fallback 继续同一 run；显式插件 harness 未声明无损时必须 fail closed。
5. report 已提交、reply 未发送时只补 reply；审批 pending 重启后，批准应继续原 run/工具调用。
6. 测试矩阵至少覆盖准入幂等、workspace 越界、审批拒绝、tool pair、transcript 提交、ReplyDispatcher 重发、MCP/plugin 不可用、schema 迁移。

## 7. 失败与恢复

| 设计漏洞 | 后果 | 修正 |
| --- | --- | --- |
| 用 channel id 当 session | 跨渠道上下文错位 | 用 Gateway sessionKey |
| 审查工具可写仓库 | 只读承诺失效 | workspace authority + 只读 mount |
| 审批在 hook 后 | 参数被改写 | 恢复 approval 顺序 |
| 报告未提交先回复 | 用户看到不存在的结果 | 先 transcript commit，再 ReplyDispatcher |
| 回复失败重跑审查 | 重复模型/工具副作用 | 只重发 reply |
| 失败候选写入 transcript | 历史污染 | 只提交 accepted candidate |
| MCP 目录当可用 | 运行时失败 | 连接健康检查/unavailable |

## 8. 通关自测

1. 为什么“审查当前分支”应复用 Gateway Session/Run，而不是新建系统？
2. 只读工具的安全边界应放在哪几层？
3. 审批为什么必须知道原始 tool call？
4. 报告已提交但回复失败时，正确恢复是什么？
5. 模型 fallback 与 harness fallback 在本设计中分别影响什么？
6. 怎样才能证明扩展没有复制第二套 transcript？

### 参考答案

1. 它仍是一次有 session、run、writer、工具、模型和回复的执行。复用现有合同能获得幂等、并发、审批、transcript 和断线恢复；新建系统会制造第二套事实源。
2. 至少需要工具 profile/policy、approval（若涉及外部写）、workspace authority、只读 mount、env sanitize 和 sandbox lifecycle。工具命名/提示词不能作为安全边界。
3. 否则 hook 或中间层可能修改参数、补造证据，让审批看到不是模型最初提出的调用。审批必须针对原始 call，最终 owner approval 再看 hook 后结果。
4. 读取已提交 report 与 reply receipt，只补投递/事件；不能重跑审查或重新生成报告，否则可能改变结果并重复副作用。
5. 模型 fallback 在同一 harness 内换模型/凭据，继续同一审查 run；harness fallback 可能换整套运行时，若没有无损声明就应 fail closed。
6. 检查所有写操作是否只经 writer/transcript 服务，UI/渠道是否只消费事件，重启后是否从同一 session/branch 读取；再篡改 UI 状态，确认刷新回到 canonical transcript。

## 9. 源码坐标

- `src/plugins/`
- `src/plugin-sdk/`
- `src/auto-reply/dispatch.ts`
- `src/gateway/server-methods/chat-send-handler.ts`
- `packages/agent-core/src/agent-loop.ts`
- `src/agents/agent-tools.before-tool-call.approval.ts`
- `src/agents/sandbox/workspace-authority.ts`
- `src/agents/sessions/agent-session-transcript.ts`
- `src/agents/embedded-agent-runner/run/session-bootstrap.ts`

## 10. 完成标准

最终设计必须能把这七问答清：

```text
消息从哪里进入？
归哪个 session，谁有写权？
模型看到什么上下文？
工具由谁批准、在哪隔离执行？
失败时换模型、换 harness 还是停下？
哪些结果已写进 transcript？
断线/重启后只补哪一步？
```

能答清并跑通至少一个并发、一个审批、一个 fallback、一个崩溃恢复实验，才算学完 OpenClaw。
