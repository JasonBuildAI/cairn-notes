---
title: "02 · 核心机制"
description: "梳理上下文、工具、Sandbox、模型适配、扩展与持久化的核心机制。"
---

> 基线：DeerFlow `v2.1.0`（`345f08be`）。路径相对 `backend/`。
> 本篇回答七个问题：上下文怎么来、工具怎么做、动作在哪执行、模型怎么接、能力怎么扩展、子 Agent 怎么协作、工程上靠什么不崩。

## 1. 先看机制全景

```text
                    ┌──────── 上下文 ────────┐
                    │ ThreadState.messages   │
                    │ summary / memory       │
                    │ checkpoint / journal   │
                    └───────────┬────────────┘
                                │
Model ◄── prompt/tools ◄── Middleware chain ──► Tool calls
  │                             │                   │
  │ reasoning / tokens          │ policy            ├─ built-in
  └─────────────────────────────┘                   ├─ sandbox
                                                    ├─ MCP
                                                    ├─ skills
                                                    └─ subagent
                                                          │
                                              Sandbox / remote services
```

七块之间不是并列模块，而是三个闭环：

- **推理闭环**：模型 → tool call → observation → 模型；
- **上下文闭环**：消息增长 → 压缩/预算 → checkpoint → 下一轮；
- **能力闭环**：工具授权 → 执行 → 结果摘要/错误分类 → 审计与回放。

## 2. 上下文：模型看到的不是“整段聊天记录”

### 2.1 权威状态在 `ThreadState`

`agents/thread_state.py` 的 `ThreadState` 继承 LangGraph `AgentState`，核心字段是 `messages`，另有 `summary_text` 等修补信息。

模型每轮看到的是从 thread 状态投影出来的消息视图，不是数据库原始行。投影过程可能经过：

```text
checkpoint 恢复
  → 应用消息 reducer / 去重
  → 注入 uploads、date、project 等上下文
  → 摘要/压缩旧消息
  → 预算裁剪工具输出
  → 转成 provider messages
```

### 2.2 checkpoint 有两种通道模式

`runtime/checkpoint_mode.py` 明确定义：

- `full`：每步保存完整 channel values；
- `delta`：使用 LangGraph `DeltaChannel`，保存 sentinel + 每步写入，并按频率做快照。

模式是进程级冻结配置，运行中不能切换。`delta` 能降低重复快照成本，但 full 进程读 delta 线程会 fail closed，必须先迁移。这说明 checkpoint 格式也是工程契约，不是内部实现细节。

### 2.3 压缩与记忆是两条不同通路

| 机制 | 作用范围 | 触发方式 | 典型实现 |
| --- | --- | --- | --- |
| summarization | 当前对话窗口 | 自动阈值 / `/compact` | `SummarizationMiddleware` |
| tool output budget | 单次工具结果 | 结果过长时摘要/截断 | `tool_output_budget_middleware` |
| memory | 跨会话事实/偏好 | 检索或定期更新 | `agents/memory/` |
| checkpoint | 单 thread 执行状态 | 每步/按频率 | LangGraph checkpointer |

一句话：**压缩解决“这一轮塞不下”，memory 解决“下一轮还记不记得”，checkpoint 解决“进程重启后从哪继续”。**

### 2.4 为什么要 Tool Output Budget

工具输出是最容易失控的上下文来源：一个日志文件、一张大表、一次 API 返回都可能挤爆窗口。预算中间件会在结果进入模型前做摘要/裁剪，同时保留可回查的路径或 receipt。这样模型拿到的是“足够决策的摘要”，不是“全量文本”。

## 3. 工具：三层过滤 + 两类执行边界

### 3.1 工具从“存在”到“可调用”要过三层

```text
get_available_tools()        系统里有哪些候选
  → apply_tool_authorization() 当前用户/上下文允许哪些
  → assemble_deferred_tools()  本轮暴露哪些，或延迟发现
```

`assemble_deferred_tools` 与 tool search 解决工具爆炸：模型先看到少量核心工具和搜索入口，需要时再发现 MCP/扩展工具。MCP routing middleware 还会根据查询做提示与自动提升。

### 3.2 工具的类型

| 类型 | 例子 | 执行位置 | 关键风险 |
| --- | --- | --- | --- |
| built-in | `read_conversation`、todo、present_files | Gateway 进程内 | 访问服务端数据 |
| sandbox | `bash`、`ls`、`read_file`、`write_file`、`str_replace` | sandbox provider | 命令执行、文件越界 |
| MCP | 外部 server 暴露的 tools | 远程 MCP server | 网络、凭据、协议 |
| skill | 读取/管理技能包 | 文件系统/存储层 | 路径、内容审查 |
| subagent | `task`、batch task | 同一 Run 的受控子执行 | 并发、预算、递归 |

