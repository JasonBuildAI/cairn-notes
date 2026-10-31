---
title: "00 · 全局地图：LoopX 到底在解决什么问题"
description: "建立 LoopX 长程控制面的全局地图，辨清事实、投影和执行责任。"
---

> 基线：LoopX `v2.1.1`（`87e5b4f8`）。源码根目录在本笔记中记为 `$LOOPX_SRC`。

## 1. 先从一个失败场景开始

假设一个 Agent 要连续几天维护一个项目：修 PR、跑 CI、看评审、必要时问人、再生成后继任务。

如果只靠聊天记录，会发生这些事：

- 上下文被压缩后，“验收标准”还在不在，没人能保证；
- 两个 Agent 同时看到同一条待办，重复执行外部写操作；
- CI 结果还没回来，定时器就不断唤醒模型，消耗配额；
- Agent 说“已经发了 PR”，但没有外部 readback，事实并未被证明；
- 写回成功、配额扣除前进程崩溃，重启后不知道哪些副作用已经发生；
- 人修改了优先级，聊天里说过了，但系统状态里没有绑定到正确 Goal。

LoopX 的判断是：**模型上下文只是工作内存，不是长期状态。** 长程任务需要一套独立于模型、独立于单次 session 的控制面。

这不是“让模型记得更多”，而是把下一轮做正确决定所需的事实外置：

| 必须跨轮延续的问题 | LoopX 的外置形态 |
| --- | --- |
| 目标是什么，什么算完成？ | Goal、vision/acceptance、boundary |
| 现在有哪些工作？ | Todo、frontier、continuation |
| 谁在做，谁可以做？ | identity、claim、lease、scope |
| 哪些动作被允许？ | authority、gate、capability、workspace guard |
| 发生了什么，能否相信？ | evidence、effect readback、receipt |
| 何时再运行，何时停？ | monitor、scheduler hint、quota、terminal audit |
| 崩溃或换人后从哪继续？ | journal、run history、replay、recovery |

因此，LoopX 的产品问题不是“再做一个更强的 Agent”，而是：**怎样让同一个长期目标在多个 session、多个 Agent、多次失败后仍然连续、可审计、可恢复。**

## 2. 定位边界：它做什么，明确不做什么

| 层 | 谁负责 | LoopX 是否负责 |
| --- | --- | --- |
| 模型推理与工具循环 | Codex、Claude Code 等 Host | 否 |
| 工具协议、沙箱、审批 | Host / 具体工具运行时 | 否 |
| 领域规则与外部系统调用 | Capability + Provider | 只定义合同与准入 |
| 长期目标、Todo、claim、gate、quota、writeback、恢复 | LoopX Kernel | 是 |
| 看板、状态页、聊天展示 | projection / UI | 是读模型，不是事实源 |

源码把运行时责任拆成四类（`docs/architecture.md` 的 Runtime Responsibility Model，并对应 `CapabilityRegistry` 的注册边界）：

1. **Agent**：规划、分析、调用工具，完成一次有界执行；不拥有长期生命周期。
2. **Provider**：调用外部系统，返回 bounded observation、effect result 和 readback；不拥有领域转换策略。
3. **Capability**：定义 caller-facing outcome、领域策略、观察归一化、验证和 typed transition proposal；不直接写 Kernel 生命周期。
4. **LoopX Kernel**：拥有 Goal、Todo、Claim、Gate、Monitor、Quota、accepted writeback、Recovery 和 Scheduling；不做领域推理。

请求和结果方向相反：

```text
Agent → Capability → Provider → 外部系统
外部 observation / effect readback → Provider → Capability
typed transition proposal → LoopX Kernel → 下一个 Todo / Gate / Monitor / Turn
```

最重要的结论是：**观察不是状态转换，Provider 回执不是已接受的进展。** 只有 Capability 验证、Kernel 提交后，状态才改变。

## 3. 六层持久状态：控制面的“账本”

`docs/architecture.md` 明确定义六层：

| 层 | 作用 | 不是什么 |
| --- | --- | --- |
| Registry | 已知 Goal、repo、adapter、authority source、status、guard | 不是每轮聊天摘要 |
| Goal state | 单个 Goal 的当前活跃状态文件 | 不是完整日记 |
| Run log | 每次运行留下的 JSON/Markdown 报告 | 不是可变事实源本身 |
| Run history | 给 Agent、Heartbeat、UI 消费的紧凑索引 | 不是原始全量日志 |
| Status / attention queue | 当前谁需要行动的首屏投影 | 不是 canonical state |
| Compute quota | 本地自动计算预算与暂停策略 | 不是 Linux 调度器 |

