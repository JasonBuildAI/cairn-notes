---
title: "阶段 1：一条请求如何穿过 Pi"
description: "跟随一条请求穿过入口、会话、模型与工具，建立端到端系统地图。"
---

> **本阶段的位置**：阶段 0 已能运行 Pi。现在先不钻进任何模块，而是建立整张地图。
> **源码目录**：`$PI_SRC`。下文路径均相对这个目录。
> **先读**：[介绍与整体架构](../)第一至五章。本文件把那张总图落到源码坐标上。

## 一、本阶段到底要解决什么

初学者最容易犯的错，是从 `packages/` 目录开始一个个读文件。读到一半会发现：循环、会话、工具、模型接入、界面全缠在一起，每个词都见过，但说不清它们怎样合作。

阶段 1 要建立的不是“文件记忆”，而是一张**运行时地图**：

1. 一个请求从哪个入口进来？
2. 它先经过谁，后经过谁？
3. 模型和工具在循环里怎样交接？
4. 发生过的内容存在哪里？
5. 执行过程怎样被界面和外部程序观察到？

学完这一章，你应该能合上电脑，在白纸上画出下面这条主线，并讲清每一段在做什么：

```text
输入
  → 入口层
  → AgentSession：整理这一次运行
  → Agent 循环：重建上下文 → 请求模型 → 执行工具 → 再请求
  → 模型供应商
  → 事件返回、会话落盘
  → agent_settled：真正空闲
```

只记住一个判断标准：**看到一个模块时，先问它在请求旅程的哪一段，而不是问它有多少个文件。**

---

## 二、先认识几个词，不然后面每一步都会混

### 2.1 session、entry、branch、leaf

Pi 的会话不是一段普通文本，而是一棵只追加的树。

| 词 | 人话解释 | 例子 |
| --- | --- | --- |
| Session | 一次可持续对话的完整记录 | 一个 `.jsonl` 会话文件 |
| Entry | 会话文件里的一行记录 | 一条用户消息、一条工具结果、一次模型切换 |
| Branch | 从根节点走到某个节点的连续路径 | “用户问 → 助手答 → 工具执行”这条路线 |
| Leaf | 当前活动分支的末端 | 下一次继续对话时从哪个节点往后接 |

关键点：

- **一条分支本身是连续的**：从根沿着 `parentId` 一路到当前 leaf。
- **一棵树可以有多条分支**：回到旧消息后继续发新消息，不会覆盖原来的后续，而是从旧节点长出另一条路线。
- 模型一次只读取**当前活动分支**，不会读整棵树的所有分支。

### 2.2 run、turn、event

| 词 | 人话解释 | 边界 |
| --- | --- | --- |
| Run | 从一次输入开始，到系统确认没有自动工作为止 | `agent_start` / `agent_settled` 大致对应首尾 |
| Turn | 一次模型回复及其要求的工具执行 | `turn_start` / `turn_end` |
| Event | 运行过程中的状态通知 | 增量文本、工具开始/结束、消息落盘等 |

一个 run 可以包含多个 turn。常见原因是：模型先要求读文件，工具返回结果后，模型还要再请求一次才能给出最终回答。

### 2.3 projection：本阶段先埋一个伏笔

模型并不直接读取会话文件。每次请求前，Pi 会从当前活动分支计算出一份“模型可见的对话历史”，这叫**投影（projection）**。

你可以先把它理解成“从原始账本中，按当前规则临时整理出一份工作副本”。为什么不是直接读文件、压缩又如何参与，阶段 3 会完整展开。

---

## 三、11 个包：先看四种用途，不要先背清单

仓库里实际有 11 个包。初读时不要平均用力，先按角色分组：

```text
coding-agent
  ├─► agent ──► ai ──► telemetry
  ├─► ai
  ├─► codemode
  ├─► mcp
  └─► tui

durable ──► chord、ai、codemode
env     ──► chord、durable
evals   ──► ai、coding-agent
```

箭头表示「左边的包依赖右边的包」。`agent` 只依赖 `ai`，不依赖 `coding-agent`、界面或工具注册表；这正是引擎能脱离 CLI 复用的原因。

### 3.1 四种用途