### 3.3 工具结果也有“协议”

DeerFlow 不是把工具返回值原样丢回模型。中间件会：

- 标注错误类型（rate limit、transient、permission 等）；
- 给出 `recoverable_by_model` 和 `recommended_next_action`；
- 把大结果转成 synopsis；
- 为文件/引用生成 receipt；
- 对悬空 tool call 做清理。

这让模型得到的是结构化 observation，而不是一段含义不明的字符串。工程上，**工具错误分类是 Agent 可靠性的核心，不是附属功能。**

## 4. Sandbox：工具接口与执行边界必须分开

### 4.1 虚拟路径契约

沙箱内使用固定虚拟路径：

```text
/mnt/user-data/workspace   临时工作区
/mnt/user-data/uploads     上传文件
/mnt/user-data/outputs     最终交付物
/mnt/skills                技能目录（通常只读）
/mnt/acp-workspace         外部 ACP agent 工作区
```

工具只接受这些逻辑路径，provider 负责把它们映射到真实宿主机/容器路径。`sandbox/tools.py` 会做边界检查，`local_sandbox_provider.py` 负责 per-thread 映射。

这带来的好处：

- prompt 与工具契约稳定，不随部署路径变化；
- 路径穿越检查有统一点；
- 本地模式与容器模式共享同一套工具 API。

### 4.2 Provider 与 Lease

`SandboxProvider` 管理 sandbox 的获取、查找、释放；`SandboxLeaseManager` 管理同一 sandbox 的活跃使用者与释放时机。

为什么需要 lease？因为中间件可能保留 sandbox id，工具调用可能异步结束，Run 取消也可能发生在获取之后。lease 把“谁还在用”变成可计数事实，避免一个使用者结束时把另一个还在执行的 sandbox 释放掉。

### 4.3 三条信任线

```text
模型输出 ──不可信──► 工具参数 ──必须校验──► sandbox 操作
客户端输入 ─不可信──► RunContext ──白名单──► runtime
外部 MCP ──不可信──► tool result ──分类/摘要──► model context
```

Sandbox 不是“让模型随便跑”的借口。它把高风险动作关进一个可控环境，但工具层仍要检查路径、权限、参数和输出。

## 5. 模型接入：一条工厂，多个适配器

`models/factory.py::create_chat_model()` 是唯一的模型构造入口。流程：

```text
读取 model profile
  → resolve provider class
  → 合并 per-agent overrides
  → 处理 thinking / reasoning_effort
  → 过滤 provider 不认识的字段
  → 附加 tracing（按调用点决定）
  → 构造 BaseChatModel
```

关键设计：

- **白名单在接单层，构造在工厂层**：先允许，再实例化；
- **模型 profile 是数据**：provider class、context window、pricing、thinking 能力都由配置表达；
- **provider 适配器吸收差异**：OpenAI-compatible、Codex、其他 provider 的字段差异不污染 Agent；
- **tracing 只在根部挂一次**：Lead Agent 传 `attach_tracing=False`，避免 graph 与 model 双 span。

## 6. 扩展：四种“长能力”的方式

| 扩展面 | 解决什么 | 入口 |
| --- | --- | --- |
| Skills | 把方法、模板、脚本打包给 Agent 按需使用 | `skills/`、skill tools |
| MCP | 接外部工具/资源/提示 | `mcp/` |
| Extensions | 在 Agent 构建/运行期注入 middleware、tool、事件 | `extensions/`、`deerflow_extension_api` |
| Channels | 把 IM/Webhook 输入接入 Run，把结果发回去 | `app/channels/` |

### 6.1 Skills 不是工具

Skill 更像“可加载的操作手册 + 资源包”。模型先发现 skill，再读取 `SKILL.md` 或调用其脚本。它扩展的是知识和流程，工具扩展的是动作。

### 6.2 MCP 有同步工具，也有长任务

普通 MCP tool 一次调用返回结果；DeerFlow 另有 MCP task 体系，把远程长任务持久化，支持通知、回写和恢复。`app/mcp_tasks/` 是 app 侧任务通知层，`deerflow/mcp/tasks/` 是协议中立的任务模型。

### 6.3 Extensions 的注入有顺序约束

