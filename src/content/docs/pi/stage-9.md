---
title: "阶段 9：重建一个 mini agent"
description: "从零重建一个 mini agent，用实现检验对系统的理解。"
---

> **本阶段的位置**：前八阶段已经把 Pi 的七块拆开讲完。这一阶段不再增加新知识点，而是把七块重新装回去，做一个**小而完整**的 Agent。
> **源码目录参考**：`$PI_SRC`。你的实现最好放在单独目录，不要直接改学习区源码。
> **最终目标**：不看 Pi 源码，也能解释一个 Agent 为什么这样分层，并能做出一个能运行、能测试、能讲清楚取舍的 mini agent。

## 一、毕业设计到底要做什么

不是再抄几个 Pi 的例子，也不是做一个功能很多的产品，而是完成一条**端到端的最小纵切**：

```text
用户输入
  → 会话记录
  → 活动分支投影
  → 模型请求
  → 流式回复
  → 工具调用
  → 工具结果回填
  → 下一轮
  → 最终回答
  → 事件输出与测试
```

最低交付物：

- [ ] 一个循环：支持模型回复、工具调用、工具结果回填、自然停止和中止；
- [ ] 一份会话记录：至少保存消息、工具结果和一次压缩摘要；能解释树、分支和活动路径；
- [ ] 一次上下文投影：能从活动路径生成模型消息，压缩后仍保留原文；
- [ ] 两个工具：一个只读工具、一个会产生副作用的工具，并说明校验和风险；
- [ ] 一个模型适配：至少接入一个 provider，能处理流式文本、工具调用和错误；
- [ ] 一个界面：CLI 或 JSON 事件输出，至少能从外部观察执行过程；
- [ ] 一份追踪记录：导出一次完整请求的事件序列，能逐步解释消息、工具和停止原因；
- [ ] 一组测试：用假模型测循环、工具、分支和错误路径；
- [ ] 一份设计说明：画出七块结构，解释三个关键取舍。

**不要**一开始就加：

- 多用户和权限系统；
- 分布式任务队列；
- 向量数据库；
- 复杂前端；
- 十几个工具和十几个 provider。

先把一条纵切做通，再考虑扩展。

---

## 二、mini agent 的整体结构

### 2.1 一张总图

```text
CLI / JSON
    │ 输入、命令、事件订阅
    ▼
MiniSession
    │ 管理一次运行、活动 leaf、队列
    ├──────────────► SessionStore
    │                 entry 树，只追加
    │
    ├──────────────► Projector
    │                 活动分支 + 压缩 + 编辑 → 模型历史
    │
    ▼
MiniLoop
    ├──────────────► ModelAdapter
    │                 统一请求与流式事件
    │
    └──────────────► ToolRegistry
                      校验、权限、执行、截断
```

旁边还有一条事件流：

```text
Loop / Session 产生事件
  → CLI 打印
  → JSON 模式输出 JSONL
  → 测试收集并断言
```

这张图和 Pi 的七块一一对应：

| 七块 | mini agent 中的对应物 |
| --- | --- |
| 循环 | `MiniLoop` |
| 上下文 | `SessionStore` + `Projector` |
| 工具 | `ToolRegistry` + 两个工具 |
| 模型接入 | `ModelAdapter` |
| 扩展 | 可先留一个最简单的钩子接口 |
| 界面 | CLI 与 JSON 事件输出 |
| 工程 | 假模型测试、事件测试、设计文档 |

### 2.2 推荐目录

```text
mini-agent/
├── src/
│   ├── session-store.ts
│   ├── projector.ts
│   ├── loop.ts
│   ├── model-adapter.ts
│   ├── tool-registry.ts
│   ├── tools/
│   │   ├── read-file.ts
│   │   └── write-note.ts
│   ├── events.ts
│   └── cli.ts
├── test/
│   ├── loop.test.ts
│   ├── projection.test.ts
│   ├── tools.test.ts
│   └── branch.test.ts
├── DESIGN.md
└── package.json
```

名称可以不同，但边界要尽量接近：会话存储不负责调用模型，模型适配不负责工具执行，界面不负责决定循环何时停止。

---

## 三、先定义五个核心对象

### 3.1 Entry：会话账本里的一行

```ts
type Entry =
  | {
      type: "message";
      id: string;
      parentId: string | null;
      timestamp: number;
      role: "user" | "assistant" | "toolResult";
      content: unknown;
    }
  | {
      type: "compaction";
      id: string;
      parentId: string | null;
      timestamp: number;
      summary: string;
      firstKeptEntryId: string;
    };
```