| 角色 | 包 | 一句话理解 |
| --- | --- | --- |
| 产品应用 | `coding-agent` | 把循环、会话、工具、扩展和界面组装成可用的 Pi |
| 引擎 | `agent`、`ai` | `agent` 负责循环；`ai` 负责统一模型接入 |
| 支撑 | `tui`、`mcp`、`codemode`、`chord`、`durable`、`env`、`telemetry` | 分别负责界面、外部工具、沙箱、运行时和观察能力 |
| 开发工具 | `evals` | 开发期评测，不参与产品运行主链路 |

### 3.2 主要依赖关系

| 包 | 内部依赖 | 用途 |
| --- | --- | --- |
| `ai` | `telemetry` | 多供应商模型接入、流式事件、认证、模型目录 |
| `agent` | `ai` | 通用循环，刻意不依赖 UI |
| `coding-agent` | `agent`、`ai`、`codemode`、`mcp`、`tui` | 完整 CLI 产品 |
| `durable` | `chord`、`ai`、`codemode` | 持久化运行时 |
| `env` | `chord`、`durable` | 远程执行环境 |
| `evals` | `ai`、`coding-agent`（开发依赖） | 开发期评测工具 |
| `chord`、`codemode`、`mcp`、`telemetry`、`tui` | 无内部依赖 | 叶子包/基础部件 |

只要记住两个方向就够了：

1. **主干向下**：`coding-agent → agent → ai → telemetry`。引擎不知道 `coding-agent` 的存在，所以可以脱离 CLI 复用。
2. **能力向外**：`codemode`、`mcp`、`tui` 是应用层按需接上的部件，不是循环内部写死的功能。

### 3.3 最容易混淆的两个对象

`AgentSession` 和 `SessionManager` 都在应用层，但职责完全不同：

| 对象 | 像什么 | 管什么 |
| --- | --- | --- |
| `AgentSession` | 一次任务的项目经理 | 输入处理、命令判断、模板展开、排队、认证、压缩检查、启动/收尾一次运行 |
| `SessionManager` | 档案馆管理员 | 读写 JSONL、维护 `id`/`parentId` 树、找活动分支、生成投影、记录模型切换等状态 |

一句话：**`AgentSession` 管“这次怎么跑”，`SessionManager` 管“发生过什么、下次怎么取”。**

真正的循环不在 `AgentSession` 里，而在 `packages/agent`。

---

## 四、一条请求的完整旅程

这一节是全章核心。先顺着故事走一遍，不要急着看代码。

### 4.1 入口层收下输入

你在交互界面敲回车，界面把文本（以及可能的图片）交给：

```text
AgentSession.prompt(text)
```

界面不负责决定用哪个模型，也不自己执行工具。它只负责输入、显示和把事件交给用户。

### 4.2 AgentSession 做发送前检查

`prompt()` 像总调度，依次处理：

1. **扩展命令**：输入以 `/` 开头且命中扩展命令，就直接执行，不调用模型。
2. **输入处理器**：扩展可以拦截、改写或取消输入。
3. **技能与提示模板**：把 `/skill:...` 或模板展开成真正的提示词。
4. **流式排队**：如果上一条回复还在输出，这次输入会按类型进入 steer 或 follow-up 队列。
5. **认证检查**：确认已选模型，并且 provider 有可用凭据。

这些检查通过后，才进入 `_startRun()` / `_prepareRun()`。

### 4.3 准备这一次 run

准备阶段主要做三件事：

- 如果历史接近模型上限，先做压缩检查；
- 触发 `before_agent_start` 扩展事件；
- 组装这次要新增的消息，并交给引擎的 `Agent`。

注意：这里交给 `Agent` 的不是“整段历史”，而是本次新增的起始消息。完整上下文里的对话历史部分，会在真正发请求前从会话账本重新投影；系统提示词和工具声明再另外组装。

### 4.4 Agent 启动循环

`Agent` 收到起始消息后启动 `runLoop`。循环的主线可以压缩成：

```text
准备请求 → 请求模型 → 有工具调用吗？
                          ├─ 有：执行工具，记录结果，回到“准备请求”
                          └─ 无：结束本轮；没有后续工作就结束本次 run
```

这就是“工具调用后自动继续”的全部秘密：不是工具自己会再调用模型，而是循环把工具结果当作下一次请求的输入。

### 4.5 发请求前：重建上下文

每轮请求前，Pi 都按同一套步骤准备上下文：

