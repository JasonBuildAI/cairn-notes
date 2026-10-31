---
title: "Stage 2: Agent Loop"
description: "Understand why the Agent loop, event flow, cancellation, and resumption must be designed together."
---

> **Position in this stage**: Stage 1 has already gone through the complete request. Now, let's extract the most critical middle part separately: how models and tools are orchestrated into a loop that can automatically progress, be interjected, and be halted.  
> **Source code directory**: `$PI_SRC`. Core code: `packages/agent/src/agent.ts`, `packages/agent/src/agent-loop.ts`.  
> **Prerequisite concepts**: run, turn, event flow, tool result backfill.  
  
## I. First, let's answer a question: why is a 'loop' needed?  

If you only ask the model once, it can only return a piece of text. Real coding tasks often require:  

1. Reading files;  
2. Searching for call points based on the content read;  
3. Modifying code;  
4. Running tests;  
5. Continuing to fix based on test results.  

The model cannot execute these actions by itself. Pi must turn the 'model's tool requests' into real actions, then feed the results back to the model so it can continue making decisions.  

But the model's requests themselves are stateless: **the model doesn't automatically remember what the last tool execution did.** Tool results must be sent as a new message and enter the context of the next request. Hence, the loop arises:

```text
Request model
  Does the model need tools?
       Do not: End this turn
       └─ Need: Execute tool → Return the result to the context → Then request the model
```

This is the key distinction between an Agent and an ordinary chatbot: **An Agent does more than generate responses; it continuously takes actions based on environmental feedback.**

---

## 2. Two Core Concepts: Turn and Run

| Concept | Definition | Intuitive Understanding |
| --- | --- | --- |
| Turn | One model response, plus all tool calls and results requested by this response | One "action round" |
| Run | An entire execution starting from an input until the system confirms that no further automatic work will be done | One complete task |

A run usually contains multiple turns:

```text
run
├─ turn 1: The model is required to read the file
│    └─ The tool returns the file content
├─ turn 2: The model requires searching for call points
│    └─ The tool returns search results
├─ turn 3: The model requires code modification
│    └─ The tool returns the modification results
└─ turn 4: The model provides the final explanation (without tool usage)
```

Note: **A turn does not end when the model finishes speaking, but when both 'the model responds' and 'the tool it requests is executed' are completed.** This is also why a single user input may correspond to many model requests.

---

## 3. Two-layer structure of the loop

Pi's `runLoop` is not a simple `while (true)`; it has two layers, inner and outer, which handle different things.

### 3.1 Inner layer: advancing the current task

The inner layer is responsible for:

- Merging pending steering messages into the conversation;
- Preparing requests and calling the model;
- Executing tools;
- Writing tool results back into the context;
- Determining whether another round is needed.

It can be simplified as:

```text
Inner while (has tool call or has queued message):
  Prepare request
  Request model
  Execution tool
  Result included in the list
  Take the steering again
```

### 3.2 Outer Layer: Handling "Things After Finishing the Current Task"

Exiting the inner layer indicates that "this batch of work is temporarily done." But this does not mean the entire run is over, because there may still be **follow-up** messages:

```text
Outer while:
  Run the inner layer
  Inner exit
  Any follow-up? ── Yes ──► Go back to the inner layer and continue
  No ───────────────► agent_end
```

### 3.3 A Complete State Machine

```text
                        ┌──────────────────────┐
                        │   run start           │
                        └──────────┬───────────┘
                                   ▼
                    ┌──────────────────────────┐
                    │ Inner layer: Prepare request / call model │
                    │       Execution Tool / Backfill    │
                    └──────────┬───────────────┘
                               │
                    Is there also tool invocation or steering?
                      │ is │ or not
                      └──────► Continue       ▼
                                  Inner exit
                                       │
                            Any follow-up news?
                              │ is │ or not
                              └─► Return to inner layer   ▼
                                        agent_end
```

---

## 4. Three Control Inputs: steer, follow-up, abort

Agent is not "once you submit a task, you can only wait for it to finish." Pi provides three control methods, but their semantics are completely different.

### 4.1 Steering: Intervene Midway, Go In as Soon as Possible

**Scenario**: The model is reading a file, and you say, "By the way, check the test directory."

A Steering message does not interrupt the reply currently being generated; it merges before the next request after the current assistant turn ends. It can be understood as a "detour":

- Complete the current reply first;
- Your addition enters the context as a new user message;
- The model continues working with the new requirement.

In code, `getSteeringMessages()` checks at the start of a run, at turn boundaries, and after some longer preparation stages. This way, even if the model is performing a time-consuming operation, your addition will not be stuck in the queue forever.

**In one sentence**: steer means "I add a new direction while the work isn't finished yet."

### 4.2 Follow-up: Start a New Task After the Current Work Converges

**Scenario**: The Agent has fixed a bug, and you want it to "write a summary afterwards."

Follow-up does not insert in the middle of the current task; it is checked only after the inner process exits and the Agent is ready to stop:

- The current task finishes naturally;
- Then the follow-up starts;
- It is suitable for "the next thing," not "an addition to the current work."

**In one sentence**: follow-up means "finish what you are doing first, then do this."

### 4.3 Abort: Stop the Current Run

When the abort button is pressed, the real system performs a series of finalizations rather than simply killing the process:

