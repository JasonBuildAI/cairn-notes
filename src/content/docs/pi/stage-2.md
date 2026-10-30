---
title: "阶段 2：Agent 循环"
description: "理解 Agent 循环、事件流、取消与恢复为什么必须一起设计。"
---

> **本阶段的位置**：阶段 1 已经看过完整请求。现在把中间最关键的一段单独拆开：模型和工具如何被编排成一个能自动推进、可插话、可中止的循环。
> **源码目录**：`$PI_SRC`。核心代码：`packages/agent/src/agent.ts`、`packages/agent/src/agent-loop.ts`。
> **前置概念**：run、turn、事件流、工具结果回填。

## 一、先回答一个问题：为什么需要“循环”？

如果只问模型一次，它只能返回一段文字。现实的 coding 任务往往需要：

1. 读文件；
2. 根据读到的内容搜索调用点；
3. 修改代码；
4. 运行测试；
5. 根据测试结果继续修。

模型不能自己执行这些动作。Pi 必须把“模型的工具请求”变成真实动作，再把动作结果送回模型，让它继续判断。

但模型请求本身是无状态的：**模型不会自动记得上一次工具执行了什么。** 工具结果必须作为一条新消息，进入下一次请求的上下文。于是就有了循环：

```text
请求模型
  → 模型要工具？
       ├─ 不要：本轮结束
       └─ 要：执行工具 → 结果回到上下文 → 再请求模型
```

这就是 Agent 与普通聊天机器人的关键分界线：**Agent 不只是生成回答，它会根据环境反馈持续采取行动。**

---

## 二、两个核心概念：turn 与 run

| 概念 | 定义 | 直观理解 |
| --- | --- | --- |
| Turn | 一次模型回复，加上这次回复要求的全部工具调用和结果 | 一个“行动回合” |
| Run | 从一次输入开始，到系统确认没有自动工作为止的一整段执行 | 一次完整任务 |

一个 run 通常包含多个 turn：

```text
run
├─ turn 1：模型要求读文件
│    └─ 工具返回文件内容
├─ turn 2：模型要求搜索调用点
│    └─ 工具返回搜索结果
├─ turn 3：模型要求修改代码
│    └─ 工具返回修改结果
└─ turn 4：模型给出最终说明（无工具调用）
```

注意：**turn 不是在模型说一句话时结束，而是在“模型回复 + 它要求的工具执行”都完成时结束。** 这也是为什么一次用户输入可能对应很多次模型请求。

---

## 三、循环的两层结构

Pi 的 `runLoop` 不是一个简单的 `while (true)`；它有内外两层，分别处理不同的事情。

### 3.1 内层：推进当前任务

内层负责：

- 把待处理的 steering 消息并入对话；
- 准备请求并调用模型；
- 执行工具；
- 把工具结果写回上下文；
- 判断是否还要再来一轮。

可以简化成：

```text
内层 while（有工具调用 或 有排队消息）：
  准备请求
  请求模型
  执行工具
  结果入列
  再取 steering
```

### 3.2 外层：处理“干完当前活之后”的事情

内层退出，表示“当前这批工作暂时做完了”。但这不代表整个 run 结束，因为可能还有 **follow-up** 消息：

```text
外层 while：
  跑内层
  内层退出
  有 follow-up？──有──► 回到内层继续
  没有 ───────────────► agent_end
```

### 3.3 一张完整状态机

```text
                        ┌──────────────────────┐
                        │   run 开始           │
                        └──────────┬───────────┘
                                   ▼
                    ┌──────────────────────────┐
                    │ 内层：准备请求 / 调模型  │
                    │       执行工具 / 回填    │
                    └──────────┬───────────────┘
                               │
                    还有工具调用或 steering？
                      │是                 │否
                      └──────► 继续       ▼
                                  内层退出
                                       │
                            有 follow-up 消息？
                              │是          │否
                              └─► 回内层   ▼
                                        agent_end
```