1. 从当前 leaf 沿 `parentId` 回溯，找到活动分支；
2. 应用最新压缩检查点和上下文编辑，生成投影；
3. 把内部的 `AgentMessage[]` 经 `convertToLlm` 转成模型消息格式；
4. 加上系统提示词和工具声明，交给模型适配层。

这条转换链一定要分清：

```text
会话文件（完整账本）
  └─ 活动分支（当前这条路径）
       └─ 投影（模型可见的对话历史）
            └─ convertToLlm（内部格式 → 模型格式）
                 └─ 发给 provider
```

- **投影**是在选择内容：哪些留下、哪些用摘要代替、哪些被编辑；
- **`convertToLlm`** 是在换格式：把 Pi 内部消息翻译成模型接口要求的消息。

### 4.6 调用模型与流式返回

`agent` 把统一格式的请求交给 `ai`。`ai` 根据 provider 的协议发 HTTP 请求，并把厂商的流式数据统一成内部事件：

- 文本开始、文本增量、文本结束；
- 思考增量；
- 工具调用参数增量；
- 完整消息、错误和中止。

界面看到 `message_update` 就实时显示；完整消息在 `message_end` 时确定并被追加到会话账本。

### 4.7 工具结果回到上下文

如果模型回复里带工具调用：

1. 引擎校验参数并执行工具；
2. 结果作为 `toolResult` 消息写回上下文和会话树；
3. 循环回到“重建上下文”；
4. 模型看到工具结果，再决定下一步。

例如：

```text
用户：修复登录页报错
  → 模型要求读取 auth.ts
  → 工具返回文件内容
  → 模型要求搜索调用点
  → 工具返回搜索结果
  → 模型要求修改代码
  → 工具返回修改结果
  → 模型给出最终说明
```

一次用户输入，可能对应多次模型请求和多次工具执行；它们属于同一个 run，但分成多个 turn。

### 4.8 `agent_end` 为什么还不等于彻底结束

普通的 steering / follow-up 会在底层 `runLoop` 内部先处理完；当没有工具调用、也没有待处理消息时，才发出 `agent_end`。但会话层还可能：

- 自动重试失败的请求；
- 在上下文超限时压缩并恢复；
- 在 `agent_end` 处理器里排入新的工作。

只有 `agent_settled` 才表示“没有会自动继续的工作，Pi 真正空闲”。交互界面通常到这时才把控制权完全还给你。

---

## 五、用事件流观察整条链路

### 5.1 跑一条 JSON 事件流

在学习区执行：

```powershell
cd $PI_SRC
.\pi-test.ps1 --mode json "读一下 package.json 的前 20 行" > events.jsonl
```

你会看到一条事件序列，而不是只有最终回答。

### 5.2 重点看哪些事件

| 事件 | 说明 |
| --- | --- |
| `agent_start` | 一次 run 开始 |
| `turn_start` | 一次“模型回复 + 工具执行”的回合开始 |
| `message_start` | 一条消息开始 |
| `message_update` | 流式增量（文本、思考、工具参数） |
| `message_end` | 完整消息定稿，通常触发落盘 |
| `tool_execution_start/update/end` | 工具开始、执行中输出、结束 |
| `turn_end` | 当前 turn 收尾 |
| `agent_end` | 底层循环结束；普通 follow-up 已处理完，但会话层仍可能自动重试或恢复 |
| `agent_settled` | 会话层确认真正空闲 |

### 5.3 一个关键理解：事件不是“日志附赠品”

事件流是系统对外的主要观察接口：

- TUI 用它实时绘制；
- JSON 模式把它原样输出；
- RPC 转发给外部进程；
- SDK 让宿主程序订阅；
- 调试 agent 时，它比最终回答更能说明“系统到底做了什么”。

所以不要把事件看成“顺手打印的日志”。它是架构的一部分。

---

## 六、三个容易混的对象转换

### 6.1 会话 entry → AgentMessage

会话文件里有一堆 entry，但并不是每条都会变成模型消息。`label`、`usage`、`model_change` 等只影响状态或界面，投影时才决定它们是否产生消息。

### 6.2 AgentMessage → 投影

投影是从活动分支得到的“模型可见的对话历史”，它会应用压缩和上下文编辑，但不会改写原始 entry。它是每次请求临时算出来的，不单独落盘。

### 6.3 投影 → convertToLlm → Message