项目级入口通常放在：

```text
<project>/.loopx/registry.json
```

Registry 再指向每个 Goal 的 `state_file`，而运行历史、journal、event 等位于解析出的 runtime root 下；具体路径由 `loopx/runtime.py` 和各命令解析，不应在文档或适配器里硬编码。项目私有材料通常要求 `.loopx/` 被 Git 忽略。

一条容易记的链：

```text
Registry / Goal State / Run History
        └── 派生 ──► Status + Attention Queue
                              │
                              ▼
                         Quota decision
                              │
                              ▼
                         Turn packet
                              │
                              ▼
                   Host / Provider / Capability
                              │
                              ▼
                 validated writeback + receipt
                              │
                              └── 重新派生下一轮
```

**六层不是六套真相。** Goal、Todo/Event 和已提交的回执是事实；Status、看板、prompt 和 `next_cli_actions` 是为读者整理的投影。

## 4. 七块心智模型

### 4.1 循环

LoopX 的主循环不是“while true 调模型”，而是：

```text
读取当前状态
  → quota should-run 判断是否允许下一动作
  → 生成 TurnEnvelope / transaction plan
  → Host 执行一次有界工作
  → 验证结果
  → 写回状态
  → 花配额
  → scheduler apply / ack
  → 重新计算下一轮
```

Host 内当然还会有模型与工具循环；但 LoopX 只拥有**跨 Turn 的控制循环**。一次 Turn 结束，不等于目标完成；目标是否完成由 acceptance、monitor、follow-up 和 terminal audit 决定。

### 4.2 上下文

LoopX 把上下文分成两类：

- **长期事实**：Goal、约束、Todo、决策、证据、运行记录。跨 session 存在磁盘/权威存储中。
- **本轮上下文**：由当前 TurnEnvelope、选中的 Todo、capability gate、推荐动作和 Host 提供的会话组成。

源码支持 `iteration_context_policy = fresh | resume`。`fresh` 明确表示新一轮不假设旧聊天仍有效；`resume` 复用 Host 会话。两者都要求重新绑定当前 Goal/Todo 身份，不能让旧会话替代当前事实。

### 4.3 工具

工具属于 Host。LoopX 不让模型直接“写 Goal 文件”取得成功：

- Agent 执行有界工作；
- Capability 把领域观察变成 typed proposal；
- Kernel 验证 proposal 和 receipt；
- 只有 settlement 才能提交 durable state / quota。

因此，工具调用成功只是候选事实；没有 readback 和 validation，不能算 accepted progress。

### 4.4 模型接入

LoopX 本身不实现 provider SDK，也没有统一模型抽象。它通过 Host adapter 把同一控制面接到 Codex、Claude Code、DSH 或 generic CLI。模型选择、凭据、流式协议属于 Host。

这换来了 provider-neutrality，也带来代价：LoopX 必须把“给 Host 什么、Host 必须回报什么”定义成很严格的类型化合同。

### 4.5 扩展

主要扩展轴：

- **Capability**：产品级能力合同，如 issue fix、PR review、benchmark；
- **Provider**：真正访问外部系统的适配器；
- **Extension**：独立交付/生命周期单元，可安装 provider；
- **Host adapter / goal mode**：把 LoopX 接到某个运行时；
- **Projection / UI**：只读展示，不获得 Kernel 权限。

`CapabilityRegistry` 分开注册 provider、capability contract 和 implementation，避免“装了扩展就等于获得生命周期写权限”。

### 4.6 界面

同一个控制面有多个消费者：

- CLI：`loopx status`、`quota should-run`、`turn plan`、`turn run-once`、`todo`、`history` 等；
- JSON：Agent、Heartbeat 和脚本读取的稳定投影；
- Host adapter：把读写映射成 CLI-equivalent 操作；
- Dashboard / Lark / Kanban：消费 public-safe projection；
- `loopx commands --format json`：命令面的机器可读入口。

一个核心原则是 **CLI fallback 永远存在**。服务、daemon 或 UI 都不是唯一控制通道。

### 4.7 工程

