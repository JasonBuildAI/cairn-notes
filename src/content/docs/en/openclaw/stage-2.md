---
title: "Stage 2: Entry and Agent Loop"
description: "Stage 2: Entry and Agent Loop. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: OpenClaw Source Code Class · Stage Exam
> Prerequisite: Stage 1
> Corresponding Overview: Execution part of `message-lifecycle.md`
> Stage Objective: Understand how channel ingress converges, as well as the agent loop, tool batches, steering, and follow-up.

## 1. What this stage addresses

After entering the runner, the system still faces different entry points: Telegram messages, WebChat, TUI, automated tasks. Entry differences should not change execution semantics. This stage addresses:

- Where is channel context normalized?
- Where do channel entry and `chat.send` converge?
- When does a turn continue and when does it end?
- How do tool batches run in parallel/serial?
- When steering arrives, what happens to already-started tools?
- Why can follow-up belong to the same logical execution?

## 2. Remember one judgment first

**Agent Loop is not `while(true) call model`; it is a two-layer loop of 'model turn → tool batch → safety boundary'.**

The inner layer handles tools/pending for the current turn, the outer layer handles follow-up after the turn ends; neither layer can bypass ownership of the writer/transcript.

## 3. Source Code Mainline

1. `dispatchInboundMessage()` receives channel context in `src/auto-reply/dispatch.ts:222`.
2. `finalizeInboundContext()` completes shared facts like sessionKey, sender, reply target.
3. Groups/threads first go through dedicated dispatch, then enter `dispatchReplyFromConfig()`; replies are owned by `ReplyDispatcher`.
4. Channel paths and `chat.send` paths converge in the unified agent command/embedded runner.
5. `runAgentLoop()` starts in `packages/agent-core/src/agent-loop.ts:81`; `runAgentLoopContinue()` continues existing context in `118`.
6. Both enter `runLoop()` (`140`): model flow, tool batches, `prepareNextTurn()`, follow-up, `agent_end`.
7. `executeToolCalls()` (`461`) and `executeToolCallGroups()` (`567`) handle batch admission, parallel/serial execution, steering skips, and tool result pairing.

## 4. Key Objects and Contracts

| Object | Purpose | Failure Risk |
| --- | --- | --- |
| `ctx` / finalized context | Normalize channel facts | Each downstream guesses sessionKey individually |
| `ReplyDispatcher` | Order and lifecycle of segmented replies | Model ends but reply not delivered |
| `runLoop` | Loop of one logical execution | Unbounded tool loop |
| `pendingMessages` | Steering injection | Conflicts with already-executed tools |
| `getFollowUpMessages()` | Follow-up after turn ends | Mistaken as a new run |
| tool batch | Multiple tools in one model call | Concurrency conflict/missing pairing |
| `prepareNextTurn()` | Next-round system prompt/tools adjustment | Break identity or policy |

### Inner Layer and Outer Layer

```text
Inner layer: hasMoreToolCalls || pendingMessages.length > 0
Outer layer: getFollowUpMessages()
```

The inner layer handles 'this round is not over yet'; the outer layer handles 'after this round ends, the user/system added more input'.

### Boundaries of steering

`steer` Inject the current run at a safe point: tools that have already entered the execution boundary continue to complete; calls that have not yet started can generate paired skipped/synthetic error results. It does not create a second run, nor does it forcibly interrupt tools that have already produced side effects.

## 5. An observable chain

```text
Channel ctx / chat.send
  → finalized context
  → agent command
  → runAgentLoop
  → stream model
  → tool calls
  → beforeToolBatch / policy
  → executeToolCallGroups
  → tool results
  → prepareNextTurn
  → Inner continues / Outer follow-up / agent_end
```

## 6. Experiment

### Experiment A: Tracking Entry Confluence

Chase `runAgentLoop` from `dispatchInboundMessage` and `chat.send` respectively. Acceptance criteria: able to point out the unique steps of both and the shared runner, without mistaking the channel layer for the Agent.