这一步只做格式转换，不决定内容取舍。`AgentMessage[]` 是 Pi 内部统一表示，`Message[]` 是模型适配层需要的格式。

一句话：**投影决定对话历史里“发什么”，系统提示词和工具声明另外组装；`convertToLlm` 决定“用什么格式发”。**

---

## 七、建议你亲手画的两张图

### 图 1：包依赖图

按“产品、引擎、支撑、开发工具”四组画，不要按文件数量画。

#### 参考答案

箭头 `A ──► B` 表示 A 依赖 B。

```text
【产品层】
coding-agent
  ├─► agent
  ├─► ai
  ├─► codemode
  ├─► mcp
  └─► tui

【引擎层】
agent ──► ai ──► telemetry

【支撑层】
durable ──► chord、ai、codemode
env     ──► chord、durable

chord、telemetry、tui、mcp、codemode：没有内部依赖

【开发工具】
evals ──► ai、coding-agent（开发依赖）
```

把四组连起来看，主干是：

```text
coding-agent ──► agent ──► ai ──► telemetry
```

画完后用下面四点检查：

- `agent` 只依赖 `ai`，不能画成依赖 `coding-agent` 或 `tui`；否则循环引擎就无法独立复用。
- `coding-agent` 直接依赖 `agent`、`ai`、`codemode`、`mcp`、`tui`，它是把这些部件组装起来的成品。
- `durable`、`env` 属于平台支撑，不在“用户消息 → 模型 → 工具”的主链路上。
- `evals` 是开发工具，不是产品运行链路的一环。

### 图 2：请求时序图

至少画出：

```text
界面 → AgentSession.prompt
     → 发送前检查
     → _prepareRun
     → Agent.runLoop
     → 投影 + convertToLlm
     → ai / provider
     → 工具执行
     → message_end 落盘
     → agent_end / agent_settled
```

#### 参考答案

```text
界面（TUI / print / JSON / RPC / SDK）
  │ 用户输入
  ▼
AgentSession.prompt(input)
  ├─ 扩展命令？──是──► 立即执行，不进入模型
  ├─ 输入处理器：拦截 / 改写 / 取消
  ├─ 技能与提示模板展开
  ├─ 流式排队：steer / follow-up
  └─ 认证检查：模型与凭据
  ▼
AgentSession._prepareRun()
  ├─ 必要时压缩
  ├─ before_agent_start
  └─ 生成本次新增的起始消息
  ▼
Agent.runLoop()
  ├─ agent_start
  ├─ turn_start
  ├─ 从当前 leaf 找活动分支（SessionManager）
  ├─ 生成投影：应用压缩与 context_edit
  ├─ convertToLlm：AgentMessage[] → Message[]
  ├─ 组装请求：系统提示词 + 工具声明 + 当前输入
  ├─ ai / provider：流式返回
  │    └─ message_update / text_delta → 界面
  ├─ message_end：助手消息落盘
  ├─ 有工具调用？
  │    ├─ 是：校验 → 执行 → toolResult 落盘 → 下一 turn
  │    └─ 否：检查 steer / follow-up
  └─ 没有工具且没有排队工作 → agent_end
  ▼
AgentSession 收尾
  ├─ 自动重试
  ├─ 压缩恢复
  └─ 处理 agent_end 处理器排入的新工作
  ▼
agent_settled（真正空闲）
```

沿着这张图读一遍：

1. `AgentSession` 把“用户输入”整理成“这次 run 的起始消息”。
2. `AgentSession` 不保存整段历史；真正的历史由 `SessionManager` 从活动的 `leaf` 沿 `parentId` 找出来，再生成投影。
3. `Agent` 每轮拿到投影后，通过 `ai` 发请求；模型要求工具时，工具结果落盘并作为下一轮输入。
4. `agent_end` 只说明底层循环结束；`agent_settled` 才说明自动重试、压缩恢复等后续工作也没有了。

画完后合上文档，能指着图讲出每一步输入和输出，才算过关。

---

## 八、常见误区