- The model reply being generated is interrupted, and the message is finalized with `aborted`;
- Tools not yet started will not launch;
- Tools currently executing receive a cancel signal; already occurred side effects are not automatically rolled back;
- Steering/follow-up messages in the queue will be restored to the editor as much as possible;
- Automatic retries or task compression are canceled;
- Finally, `agent_settled { aborted: true }` is emitted.

A necessary reality to acknowledge: **Abort means "stop continuing work," not "undo what has already happened."** If files have changed or commands have been executed, you must rely on version control, containers, or approval policies for protection.

---

## 5. Turn Boundaries and Event Order

In a typical multi-turn execution, the event sequence roughly is:

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
    ...(next round)
  turn_end
agent_end
agent_settled
```

Boundaries to Remember:

- `turn_start` indicates the start of a round, immediately followed by preparation for a request;
- `turn_end` indicates that both the model's response and the tool results for this round are complete;
- As long as a tool was executed in this round and no termination hook was triggered, the next round usually continues;
- Ordinary steering/follow-ups are handled within the underlying loop first, and only then is `agent_end` issued; beyond that, there may still be retries, compressed recovery, or tasks queued by the `agent_end` processor;
- `agent_settled` is the true endpoint of "no automatic work."

### Some special stopReasons

| stopReason | Meaning | Pi's Handling |
| --- | --- | --- |
| `stop` | Normal end | Check tool calls and queue |
| `length` | Output reached token limit | Tool parameters may be incomplete, the whole batch of tools is not executed |
| `error` | Model or network error | This round ends, leaving it to the upper level to decide whether to retry |
| `aborted` | User abort | Current run stops, queued messages return to the editor |

Especially `length`: If the model output is truncated, you cannot gamble that "previous tool parameters are still usable." Pi will reject the entire batch call and let the model initiate again.

---

## 6. Why does tool execution automatically continue?

This is not magic from a specific tool, but a loop condition:

```text
Is there a tool call in this round?
  ├─ has → execution tool → tool results enter context → next round
  └─ No → check steering / follow-up → stop if none
```

For the model to see the tool results, it must send another request. Thus, the "tool results" naturally become the input for the next round.

Exactly because of this, the loop must have a stopping condition:

- The model no longer calls the tool;
- There are no queued messages;
- The user aborts;
- An extension hook actively terminates the entire batch of tools;
- An error occurs or the request is aborted.

Without these boundaries, a model that "keeps calling tools" would loop indefinitely.

---

## 7. Writing a Minimal Agent Loop

At first, don't focus on engineering details. Write a 30–50 line version to understand the skeleton:

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

This piece of code only expresses three things:

1. When the model has a tool request, execute the tool;
2. The tool result goes back to the message list;
3. Exit if there is no tool request.

Then compare item by item with the real Pi:

| Minimal version | Pi |
| --- | --- |
| `fakeModel` | Provider adapter layer of `ai` and `streamFn` |
| `messages` | Current context and projection results |
| Execute tool | `executeToolCalls`, including validation, permissions, parallel/serial, events |
| Tool result enqueued | `toolResult` messages and persistence |
| `break` | After inner exit, check follow-up |
| Not written | Abort, retry, compression, steering, events, UI |

### Two small experiments suggested

1. Make a fake model always request a tool: observe an infinite loop, and give it a maximum step count or stop condition;
2. Make a fake model first request a tool, then return text: observe why it goes through two turns.

These two experiments will help you understand the loop more than memorizing ten lines of source code.

---

## 8. Common Misunderstandings

| Misunderstanding | Correct Understanding |
| --- | --- |
| "When the model reply ends, the turn ends." | You have to wait for the tools requested by this reply to execute before the turn is considered complete |
| "Tool results are automatically seen by the model." | The model is stateless, the result must be put into the next request as a message |
| "Steering will interrupt the model's current output." | No, it gets merged after the current assistant turn |
| "Follow-up and steering are the same." | One redirects quickly, the other continues after current work converges |
| "agent_end means the entire task is done." | Normal follow-ups are handled in the underlying loop; after that, automatic retry, compressed recovery, or new work by `agent_end` processor may occur, see `agent_settled` |
| "Abort rolls back tool side effects." | No; file and command changes that have occurred still exist |

---

## 9. Self-Check

Answer with the previous document in mind:

1. What are the boundaries of a turn and a run?
2. Why does the next round automatically start after tool results return?
3. What is the difference between steering and follow-up?
4. During abort, what happens to tools being executed and queued messages?
5. Why does `stopReason: length` reject tool calls in batches?
6. What is the difference between `agent_end` and `agent_settled`?

Suggested deliverables:

- [ ] A state machine including steering, follow-up, and abort;
- [ ] A minimal loop code of 30–50 lines;
- [ ] A real JSON event stream, indicating `turn_start`, `turn_end`, and `agent_end`;
- [ ] Explain in 3 minutes "why the Agent needs a loop instead of a single model call."

The next step is Stage 3: rebuilding context for each loop. Where exactly does the "context" come from, how it is compressed, and why is the original text still there after compression? See [Stage 3](../stage-3/).

---

*Supporting [Learning Path](../learning-path/) Stage 2 · Based on v1.3.0 (`71023aec`)*