最重要的字段不是 `content`，而是：

- `id`：本条记录是谁；
- `parentId`：它接在哪条记录后面；
- `type`：它是内容、摘要还是其他状态。

只追加意味着：已经写入的 entry 不修改、不删除。要改“当前看到什么”，改变的是 active leaf 或投影规则，不是改历史文件。

### 3.2 SessionStore：管理树和 leaf

它至少要有这些能力：

```ts
append(entryInput): Entry
setLeaf(id): void
getActivePath(): Entry[]
getChildren(id): Entry[]
save(): Promise<void>
load(): Promise<void>
```

`getActivePath()` 从当前 leaf 沿 `parentId` 一路回溯到根，再反转顺序。它返回的是一条连续分支，不是整棵树。

### 3.3 Projector：把分支变成模型消息

```ts
project(branch: Entry[]): ModelMessage[]
```

它的输入是活动分支，输出是“模型可见的对话历史”。它不写文件，也不修改原 entry。

### 3.4 ModelAdapter：统一模型接口

```ts
interface ModelAdapter {
  stream(request: {
    messages: ModelMessage[];
    tools: ToolSpec[];
    signal: AbortSignal;
  }): AsyncIterable<ModelEvent>;
}
```

`ModelEvent` 至少包括：

```text
text_delta
toolcall_start
toolcall_delta
toolcall_end
done
error
```

具体字段可以简化，但语义要保留：文字增量、完整工具调用、正常结束、错误结束。

### 3.5 ToolRegistry：工具的统一入口

```ts
interface ToolDefinition {
  name: string;
  description: string;
  schema: unknown;
  execute(args: unknown, signal: AbortSignal): Promise<ToolResult>;
}
```

`ToolResult` 至少包含：

```text
content     给模型看的文本/图片
isError     是否失败
details     给界面或调试看的数据
```

工具注册表负责：

- 按名字找工具；
- 校验参数；
- 调用权限钩子；
- 执行；
- 截断结果；
- 生成工具结果消息。

---

## 四、实现顺序：每一步都能运行

不要按“先写完所有模块再联调”的方式做。应该每一步都有一个可验证的最小闭环。

### 里程碑 1：假模型 + 最小循环

先不接真实模型，写一个脚本化假模型：

```text
第一次调用：返回“你好”
```

循环只需要：

1. 追加用户消息；
2. 调模型；
3. 追加助手消息；
4. 结束。

验收：一条输入能得到一条确定输出，并发出 `agent_start` / `agent_end`。

### 里程碑 2：模型流式事件

把假模型改成逐块产生：

```text
text_delta("你")
text_delta("好")
done(完整消息)
```

验收：CLI 能实时显示文字，最终消息以 `done` 中的完整内容为准。

### 里程碑 3：工具调用 + 回填

让假模型第二次响应返回一个工具调用：

```json
{
  "name": "read_file",
  "arguments": { "path": "README.md" }
}
```

循环要：

1. 找到工具；
2. 校验参数；
3. 执行；
4. 生成 `toolResult`；
5. 再请求模型。

验收：工具结果确实出现在下一次请求里，并且循环能基于它给出最终回答。

### 里程碑 4：会话树和分支

把内存消息数组换成 `SessionStore`：

- 每条消息都有 `id` / `parentId`；
- 当前 leaf 决定活动分支；
- 从旧节点继续时，追加一个新 child，而不是覆盖旧后续。

验收实验：

```text
m1 用户
  └─ m2 助手
      ├─ a3 用户 → a4 助手   （分支 A）
      └─ b3 用户 → b4 助手   （分支 B）
```

切回 `m2`，再发一条新消息，应该得到分支 B；分支 A 仍在文件里，但不会进入 B 的投影。

### 里程碑 5：投影

实现：

```ts
project(branch) =>
  branch
    .filter(isModelVisible)
    .map(toModelMessage)
```

验收：

- 只包含活动分支；
- 不包含其他分支；
- 不把 `label`、`usage` 这类非内容 entry 变成消息；
- 输出顺序与从根到 leaf 一致。

### 里程碑 6：压缩

先手动触发一次压缩：

```text
活动分支：m1 ... m8
压缩结果：追加 c1
保留从 m6 开始的原文
```

投影规则：

```text
模型可见的对话历史 =
  c1.summary
  + m6、m7、m8
  + 压缩后新增的消息
```