---

## 四、三个控制插口：steer、follow-up、abort

Agent 不是“提交任务后只能等它做完”。Pi 提供了三种控制方式，但它们的语义完全不同。

### 4.1 Steering：中途插话，尽快并进去

**场景**：模型正在读文件，你说“顺便检查一下测试目录”。

Steering 消息不会打断正在生成的回复，而是等当前 assistant turn 结束后，在下一轮请求前并入。可以理解为“改道”：

- 当前这次回复先完成；
- 你的补充作为新的用户消息进入上下文；
- 模型带着新要求继续工作。

代码上，`getSteeringMessages()` 会在 run 开始时、turn 边界以及一些较长的准备阶段之后检查。这样即使模型正在做一个耗时操作，你的补充也不会永远卡在队列里。

**一句话**：steer 是“工作还没结束时，我补充一个新方向”。

### 4.2 Follow-up：等当前工作收敛后再接新任务

**场景**：Agent 修完一个 bug，你想让它“做完之后顺便写一份总结”。

Follow-up 不会在当前任务中间插进去，而是在内层退出、Agent 本来准备停止时，才被检查：

- 当前任务先自然做完；
- 再开始处理 follow-up；
- 它适合“下一件事”，而不是“当前这件事的补充”。

**一句话**：follow-up 是“你先把手上活干完，然后再做这个”。

### 4.3 Abort：停止当前 run

按下中止键时，真实系统会做一系列收尾，而不是简单地把进程杀掉：

- 正在生成的模型回复被中断，消息以 `aborted` 定稿；
- 尚未启动的工具不再启动；
- 正在执行的工具会收到取消信号；已经发生的副作用不会自动回滚；
- 排队中的 steering / follow-up 消息会尽量恢复到编辑器；
- 自动重试或压缩任务会被取消；
- 最后发出 `agent_settled { aborted: true }`。

一个必须建立的现实认知：**中止是“停止继续工作”，不是“撤销已经发生的事”。** 文件已经改了，命令已经跑了，就要靠版本控制、容器或审批策略来保护。

---

## 五、turn 的边界与事件顺序

一次典型的多 turn 执行，事件顺序大致是：

```text
agent_start
  turn_start
    message_start(user)
    message_end(user)
    message_start(assistant)
    message_update / text_delta
    message_end(assistant)
    tool_execution_start
    tool_execution_update
    tool_execution_end
    message_end(toolResult)
  turn_end
  turn_start
    ...（下一轮）
  turn_end
agent_end
agent_settled
```

需要记住的边界：

- `turn_start` 表示一轮开始，紧接着准备请求；
- `turn_end` 表示本轮模型回复和工具结果都已完成；
- 只要本轮执行了工具且没有触发终止钩子，下一轮通常会继续；
- 普通的 steering / follow-up 已在底层循环内处理完，之后才发出 `agent_end`；再往后还可能有重试、压缩恢复或由 `agent_end` 处理器排入的工作；
- `agent_settled` 才是“没有自动工作”的终点。

### 几个特殊 stopReason

| stopReason | 含义 | Pi 的处理 |
| --- | --- | --- |
| `stop` | 正常结束 | 检查工具调用和队列 |
| `length` | 输出达到 token 上限 | 工具参数可能残缺，整批工具不执行 |
| `error` | 模型或网络错误 | 本轮结束，交给上层决定是否重试 |
| `aborted` | 用户中止 | 当前 run 停止，排队消息回到编辑器 |

尤其是 `length`：如果模型输出被截断，不能赌“前面的工具参数还能用”。Pi 会拒绝整批调用，让模型重新发起。

---

## 六、为什么工具执行后会自动继续？

这不是某个工具的魔法，而是循环条件：

```text
本轮有工具调用吗？
  ├─ 有 → 执行工具 → 工具结果进入上下文 → 下一轮
  └─ 无 → 检查 steering / follow-up → 没有就停
```