| 误区 | 正确理解 |
| --- | --- |
| `agent` 就是整个 Pi | `agent` 只是循环引擎；完整产品是 `coding-agent` |
| `AgentSession` 就是会话文件 | `AgentSession` 管这次运行；`SessionManager` 管持久化账本 |
| 一条用户消息只对应一次模型请求 | 有工具调用时，一次输入可能触发多次请求和多个 turn |
| `agent_end` 就是最终结束 | 普通 follow-up 已在底层循环内处理完；之后还可能有自动重试、压缩恢复或 `agent_end` 处理器排入的工作，看 `agent_settled` |
| 会话文件就是模型上下文 | 模型只读活动分支投影出的对话历史，不读整棵树和原始文件 |
| 事件只是日志 | 事件是 TUI、JSON、RPC、SDK 和调试的共同接口 |
| 投影会改写原始历史 | 投影是临时视图，原始 entry 不变 |

---

## 九、通关自检

合上文档，先自己回答，再回头查：

1. `coding-agent`、`agent`、`ai` 的主干依赖关系是什么？各自负责什么？
2. `AgentSession` 和 `SessionManager` 的区别是什么？
3. 一条用户消息从入口到第一次模型请求，经过哪些对象？
4. 为什么工具结果回来后会自动开始下一轮？停止条件是什么？
5. `agent_end` 和 `agent_settled` 有什么区别？
6. 投影和 `convertToLlm` 分别在做什么？

### 参考答案

1. **主干与职责**：`coding-agent → agent → ai → telemetry`。`coding-agent` 是完整产品，负责输入、会话、工具、扩展和界面；`agent` 是通用循环引擎；`ai` 负责把不同厂商的模型协议和流式事件统一起来；`telemetry` 提供观察数据的格式。`coding-agent` 还直接依赖 `ai`、`codemode`、`mcp`、`tui`，`evals` 则是开发工具。

2. **两个对象的分工**：`AgentSession` 像一次运行的项目经理，负责接收输入、处理扩展命令、展开模板、排队、检查认证、触发压缩、启动和收尾；`SessionManager` 像档案馆管理员，负责读写 JSONL、维护 `id`/`parentId` 树、找当前活动分支、生成投影和记录模型切换。前者决定“这次怎么跑”，后者决定“发生过什么、下次怎么取”。

3. **第一次模型请求路径**：界面调用 `AgentSession.prompt()` → 发送前检查 → `_prepareRun()` → `Agent.runLoop()` → `SessionManager` 找活动分支并生成投影 → `convertToLlm()` → 加上系统提示词和工具声明 → `ai` → provider 发出请求。

4. **为什么自动下一轮**：工具结果不是终点，而是作为一条新的 `toolResult` 消息写回上下文；循环看到还有工具工作，就带着它进入下一轮。停止条件是“没有工具调用，也没有待处理的 steering / follow-up”，或者遇到显式结束、错误、中止。普通 follow-up 会在底层循环内先处理完，之后才有 `agent_end`；会话层还可能重试或压缩恢复。

5. **两个结束信号的边界**：`agent_end` 表示底层 `runLoop` 已经结束，但会话层可能还要自动重试、压缩恢复，或处理由 `agent_end` 处理器排入的新工作；`agent_settled` 才表示“没有任何会自动继续的工作”，界面此时才真正空闲。

6. **投影与格式转换**：投影负责从活动分支选择并整理“模型可见的对话历史”，会应用压缩和 `context_edit`，但不改写原始 entry；`convertToLlm` 只把这份内部 `AgentMessage[]` 翻译成 provider 要求的 `Message[]`，不决定历史内容。系统提示词、工具声明和当前输入还会在投影之外一起组装。可以记成：**投影是编辑，`convertToLlm` 是翻译。**

**一分钟复述版**：用户输入先交给 `AgentSession` 整理成一次 run；`Agent` 每轮从 `SessionManager` 取当前活动分支并生成投影，经 `convertToLlm` 和系统提示词、工具声明一起组成请求，交给 `ai`；模型要工具就执行并把结果写回，直到没有自动工作后发出 `agent_end`，会话层收尾完毕才到 `agent_settled`。

建议产出：

- [ ] 一张包依赖图；
- [ ] 一张请求时序图；
- [ ] 一份 JSON 事件流，能圈出至少 5 类事件并解释它们的顺序；
- [ ] 用 3 分钟不看稿讲清“一条请求如何穿过 Pi”。

下一站是阶段 2：把这条主线中的“循环”单独拆开，看 run、turn、steering、follow-up 和 abort 如何组成一个可中断的状态机。

---

*配套[学习路线](../learning-path/)阶段 1 · 基于 v1.3.0（`71023aec`）*