如果压缩后又发了 `m9`：

```text
会话树：m1 ... m8 → c1 → m9
投影：  [c1 摘要] + m6 + m7 + m8 + m9
```

注意：

- `m1...m8` 原文仍在树里；
- `c1` 是一条新的压缩 entry，不是删除或覆盖；
- `firstKeptEntryId` 决定从哪里开始保留原文；
- 投影是临时算出来的，不单独落盘。

验收：

- 压缩前后 token 数下降；
- 摘要进入上下文；
- 原始 entry 仍能读出来；
- 从压缩点之前的旧节点分叉仍然可行。

### 里程碑 7：两个真实工具

建议做：

1. `read_file(path)`：只读，限制在工作目录内；
2. `write_note(path, text)`：有副作用，写一个小文本文件。

两个工具必须体现不同风险：

| 工具 | 校验 | 风险控制 |
| --- | --- | --- |
| `read_file` | 路径存在、是文件、大小限制 | 防目录穿越；大文件截断 |
| `write_note` | 路径合法、内容大小限制 | 串行写同一文件；明确覆盖行为 |

验收：

- 参数错误返回 `isError`，循环不崩；
- 大文件被截断，并告诉模型如何继续；
- 写工具失败时不会假装成功；
- 同一次助手消息里两个写操作不会互相覆盖。

### 里程碑 8：CLI 与 JSON 事件

最小 CLI：

```text
mini-agent "读一下 README 并总结"
mini-agent --json "读一下 README 并总结" > events.jsonl
```

事件至少要有：

```text
run_start
turn_start
text_delta
tool_start
tool_end
message_end
run_end
run_settled
```

这些是 mini agent 自己的简化事件名，用来练习结构；它们大致对应 Pi 的 `agent_start`、`turn_start`、`agent_end`、`agent_settled`，但不要把这些名字和 Pi 的真实事件混为一谈。

`--json` 模式要遵守：

- stdout 只输出 JSONL；
- 日志写 stderr；
- 每条记录一行；
- 最终状态看 `run_settled`。

### 里程碑 9：测试与设计文档

用假模型覆盖：

- 纯文本回答；
- 一次工具调用；
- 工具参数错误；
- 工具执行失败；
- 多工具并行/串行；
- 中止；
- 分支切换；
- 压缩后投影；
- 事件顺序。

最后写 `DESIGN.md`，见下一节。

---

## 五、循环应该怎样写

用伪代码表示，核心逻辑比 Pi 简化，但结构要一致：

```ts
async function run() {
  emit("run_start");
  store.append(userMessage);

  try {
    while (true) {
      emit("turn_start");

      const branch = store.getActivePath();
      const messages = project(branch);
      const assistant = await callModel(messages, tools, signal);

      store.append(assistant.message);
      emitMessage(assistant.message);

      const calls = assistant.message.toolCalls;
      if (calls.length === 0) {
        break;
      }

      const results = await executeToolCalls(calls);
      for (const result of results) {
        store.append(result);
        emitMessage(result);
      }
    }
  } finally {
    emit("run_end");
    emit("run_settled");
  }
}
```

这段伪代码省略了重试、steering、follow-up 和压缩触发，但已经体现三个关键点：

1. **每轮都重新投影**，而不是维护一份不断拼接的全局消息数组；
2. **工具结果先写入会话，再进入下一轮**；
3. **循环只在没有工具调用时自然结束**。

### 5.1 加入中止

给模型请求和工具执行都传 `AbortSignal`：

```text
用户按 Ctrl+C
  → abortController.abort()
  → 模型流停止
  → 正在跑的工具收到取消信号
  → 循环以 aborted 结束
```

中止不是“把 Promise 丢掉不管”，而是要让网络请求、子进程和事件监听都有机会清理。

### 5.2 加入 steering / follow-up（可选进阶）

先实现最简单的两个队列：

- steering：当前助手回合结束后插入，尽快影响下一步；
- follow-up：当前工作都结束后再开始新一轮。

如果做不出来，不影响毕业；但你要能解释它们为什么不能和普通用户消息完全等同。

---

## 六、投影和压缩必须讲清的四句话

这是整个课程最容易混的地方，mini agent 必须把它做实：

1. **会话树是完整账本。** 所有分支、原文、摘要、工具结果都在里面。
2. **活动分支是一条连续路径。** 从根到当前 leaf，只走 `parentId` 链。
3. **压缩是往树里追加一条摘要 entry。** 它不删除原文。
4. **投影是每次请求临时算出的模型可见的对话历史。** 摘要只是投影的输入之一，投影不是另一棵树。