模型想看到工具结果，必须再发一次请求。于是“工具结果”自然成为下一轮的输入。

也正因为如此，循环必须有停止条件：

- 模型不再调用工具；
- 没有排队消息；
- 用户中止；
- 扩展钩子主动终止整批工具；
- 发生错误或请求被中止。

没有这些边界，“一直调用工具”的模型会无限循环。

---

## 七、写一个最小 Agent Loop

先不要追求工程细节，写一个 30–50 行的版本，理解骨架即可：

```typescript
type Message = { role: "user" | "assistant" | "tool"; content: string };

async function miniAgent(userText: string) {
  const messages: Message[] = [{ role: "user", content: userText }];

  while (true) {
    const reply = await fakeModel(messages);
    messages.push({ role: "assistant", content: reply.content });

    const calls = reply.toolCalls ?? [];
    if (calls.length === 0) break;

    for (const call of calls) {
      const result = await fakeTool(call.name, call.args);
      messages.push({
        role: "tool",
        content: `${call.name}: ${result}`,
      });
    }
  }

  return messages;
}
```

这段代码只表达三件事：

1. 模型有工具请求时，执行工具；
2. 工具结果回到消息列表；
3. 没有工具请求时退出。

然后逐项对照真实 Pi：

| 最小版本 | Pi |
| --- | --- |
| `fakeModel` | `ai` 的 provider 适配层和 `streamFn` |
| `messages` | 当前上下文与投影结果 |
| 执行工具 | `executeToolCalls`，包含校验、权限、并行/串行、事件 |
| 工具结果入列 | `toolResult` 消息与持久化 |
| `break` | 内层退出后检查 follow-up |
| 没有写 | 中止、重试、压缩、steering、事件、UI |

### 建议做的两个小实验

1. 让假模型永远请求工具：观察死循环，并给它加一个最大步数或中止条件；
2. 让假模型先请求工具、再返回文本：观察为什么会经过两个 turn。

这两个实验比背十行源码更能让你理解循环。

---

## 八、常见误区

| 误区 | 正确理解 |
| --- | --- |
| “模型回复结束，turn 就结束了。” | 还要等这次回复请求的工具执行完，才算一个 turn |
| “工具结果会自动被模型看到。” | 模型无状态，必须把结果作为消息放进下一次请求 |
| “steering 会打断当前模型输出。” | 不会，它在当前 assistant turn 后并入 |
| “follow-up 和 steering 是同一件事。” | 一个是尽快改道，一个是当前工作收敛后再接任务 |
| “agent_end 就是整个任务结束。” | 普通 follow-up 已在底层循环内处理完；之后还可能自动重试、压缩恢复或由 `agent_end` 处理器排入新工作，看 `agent_settled` |
| “中止会回滚工具副作用。” | 不会；已发生的文件和命令改动仍然存在 |

---

## 九、通关自检

先合上文档回答：

1. turn 和 run 的边界分别是什么？
2. 为什么工具结果回来后会自动开始下一轮？
3. steering 和 follow-up 的区别是什么？
4. 中止时，正在执行的工具和排队消息分别怎样？
5. `stopReason: length` 为什么要整批拒绝工具调用？
6. `agent_end` 和 `agent_settled` 有什么区别？

建议产出：

- [ ] 一张包含 steering、follow-up、abort 的状态机；
- [ ] 一份 30–50 行的最小循环代码；
- [ ] 一条真实 JSON 事件流，能标出 `turn_start`、`turn_end` 和 `agent_end`；
- [ ] 用 3 分钟解释“为什么 Agent 需要循环，而不是一次模型调用”。

下一站是阶段 3：循环每一轮都要重建上下文。那份“上下文”到底从哪里来、怎么压缩、为什么压缩后原文还在？见[阶段 3](../stage-3/)。

---

*配套[学习路线](../learning-path/)阶段 2 · 基于 v1.3.0（`71023aec`）*