### Experiment B: Tool Production Cycle

Let the model consecutively call two tools that require results before proceeding. Reference acceptance: the inner layer continues the model turn after the tool results; it only exits when the termination condition is met, without looping infinitely.

### Experiment C: Midway Steering

Inject steering in batch tool execution. Acceptance criteria: tools that have been started are completed; unstarted calls are skipped and paired results are added; no isolated tool calls appear.

### Experiment D: follow-up

Add a message after the turn naturally ends. Acceptance criteria: the outer layer continues to execute the same logic through `getFollowUpMessages()` instead of immediately starting a new run.

### Experiment Reference Answers

1. Channel `dispatchInboundMessage` and `chat.send` each have their own access/load steps, but ultimately converge into the shared runner and `runAgentLoop`.
2. After the tool results are written, the inner model loop continues; it only ends when the termination condition, budget, or error is reached, and a single tool return cannot be taken as the final answer.
3. Tools that have been started complete normally; those not started call the supplement skipped/error result, maintaining call/result pairing without producing isolated tool calls.
4. After a natural termination, additional messages can continue to run the same logic through the outer `getFollowUpMessages()`, rather than immediately creating a new run.

## 7. Failure and Recovery

| Phenomenon | Root Cause | Recovery |
| --- | --- | --- |
| Model keeps tuning tools | No termination/budget boundary | Trigger loop terminate, record final state |
| Steering historical break | Unfilled skipped result | Pair results for each unexecuted call |
| follow-up lost | read-only once queue | retrieve message again at the outer boundary |
| Reply not delivered | agent_end When delivery is completed | settle ReplyDispatcher |
| Concurrency Tool Conflict | Not Following Sequential Decision | Batch-Level Serial/Reject |
| pending injection error run | ownership not verified | bind runId, illegal injection rejected |

## 8. Self-Assessment for Passing

1. What are the continuation conditions for the inner and outer loops, respectively?
2. Why do tool batches require batch-level access?
3. Why doesn't steering forcibly interrupt a tool that has already been started?
4. What else might happen after `agent_end`?
5. `prepareNextTurn()` What can `prepareNextTurn()` change, and what can it not change?
6. Where do the channel entrance and `chat.send` converge?

### Reference Answer

1. The inner layer checks whether there are still tool calls or pending/steering messages in the current turn; the outer layer checks whether there are any follow-ups after the turn ends. The former maintains the current turn, while the latter maintains the same logical execution.
2. Batch-level strategies can see the entire batch of tools: whether they can run in parallel, whether there are sequential tools, cumulative permissions/budget, duplicate conflicts, and which calls need a skipped result after steering. Single-tool validation cannot guarantee consistency across the entire batch.
3. The tools that have been started may have already produced external side effects, and a forced interruption will leave them in a partially executed state. Steering takes effect at safe points, allowing started tools to finish and performing complementary pairing results for calls that have not been started.
4. Also need to record the terminal outcome, submit/rewrite the transcript, settle the reply dispatcher, deliver the reply, update metadata, and release resources.
5. You can adjust the system prompt, toolset, or continue configuration for the next round; you cannot rewrite the run identity, bypass permissions/approvals, forge submitted history, or restore the writing rights of a previous writer.
6. Both converge at the unified agent command/embedded runner, and then enter the same `runAgentLoop()` with Session/Run semantics.

## 9. Source Code Coordinates

- `src/auto-reply/dispatch.ts`
- `src/auto-reply/reply/inbound-context.ts`
- `src/auto-reply/reply/dispatch-from-config.ts`
- `src/gateway/server-methods/chat-send-handler.ts`
- `packages/agent-core/src/agent-loop.ts`
- `packages/agent-core/src/agent-loop-steering.ts`
- `src/agents/embedded-agent-runner/runs.ts`

## 10. Next Steps

Enter Stage 3: Provide the model with context in each round of the loop. What does prompt, workspace, compaction, and pruning each modify?