这里的“投影”只负责对话历史；完整上下文还包括系统提示词、工具声明、当前模式等，它们会在投影之外一起组装。

用例子收尾：

```text
原始分支：m1 m2 m3 m4 m5 m6 m7 m8
压缩后：  m1 ... m8 → c1 → m9

投影 = c1 的摘要 + 从 firstKeptEntryId 起保留的原文 + m9
```

如果另一个分支从 `m2` 分出：

```text
m1 → m2 → m3 ... m8 → c1 → m9    （分支 A）
        └→ b3 → b4                （分支 B）
```

选择分支 B 时，投影只走 `m1 → m2 → b3 → b4`，不会带上分支 A 的 `c1` 和 `m9`。

这也是为什么“回到旧消息继续发”会产生另一条连续分支，而不是覆盖原来的对话。

---

## 七、工具管线的最小安全版

mini agent 不需要复制 Pi 的全部安全机制，但至少要有：

```text
① 参数 schema 校验
② 工作目录边界检查
③ 危险动作确认或拦截
④ 大输出截断
⑤ 错误结果回填
⑥ 写操作串行化
```

### 7.1 参数校验

用 TypeBox、Zod 或 JSON Schema。校验失败时：

```text
不执行 → 生成 isError 结果 → 让模型修正
```

### 7.2 路径边界

至少要做：

```ts
const absolute = resolve(cwd, inputPath);
if (!absolute.startsWith(cwd + sep)) {
  throw new Error("Path escapes workspace");
}
```

真实产品还要处理符号链接、大小写、Windows 驱动器等细节；毕业设计只需明确边界存在。

### 7.3 截断

可以复用 Pi 的思路：

- 按行数和字节数双限；
- 保留开头或结尾；
- 完整结果写临时文件；
- 在结果里告诉模型完整路径。

### 7.4 副作用

写工具要明确：

- 是覆盖还是追加；
- 失败时会不会留下半个文件；
- 是否需要临时文件 + 原子替换；
- 同一路径并发写如何串行。

---

## 八、模型适配器的最小版本

不要一开始支持所有厂商。选一个你能实际调用的协议即可。

### 8.1 必须处理的四类输入

```text
普通文本增量
工具调用开始
工具参数 JSON 增量
完成 / 错误 / 中止
```

### 8.2 必须处理的四个边界

- 工具参数可能分片到达，必须等完整结束再解析；
- 模型可能只返回文字，不调用工具；
- 模型可能在工具调用后继续输出文字；
- 流可能在中途失败或被用户中止。

### 8.3 错误不要吞

适配器应该把错误变成统一事件，让循环知道：

```text
是可重试的网络错误？
是认证失败？
是上下文超限？
是用户主动中止？
```

如果所有错误都被包装成“模型回复为空”，调试会非常困难。

### 8.4 测试适配器不需要每次都打网络

可以录一段合法的 SSE 样本，喂给解析函数，验证：

- 文本增量拼接；
- 工具参数拼接；
- `done` 后最终消息；
- `error` 的停止原因；
- 中止信号。

真实网络只做少量冒烟验证。

---

## 九、测试计划：用确定的方式验证不确定的系统

### 9.1 假模型脚本

为每个测试安排精确的模型响应序列：

```text
测试 1：一条文本 → 期望 1 个 turn
测试 2：文本 → 工具调用 → 最终文本 → 期望 2 个 turn
测试 3：工具参数错误 → 模型修正 → 最终文本
测试 4：工具抛错 → 错误结果 → 循环继续
测试 5：abort → 工具停止 → run_settled(aborted)
```

### 9.2 会话测试

- 从旧节点分叉后，两条分支都在；
- 切换 leaf 后投影只包含活动分支；
- 压缩后原文仍可读；
- 投影不修改 entry；
- 重新加载文件后树结构一致。

### 9.3 事件测试

不要只看最终文字，断言：

```text
run_start → turn_start → message_end → tool_start → tool_end → turn_start → run_end → run_settled
```

至少检查：

- 工具调用前后顺序；
- 工具结果是否只出现一次；
- 中止后是否还有不该有的后续 turn；
- 错误有没有被正确标记。

### 9.4 测试隔离

- 使用临时目录作为工作区；
- 不读真实用户配置；
- 不访问真实模型；
- 测试结束清理临时文件；
- 不把测试产生的会话写到真实目录。