扩展 middleware 不能简单 append，因为中间件顺序决定 before/after model 的语义。`extensions/stack.py` 会用 anchor、`@Next`/`@Prev`、placement 做组合并校验顺序。扩展作者必须声明“相对谁”，而不是假设自己的位置。

### 6.4 Channel 也走同一 Run 主线

Discord、Slack、Feishu、Telegram 等渠道接收消息后，不是自己实现一套 Agent，而是构造 `RunCreateRequest`，最终进入 `start_run()`。渠道层负责身份映射、去重、回复路由和媒体处理；执行仍归 Run 系统。

## 7. 多 Agent：同一 Run 下的受控并发

DeerFlow 的原生子 Agent 通过 `task_tool` / `SubagentRuntime` 执行：

```text
Lead Agent
  → task(description, subagent_type)
    → SubagentRuntime 分配容量
      → SubagentExecutor 建子 graph
        → 子 graph 使用独立事件命名空间
          → 结果作为 ToolMessage 回到 Lead
```

### 7.1 三个限制

- `SubagentLimitMiddleware` 限制单次响应中的并发 task call；
- Run 级 `max_total` 限制总委派次数；
- `SubagentExecutionCapacity` 管理跨 Run 的实际执行容量。

如果模型一次生成 20 个并行子任务，中间件只保留允许数量，其余调用被移除并记录原因。模型不能通过“多写几个 tool call”绕过预算。

### 7.2 子 Agent 共享什么，不共享什么

共享：

- 同一个 Run 的预算、日志、事件总线和最终交付；
- 父级的 sandbox / 项目上下文（按策略）；
- 受控的结果回传通道。

不共享：

- 直接写父级 messages 的权限；
- 任意递归生成无限子 Agent 的权限；
- 独立的用户身份或跨用户数据访问权。

### 7.3 为什么 batch 是单独模式

大量独立小任务适合显式 batch：可持久化提交、查询状态、取消。它与模型在一轮里写多个 `task` 调用不同，batch 把“批量”变成服务端可管理的任务集合，而不是靠 prompt 约束并发。

## 8. 持久化：三种存储解决三种问题

| 存储 | 内容 | 一致性重点 |
| --- | --- | --- |
| checkpoint | LangGraph 状态、消息、分支 | 可恢复、模式兼容、租约围栏 |
| RunStore | RunRecord、状态、token、幂等键 | 原子准入、状态条件更新、跨 worker |
| event store / journal | 过程事件、消息流、交付 receipt | 顺序、去重、可回放、前端一致 |

### 8.1 为什么不合并成一个库表

因为它们的变化频率、查询模式和生命周期不同：

- checkpoint 每一步都可能写，且与 LangGraph 格式强绑定；
- RunStore 是控制面，需要条件更新和租约；
- event store 是追加型日志，需要按 thread/run 分页和 seq。

合并会让格式迁移、清理策略和故障域耦合。分开则要接受“多存储一致性”成本，并用 receipt、seq、idempotent write 处理。

### 8.2 Journal 与 Event Store 的关系

`RunJournal` 是运行期事件生产者；`RunEventStore` 是持久化接口。Job 结束时先 flush journal，再写 delivery receipt，最后落终态。这个顺序保证“终态可见时，过程与交付已经基本可查”。

## 9. 生产可靠性：五个围栏

1. **准入围栏**：原子 create + 幂等键，防重复工单；
2. **开工围栏**：pending→running barrier，防取消后仍构造 Agent；
3. **所有权围栏**：lease + `ownership_lost`，防僵尸 worker 覆盖；
4. **交付围栏**：outputs 扫描 + receipt，防“口头成功”；
5. **依赖围栏**：`app → deerflow` 单向依赖测试，防内核被产品细节污染。

这五条不是可选优化，而是 DeerFlow 与“demo agent”的主要差距。

## 10. 设计取舍

| 取舍 | 选择 | 代价 |
| --- | --- | --- |
| 强控制面 vs 简单调用 | 先建 Run 再执行 | 多一层状态与存储 |
| 进程内 SSE vs 消息队列 | StreamBridge 绑 owner | 跨 worker 需 join/读历史 |
| 统一工具契约 vs 原生能力 | 虚拟路径 + provider | provider 实现更复杂 |
| 延迟工具发现 vs 全量暴露 | tool search | 多一次发现步骤 |
| 子 Agent 受控并发 vs 自由递归 | 中间件 + capacity | 复杂任务可能被限流 |
| 分离存储 vs 单库 | checkpoint/Run/event 分开 | 跨存储一致性处理 |