LoopX 的可靠性主要不靠“模型更小心”，而靠确定性合同：

- 有序七阶段事务；
- turn key / effect id / receipt 绑定；
- journal 持久化已完成阶段；
- 已提交 effect 不重复执行；
- 失败阶段必须精确声明；
- 恢复时只补未提交步骤；
- 架构测试限制 control plane 的越界 import。

## 5. 源码目录怎么读

| 目录 | 职责 | 第一眼先看 |
| --- | --- | --- |
| `loopx/entrypoint.py`、`loopx/cli.py` | CLI 入口和命令注册 | `main()`、`build_parser()` |
| `loopx/control_plane/` | 真正的 Kernel 合同和状态转换 | `quota/`、`todos/`、`turn_driver/`、`scheduler/`、`goals/` |
| `loopx/capabilities/` | 领域能力包 | 具体能力的 `catalog_entry.py`、`cli.py`、tests |
| `loopx/extensions/` | 可选 provider/集成 | `extension.toml`、provider 入口 |
| `loopx/*_goal_mode/` | 不同 Host 的接入 | prompt/hook 如何转到 CLI |
| `loopx/presentation/`、`web/` | 投影与展示 | 是否只读、是否越权 |
| `tests/`、`tests/architecture/` | 行为与边界证明 | turn recovery、import boundary、public/private |

源码同时包含 Python 与 TypeScript。不要简单理解成“Python 控制面搬到 TS”：

- Python 仍拥有大量 CLI、provider 桥接、文件和 Host 适配；
- TypeScript 承担更严格的 Turn settlement、quota/scheduler 等合同；
- Python 适配器常把 provider 结果和 readback 交给 TS 做最终判定。

读某条路径时，先确认**当前实现所有者**，再看兼容层，否则容易在两个 runtime 之间迷路。

## 6. 术语卡片

| 术语 | 一句话解释 |
| --- | --- |
| Goal | 有稳定身份、边界和验收的长程目标 |
| Todo | Goal 下的一张有界工作卡，有 id、scope、依赖和 continuation |
| Frontier | 当前状态下真正可推进的边界，不是所有未完成项的列表 |
| Claim / Lease | 谁正在负责/持有一段工作；身份与权限，不是永久 leader |
| Gate | 需要用户、控制器或前置事实才能通过的门 |
| Quota | 自动计算预算及其状态；决定能否花一个 slot |
| Evidence | 能支持判断的事实，需新鲜、可定位、可验证 |
| Receipt | 某次 effect 或 Turn 的绑定回执，不等于 accepted 结果 |
| Monitor | 外部条件未满足时的定时/条件观察工作 |
| Projection | 面向人或 Agent 压缩出的读模型 |
| Turn | 一次 governed state transition，包含 host 执行和结算 |
| Settlement | 把验证过的结果变成 durable state、quota spend 和 scheduler 状态 |

## 7. 自测：先判断“谁拥有事实”

对下面每条陈述，说出它属于事实、投影还是 execution：

1. “Dashboard 显示 3 个 Todo 可做。”
2. “Todo `t-42` 已由 agent A 在 lease 内领取。”
3. “Host 返回 `terminal_closeout_failed`。”
4. “配额状态是 `operator_gate`，仅阻断 gated delivery。”
5. “模型认为 PR 已合并。”

### 参考答案

1 **投影**：Dashboard 的计数来自状态/历史投影，可以重建，不拥有事实。
2 **canonical 状态**：`t-42` 的 claim/lease 是控制面事实，决定当前谁有资格推进。
3 **typed execution result**：`terminal_closeout_failed` 是 Host/执行路径返回的有类型结果，说明已走到哪个失败阶段。
4 **投影 + 决策输出**：`operator_gate` 是 quota 决策状态；它只阻断对应 scope（例如 gated delivery），不等于 Goal 全局冻结。
5 **模型判断，默认不是事实**：必须经 Provider readback、Capability validation 和 Kernel writeback，才能成为 durable evidence/状态。

判断口诀：**UI 列表、推荐动作、摘要都是投影；claim/lease、quota spend、writeback、receipt 才是需要绑定身份并持久化的事实。**

## 8. 下一步

进入 `turn-lifecycle.md`。读的时候始终问：

- 这一步是只读投影，还是会产生 effect？
- 如果进程在这里崩溃，journal 能证明什么？
- 下一阶段为什么必须排在它后面？