---

## 十、设计文档必须回答的六个问题

`DESIGN.md` 不需要很长，但要具体：

1. **七块怎样分工？** 每块一句话职责和一条调用关系。
2. **一次请求怎样走？** 从输入到最终输出，画时序图。
3. **为什么用树？** 回旧消息、分支、压缩、审计分别怎样受益。
4. **压缩和投影什么关系？** 用一个小例子说明摘要、原文、活动分支。
5. **工具的信任边界在哪？** 哪些动作只读，哪些有副作用，失败会怎样。
6. **为什么这样测？** 哪些用假模型，哪些必须真实集成，为什么。

再写三个取舍：

```text
取舍 1：为什么原文不删除，而是追加摘要？
取舍 2：为什么工具结果要截断？
取舍 3：为什么界面通过事件观察，而不是直接读循环内部状态？
```

每个取舍都按“问题 → 例子 → 方案 → 代价”写，不要只写结论。

---

## 十一、最终验收：不看 Pi 源码讲清楚

### 11.1 十分钟白板讲解

合上所有文档，画出：

```text
输入
  → 会话树 / 活动分支
  → 投影
  → 模型适配
  → 工具管线
  → 事件
  → 下一轮 / 结束
```

边画边讲：

1. 模型为什么不记事，系统怎样让它看起来连续；
2. 为什么回到旧消息继续会产生新分支，而不是覆盖；
3. 压缩为什么是追加摘要，不是删除原文；
4. 投影为什么不是整棵树；
5. 工具调用为什么是“提议 → 校验 → 执行 → 回填”；
6. 模型接入层为什么能把不同厂商隔在循环外；
7. 事件为什么是界面和外部程序的共同接口；
8. 为什么模型不确定，测试仍然可以确定。

### 11.2 五分钟答辩

让别人随机问：

- 如果两个工具同时写一个文件怎么办？
- 如果压缩摘要错了怎么办？
- 如果工具结果太大怎么办？
- 如果模型一直调用同一个工具怎么办？
- 如果用户在中途按了停止怎么办？
- 如果把系统提示词改了，历史会不会变？
- 如果新开一个会话，它是同一棵树的新分支吗？

你要能区分：

| 操作 | 结果 |
| --- | --- |
| 回到旧消息继续 | 同一会话文件里新增分支 |
| `/new` 或新建会话 | 新文件、新树 |
| fork / clone | 复制历史到新树，之后独立演进 |

### 11.3 真正的毕业标准

不是“代码能跑”就够了，而是：

- [ ] 能运行；
- [ ] 能中止；
- [ ] 能恢复；
- [ ] 能分支；
- [ ] 能压缩且保留原文；
- [ ] 能安全执行两个工具；
- [ ] 能从 JSON 事件观察全过程；
- [ ] 能用假模型稳定测试；
- [ ] 能解释每个设计为什么存在；
- [ ] 能说出至少三个局限和下一步。

### 11.4 最后一道自检题

如果有人把 Pi 源码全部拿走，只留下你的白纸和 mini agent，你能不能在 15 分钟内解释：

> 一个用户消息怎样变成一次模型请求；模型怎样影响真实世界；结果怎样回来；系统怎样知道该停；历史怎样分支、压缩和恢复；为什么这些部分要分开？

能，就说明你已经理解了 Agent 系统，而不是记住了某个仓库。

---

## 十二、做完之后：往哪里继续

可选进阶，不要全部一起做：

1. **扩展钩子**：加入 `beforeToolCall`、`afterToolCall`，让外部代码能拦截工具；
2. **技能/提示模板**：把重复流程从代码里拿出来；
3. **MCP**：接入一个现成外部工具服务；
4. **多 provider**：增加第二个模型适配器，验证接口是否真的中立；
5. **更好的 TUI**：学习差分渲染和输入处理；
6. **可观测性**：统计 token、工具耗时、失败率和压缩次数；
7. **持久化运行时**：崩溃后恢复、任务队列和恢复策略；
8. **评测**：用一组固定任务比较不同模型和提示词。

但无论扩展多少，始终保留那条主线：

```text
账本记录事实
  → 活动分支提供历史
  → 投影决定模型看见什么
  → 循环推动行动
  → 工具改变世界
  → 事件让外部看见
```

这就是这门课的终点，也是以后读任何 Agent 项目的起点。

---

*配套[学习路线](../learning-path/)阶段 9 · 基于 v1.3.0（`71023aec`）*