## 11. 常见误区

| 误区 | 正确理解 |
| --- | --- |
| `messages` 就是完整历史 | 它可能被压缩、投影、预算裁剪 |
| Skill 是另一种 tool | Skill 是知识与流程包，通常通过工具读取/执行 |
| Sandbox 自动保证安全 | 它提供隔离，但路径/权限/参数仍需工具层校验 |
| Subagent 是独立产品实例 | 它在同一 Run 控制面下，受预算和容量限制 |
| checkpoint 可以替代 event store | 一个恢复状态，一个记录过程与交付 |
| 工具越多模型越强 | 工具面过大会增加 token 成本和误选，需要授权与延迟发现 |

## 12. 自测题

1. `ThreadState.messages`、checkpoint、memory 三者的边界是什么？
2. 为什么工具要经过“可用 → 授权 → 已装配”三层？
3. sandbox 虚拟路径解决了哪些工程问题？provider 又负责什么？
4. 子 Agent 为什么不能绕过 `SubagentLimitMiddleware`？
5. RunStore、checkpoint、event store 分别最适合回答什么问题？
6. 如果 MCP server 返回一个巨大 JSON，系统有哪几道保护？
7. 为什么扩展 middleware 需要 anchor/顺序校验？

### 参考答案

1. `ThreadState.messages` 是当前图中交给模型的消息状态/投影；checkpoint 是这份图状态的持久化恢复点；memory 是跨会话检索的长期事实与偏好。当前窗口、可恢复执行状态、跨会话记忆是三种不同生命周期。
2. “可用”回答系统里是否存在候选；“授权”回答当前用户、项目和上下文是否允许使用；“已装配”回答本轮是否真的暴露给模型。分开后，既不会把未授权工具塞进 prompt，也能用 deferred/tool search 控制工具目录规模。
3. 虚拟路径把工具契约定在 `/mnt/user-data/...` 等稳定命名空间，统一做路径穿越与越界检查，并让本地/容器 provider 共享同一工具 API；provider 负责把这些逻辑路径映射到真实执行环境、获取/释放 sandbox，并由租约管理并发使用者。
4. 因为限制发生在 Agent 图的中间件/工具执行层，不是 prompt 建议。模型即使生成 20 个 `task` 调用，`SubagentLimitMiddleware` 仍会在执行前裁掉超额调用，Run 级 `max_total` 和容量管理器再限制总量与真实并发；模型输出不能绕过服务端围栏。
5. **RunStore** 回答“这次 Run 是否被接单、状态/owner/幂等键是什么”；**checkpoint** 回答“图执行到哪、如何恢复”；**event store/journal** 回答“过程中发生了什么、如何回放/审计、交付凭据是什么”。
6. 至少经过：MCP 结果归一化与错误分类 → 大小/协议限制 → tool output budget 的摘要或截断 → receipt/可回查引用 → 最终上下文预算。不能把巨大 JSON 原样塞回模型；必要时只返回 synopsis 和读取路径。
7. 因为 middleware 的 before/after 语义由相对顺序决定。扩展如果随意 append，可能跑到鉴权、工具错误处理、澄清、摘要或子 Agent 限制之前/之后，改变安全边界和缓存行为；anchor、`@Next`/`@Prev` 与 placement 校验让组合确定、可检测冲突并在非法拓扑上 fail closed。

## 13. 代码地图

```text
agents/thread_state.py                          ThreadState / delta schema
agents/middlewares/summarization_middleware.py  摘要与压缩
agents/middlewares/tool_output_budget_middleware.py
                                                工具输出预算
agents/middlewares/subagent_limit_middleware.py 子 Agent 并发/总量
tools/tools.py                                  工具目录与装配
tools/builtins/                                 内置工具
sandbox/sandbox_provider.py                     provider 接口
sandbox/tools.py                                虚拟路径与工具实现
sandbox/lease.py                                sandbox 使用者租约
models/factory.py                               create_chat_model
mcp/                                             MCP 客户端与长任务
skills/                                          技能包与审查
extensions/                                      扩展注入与排序
subagents/                                       runtime/executor/batch/capacity
runtime/journal.py                               过程事件与交付事实
runtime/checkpoint_mode.py                       full/delta checkpoint
app/channels/                                    IM 渠道接入
```

下一篇从“读懂”切到“会改”：如何定位一次故障、做源码实验、评估改动风险，并给出毕业练习。
