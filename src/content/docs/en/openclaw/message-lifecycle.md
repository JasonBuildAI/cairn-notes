---
title: "OpenClaw 2026.10.9 Source Code Class · 01 The Life of a Message"
description: "Track a channel message along the main line from access approval, Agent Loop, tool approval to transcript and response."
---

> Baseline: `openclaw-2026.10.9` release archive. All paths in this article are relative to `$OPENCLAW_SRC`.
> This article follows only one real execution mainline: **how an external message becomes an Agent Run and finally returns to the original channel or UI.**
> After reading, you should be able to answer: where does the entry branch? Who owns the Session? Who is authorized to write the transcript? When does the loop stop? How is recovery handled after failure?

## One-sentence Understanding

An OpenClaw message is not 'directly thrown to the model' but goes through a pipeline with clear ownership boundaries:

```text
Channel / WebChat / TUI / Node
        │
        ▼
Entry adaptation: finalize input context or chat.send admission
        │
        ▼
Agent ingress: restore ownership → parsing model/session → select harness
        │
        ▼
Session writer fence: Only one active writer is allowed per session
        │
        ▼
Agent Loop: Model flow → tool batch → steering → next round
        │
        ▼
transcript commit / terminal outcome
        │
        ▼
ReplyDispatcher → Original Channel / UI Event
```

The most important sentence in this line is: **There can be many entry points, but there is only one set of 'Run semantics.'**

## 0. First, look at the five boundaries

To understand OpenClaw, don't start from the directory; start from the five boundaries that a message passes through:

| Boundary | Problem to Solve | Typical Code |
| --- | --- | --- |
| Entry Boundary | Which channel did the message come from? What identity, reply target, and attachments does it carry? | `src/auto-reply/dispatch.ts`, `src/gateway/server-methods/chat-send-handler.ts` |
| Admission Boundary | Is this request a duplicate? Should it be queued? Who can cancel it? | `chat-send-admission.ts`, `agent-command.ts` |
| Session Boundary | Which sessionKey / sessionId does it belong to? Who is the current writer? | `session-bootstrap.ts`, `runs.ts` |
| Execution Boundary | Which model, which harness, which tools, and how to loop? | `run-entry.ts`, `harness/selection.ts`, `agent-loop.ts` |
| Settlement Boundary | When is the run considered finished? How is the reply delivered? How are failures recorded? | `agent-runner-execution-outcome.ts`, reply dispatcher |

All subsequent source code can be tied to these five boundaries. Details that cannot be tied, don't memorize them for now.

## 1. There are actually three types of entry points

### 1.1 Channel Entry

Channels like WhatsApp, Telegram, Slack, Discord, Signal, iMessage, etc., organize inbound messages into `MsgContext`, and then call:

```ts
dispatchInboundMessage({ ctx, cfg, dispatcher, ... })
```

Location: `src/auto-reply/dispatch.ts:222`

This path concerns: **how channel messages are turned into a single reply and sent out according to the channel rhythm via `ReplyDispatcher`.**

### 1.2 Gateway Program Entry

Control UI, WebChat, mobile apps, and external programs send through Gateway WebSocket:

```json
{ "type": "req", "id": "...", "method": "chat.send", "params": { ... } }
```

The processing entry is at `src/gateway/server-methods/chat-send-handler.ts`, and the admission is at `chat-send-admission.ts`.

This path concerns: **request idempotency, immediate ACK, session binding, event pushing, and reconnection recovery.**

### 1.3 CLI / TUI Entry

`openclaw tui` (aliases `terminal`, `chat`) has two routes:

- Without `--local`: connect to an existing Gateway, following RPC like `chat.send` just like WebChat;
- With `--local`: start a local runtime within the TUI process and hold a local state lock.

Entry points: `src/cli/tui-cli.ts:26`, `src/tui/tui.ts:604`.

So TUI is not "another agent," it is just another front-end. **Interface differences should not change the core semantics of Run.**

## 2. Channel Entry: First, convert input into an "executable context"

### 2.1 finalize is not about formatting

The first thing `dispatchInboundMessage()` does is:

```ts
const finalized = finalizeInboundContext(params.ctx);
```

Location: `src/auto-reply/dispatch.ts:253`.

`finalizeInboundContext()` is at `src/auto-reply/reply/inbound-context.ts`. It completes the original channel context into a standardized form that subsequent code can rely on, such as session keys, senders, reply targets, message identifiers, etc.

The purpose of this step is not to "clean the string," but to **establish a shared source of truth for all subsequent stages**. If each downstream module guesses the sessionKey or reply target on its own, the system will soon encounter the problem of "the same sentence being split into two conversations."

### 2.2 Groups/Threads take a dedicated path first

When actually dispatching:

```ts
return (await dispatchGroupThread(request, dispatch)) ?? (await dispatch(request));
```

Location: `src/auto-reply/dispatch.ts:289`.

Order is important:

1. First determine whether it is a group chat/thread message;
2. If it is, go to `dispatchGroupThread()` first;
3. Only when it does not take over, go to the normal `dispatchReplyFromConfig()`.

This way, in group chats, the question of "whether to reply, and which thread to reply to" does not pollute the normal private chat path.

### 2.3 ReplyDispatcher is the owner of replies

`withReplyDispatcher({...})` wraps the whole dispatch, location `src/auto-reply/dispatch.ts:273`.

It is responsible for three things:

- Establish a reply queue and send lifecycle for this run;
- Deliver segmented replies in order when produced by the agent;
- Settle at the end of the run to ensure there is no "agent has finished but replies are not yet sent" dangling state.

Do not treat `ReplyDispatcher` as a simple callback. It is **the owner of concurrency and order on the output side**.

## 3. Gateway Entry: admission first, then detached execution

### 3.1 Why `chat.send` is not a synchronous wait model

WebChat cannot wait for the model to finish before returning, otherwise if the connection breaks or the page refreshes, requests and state will be lost. OpenClaw's approach is:

1. Validate parameters and session permissions;
2. Perform idempotent/deduplicated admission;
3. ACK as soon as possible;
4. Hand over the actual agent dispatch to a detached task;
5. Subsequently push progress and results through an event stream.

The comment at the top of `chat-send-handler.ts` says it very clearly: **chat.send owns admission, ACK timing, and detached dispatch handoff.**

### 3.2 The idempotent key is `chat:${clientRunId}`

In `chat-send-admission.ts`:

- Deduplication cache is written to `chat:${clientRunId}`, see `src/gateway/server-methods/chat-send-admission.ts:442`;
- If the same run is still executing, `status: "in_flight"` will be returned, see lines near `458` and `489` in the same file.

This means `clientRunId` is not a log decoration, but **the idempotent identity for client retries**. The same `clientRunId` sent repeatedly should not produce two parallel transcripts.

### 3.3 After ACK, who owns this turn

`startChatDispatch()` is at `chat-send-agent-dispatch.ts:62`. It ultimately calls:

```ts
dispatchInboundMessageWithProjectedDispatcher({ ... })
```

See `src/gateway/server-methods/chat-send-agent-dispatch.ts:315`

So the channel entry and the Web entry are not two separate agents, but rather:

- Channel: directly constructs `MsgContext` and calls `dispatchInboundMessage()`;
- Gateway: `chat.send` first performs request-level admission, then constructs the same kind of dispatch request.

The only difference is "where the input comes from and where the reply is sent"; the core Run still converges.

### 3.4 Reconnection relies on events and snapshots, not re-running the model

The Gateway's response is `res` frames, and the execution process is `event` frames. After a client disconnects and reconnects, it can re-read `chat.history` / `chat.startup` type snapshots, and then subscribe to subsequent events.

This is why `chat.send` must separate "request acceptance" from "execution completion":

- The acceptance result can be immediately persisted/broadcast;
- The execution process can gradually generate events;
- The client does not need to rely on "resending once" to restore the UI.

## 4. The two entries converge at agent ingress

### 4.1 Unified entry

Both paths ultimately enter:

```ts
agentCommandFromIngress(opts, runtime, deps)
```

Location: `src/agents/agent-command.ts:651`.

Internally calls `agentCommandFromIngressInternal()` (same file `585`), which does three key things:

1. Requires an explicit `allowModelOverride` to prevent ingress paths from silently bypassing model policies;
2. Runs under `withAgentRunLifecycleGeneration()`, binding the lifecycle code of this run;
3. Acquires recovery ownership of this execution through `runWithAgentCommandRecoveryOwner(..., mode: "claim", ...)`.

"Claim" is not optional. It ensures that the recovery/takeover of the same session does not result in two owners both thinking they should continue execution.

### 4.2 Then enter the unified agent command

The prepared parameters enter:

```ts
agentCommandInternal(prepared, { kind: "api", boundary: "agent-command.from-ingress" }, ...)
```

Location: `src/agents/agent-command.ts:617`

Here the following will be completed:

- Session / agent / workspace parsing;
- Model selection and thinking parsing;
- Session admission;
- Calling `runEmbeddedAgentAttempt()` (`agent-command.ts:464`);
- Handling fallback, compaction accounting, session persistence.

Note: `runEmbeddedAgentAttempt()` is the 'attempt layer', which internally further enters `runEmbeddedAgentEntry()`. Do not call all layers 'runner', otherwise it is easy to lose hierarchy when reading the code.

## 5. Session, Run, Writer: Don't confuse the three identities

### 5.1 The three identities

| Identity | What it answers | Lifecycle |
| --- | --- | --- |
| `sessionKey` | Whose route does this conversation belong to? | Long-term, across multiple runs |
| `sessionId` | Which is the persistent record of this conversation? | Medium-term, may change due to compaction/rewrite |
| `runId` | Which execution is this? | From one input to termination |

In `chat.send`, `clientRunId` is directly used as `runId`, but `sessionId` may come from an existing session binding. Do not treat the three as synonyms.

### 5.2 Writer fence: Only one writer per session

`prepareEmbeddedRunSession()` is preparing the session identity in `src/agents/embedded-agent-runner/run/session-bootstrap.ts:265`; the one who truly competes for writer qualification is:

```ts
claimAgentSessionWriter(params)
```

Location: `session-bootstrap.ts:523`.

Key steps:

1. Verify that the current sessionId has not changed;
2. Read the old `activeWriterRunId`;
3. Write `{ activeWriterRunId: params.runId }` in a CAS manner;
4. If the old writer exists and is not yourself, call `supersedeEmbeddedAgentRunByRunId()`;
5. Terminate the old run with `superseded`.

This solves the problem of "the user sent another one, the new run should take over" and "after restarting and recovery, the old run should not continue writing."

**Without a writer fence, both runs may write their tool results into the same transcript, causing historical contradictions.**

### 5.3 Two lanes

In `runEmbeddedAgentForSession()`:

```ts
const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
const globalLane = resolveGlobalLane(params.lane, params);
```

Location: `src/agents/embedded-agent-runner/run-orchestrator.ts:160`.

`resolveSessionLane()` at `src/agents/embedded-agent-runner/lanes.ts:10`, ensures the same session's work is serialized; `resolveGlobalLane()` at `15`, responsible for the concurrency budget of global resources/sub-agents/cron.

The two are not redundant:

- session lane prevents concurrent writes within the same conversation;
- global lane prevents the entire process from being overwhelmed by unlimited concurrency.

### 5.4 Detached Mode

Some runs are detached: they do not write persistent session metadata, nor claim outer deferral. See near `run-orchestrator.ts:164`.

This is not "low-priority execution," but **a deliberate choice to not own the persistent session lifecycle**. When reading the code and seeing `sessionPersistence === "detached"`, first ask: should this run affect the long-term session?

## 6. Model and Harness: Parse First, Then Select Executor

### 6.1 Logical Model Ref is Not a Vendor URL

`resolveModelAsync()` at `src/agents/embedded-agent-runner/model.ts:84`. It is responsible for resolving logical provider/model references into executable models, and preparing auth storage, model registry, etc.

The resolution order roughly is:

1. Explicit/config-specified model;
2. Static model directory;
3. Provider dynamic directory;
4. Combining auth profile, routing, workspace constraints.

Failure messages clearly indicate if it is "provider not authenticated," "model not in directory," "configuration bound to a certain runtime," rather than vaguely reporting "model does not exist."

### 6.2 Candidate Chain and Failure Decisions

`resolveModelCandidateChain()` at `src/agents/model-fallback-candidates.ts:155`.

The actual decision is at `src/agents/embedded-agent-runner/run/failover-policy.ts:103`, with three possible outcomes:

- `rotate_profile`: switch auth profile;
- `fallback_model`: switch model;
- `surface_error`: expose the error to the caller.

`runEmbeddedAgentEntry()` (`run-entry.ts:161`) only allows the "accepted winner" to advance the session; failed candidates do not treat partial transcripts as final results.

### 6.3 Harness is the "Executor," Not the "Model"

`selectAgentHarness()` at `src/agents/harness/selection.ts:77`. Built-in harness is `openclaw`, see `src/agents/harness/builtin-openclaw.ts:84`; its `runAttempt` calls `runEmbeddedAttempt()`.

Runtime IDs also include:

- `openclaw`: built-in embedded runner;
- `codex`: external harness accessed via `codex-app-server`;
- `auto`: selected according to config/model/account.

The significance of this step: **model integration and agent executor are two separate things.** The same model can be driven by different harnesses; the same harness can serve multiple providers.

## 7. Agent Loop: The Real Driver

The main loop is at `packages/agent-core/src/agent-loop.ts`.

### 7.1 Entry

```ts
runAgentLoop(prompts, context, config, emit, signal, streamFn, runtime)
```

Location: `agent-loop.ts:81`.

It first submits the prompt message to the context, then enters `runLoop()` (the internal function after `118` lines). `runAgentLoopContinue()` (`118`) then continues from the existing context, without resubmitting the initial prompt.

### 7.2 Double Loop

The outer `while (true)` is at `215` lines; the inner:

```ts
while (hasMoreToolCalls || pendingMessages.length > 0)
```

Location: `218` line.

These two conditions respectively represent:

- There are still tool calls/model requests to continue;
- There are still queued messages or steering that need to be injected.

Only when both are empty is it possible to exit the inner loop and then take the follow-up (`446` line).

### 7.3 What happens in one round

In the order of the source code:

1. **abort check** (`219`);
2. **submit pending/steering** (`230-237`);
3. **prepareContinuation**: allows the next round to replace systemPrompt/tools (`243-254`);
4. **inject internal steering queue** (`256-265`);
5. **`streamAgentResponse()`** call the model and stream output (`269`);
6. **batch tool execution** (`276`, finally to `executeToolCalls()` `461`);
7. **handle unexecuted terminal tool calls** (`299-322`);
8. **compute `hasMoreToolCalls`** (`329-334`);
9. **send `turn_end`** (`344`);
10. **abort/terminate/provider failure branches** (`350-388`);
11. **`prepareNextTurn()`** replaceable model/thinking/context, and decide whether to stop (`390`);
12. **follow-up drain** (`446`), if none then `agent_end` (`457`).

### 7.4 Steering boundaries

Steering is not "forcing interruption of tools at any time". The rule in the source code is:

- Check steering before execution/batch boundaries;
- Tools that have already started will not be interrupted halfway;
- Tools that have not started yet can be skipped and generate paired synthetic error/skipped result to ensure tool call and tool result still match.

Related implementations: batch logic of `executeToolCalls()`, and `completeUnstartedToolCall()` (near `agent-loop.ts:1331`).

This design is very important: **the transcript seen by the model must remain protocol-compliant.** Half-complete histories like "tool call without result" must not occur.

### 7.5 When to stop

At least five types of termination:

| Termination Reason | Trigger Point |
| --- | --- |
| Natural stop | No more tool calls, no pending, `getFollowUpMessages()` is empty |
| User abort | `stopIfAborted()` / `stopReason === "aborted"` |
| Provider failure | `message.stopReason === "error"`, `385` line |
| Tool loop recovery termination | `executedToolBatch.terminateRun`, `362` line |
| Next-round policy stop | `prepareNextTurn().stop` or `shouldStopAfterTurn()`, `418-443` |

"Model has finished speaking" is just one of them, not the only condition.

## 8. Context is not a single string

The context of one model request is composed of at least four layers:

1. **system prompt**: identity, rules, tool directory, skill directory, runtime information;
2. **workspace bootstrap**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`, `MEMORY.md`;
3. **transcript**: historical messages and tool results;
4. **dynamic injection this round**: steering, system updates, compaction summary.

System prompt is built at `src/agents/system-prompt.ts:284`; bootstrap at `src/agents/bootstrap-files.ts:397`.

### 8.1 Bootstrap has hard limits

Configuration description at `src/config/schema.help.models.ts:152-155`:

- A single file defaults to a maximum of `20000` characters;
- All bootstrap files combined default to a maximum of `60000` characters.

Exceeding this will be truncated, and `src/agents/bootstrap-budget.ts:122` generates a budget diagnostic. Sub-agents by default only inject `AGENTS.md` to avoid copying all of the main agent's personality files to each subtask.

### 8.2 Compaction and pruning are not the same

- **Compaction**: when the context approaches the window, old history is summarized and written back to the transcript; implemented in `packages/agent-core/src/harness/compaction/compaction.ts`.
- **Cache-TTL pruning**: only trims the "projection sent to the model", without modifying the disk transcript; implemented in `src/agents/embedded-agent-runner/tool-result-truncation.ts`.

This distinction is key to reading OpenClaw's context mechanism. The former changes history, the latter only changes the current view.

## 9. Tools: assembly, admission, approval, execution

### 9.1 Tools are assembled

`assembleOpenClawCodingTools()` In `src/agents/agent-tools.ts:97`, it is organized in the following hierarchy:

- capability / tool profile;
- workspace and sandbox policy;
- core coding tools (`createCoreCodingTools()`, `src/agents/core-coding-tools.ts:202`);
- OpenClaw proprietary tools;
- plugin tools;
- channel tools;
- final authorization.

`createOpenClawCodingToolsInternal()` In `agent-tools.ts:630`, the asynchronous version is in `642`.

**Tools are not a static list.** The same phrase 'read file' may have different implementations depending on the surface, sandbox, and approval policy.

### 9.2 The order of before_tool_call is behavioral

`src/agents/agent-tools.before-tool-call.policy.ts` The file header clearly specifies the order:

1. loop admission;
2. owner probes;
3. voice confirmation;
4. trusted policies;
5. approvals;
6. normal hooks;
7. final owner approval.

This is not 'coding style,' but a security semantics matter. Putting approval after hooks could allow malicious or faulty hooks to change parameters and bypass approval.

### 9.3 Approval modes

`resolveBeforeToolCallApprovalOutcome()` In `agent-tools.before-tool-call.approval.ts:470`, supporting:

- `defer`: postpone approval until execution boundary;
- `report`: report only, do not block;
- `deny`: directly deny;
- `request`: request human approval immediately.

Non-interactive surfaces may directly deny, rather than wait indefinitely. This reflects 'different channel capabilities, but the same security baseline.'

## 10. Settlement: run finished does not equal reply delivered

### 10.1 Unified recording of terminal outcome

`runAgentTurnWithOutcome()` In `src/auto-reply/reply/agent-runner-execution-outcome.ts:96`.

It does three things:

1. Bind `runId/sessionKey/sessionId/agentId` using `withExecRequestTurn()` (`110`);
2. Execute the actual turn;
3. Record `recordAgentTurnExecutionOutcome()` (`125`) and publish terminal event (`127`).

Exceptional paths also record a failed outcome once (`130-133`), preventing 'run disappears but without termination fact.'

### 10.2 Two layers of 'ending'

- **Agent Run Ended**: `agent_end` event, terminal outcome persisted;
- **Reply Delivery Ended**: `ReplyDispatcher` settle, channel sending completed.

The two should not be mixed. A run may have already `agent_end`, while the reply is still queued; or reply sending may fail, although the agent has ended normally. When troubleshooting, determine which layer is stuck first.

## 11. Failure Matrix

| Phenomenon | Most Likely Location | First check |
| --- | --- | --- |
| The same request generates two turns | `chat.send` idempotency | `clientRunId` stability, `chat:${clientRunId}` hit or not |
| New message overrides old run | writer fence | `activeWriterRunId`, `superseded` events |
| Model error without fallback | failover decision | `resolveRunFailoverDecision()`, candidate chain empty?
| Tool keeps waiting for approval | approval chain | `approvalMode`, is surface interactive, timeout |
| Agent ended but UI shows no message | reply dispatcher | terminal event after `runAgentTurnWithOutcome()`, dispatcher settle |
| Old tasks continue writing after restart | ownership recovery | recovery owner's claim, lifecycle generation |
| Context suddenly shortens | compaction | is summary written back, cut point location |
| Tool result disappears but transcript remains | cache-TTL pruning | current prompt projection, not disk history |

## 12. Debug recipe

Execute in the source code root directory:

```powershell
rg -n "chat\.send|admitChatSend|chat:\$\{clientRunId\}" src/gateway
rg -n "claimAgentSessionWriter|activeWriterRunId|superseded" src/agents
rg -n "agentCommandFromIngress|runEmbeddedAgentAttempt|runEmbeddedAgentEntry" src/agents
rg -n "streamAgentResponse|prepareNextTurn|agent_end" packages/agent-core/src/agent-loop.ts
rg -n "recordAgentTurnExecutionOutcome|terminal" src/auto-reply
```

It is recommended to read the logs in the following order:

1. First find `clientRunId`: confirm whether it is the same request;
2. Then find `sessionKey/sessionId`: confirm whether sessions are mixed;
3. Then find `activeWriterRunId`: confirm whether it has been taken over;
4. Then find `provider/model` and the fallback step: confirm whether the model has switched;
5. Finally find `turn_end` / `agent_end` / reply settle: confirm whether it is stuck in a loop or producing output.

## 13. Common Misunderstandings

**Misunderstanding 1: Channel messages go directly into the model.**
Wrong. First, finalize the input context, then go through reply configuration, session admission, and tool/model assembly.

**Misunderstanding 2: `chat.send` returning success means the model has finished running.**
Wrong. It first ACKs acceptance; actual execution is through detached dispatch, with results relying on event flow and snapshots.

**Misunderstanding 3: `sessionKey` and `sessionId` are the same thing.**
Wrong. The former is routing identity, the latter is persistent record identity; compaction/rewrite may change the latter.

**Misunderstanding 4: writer fence only prevents duplicate writes.**
Not only that. It also defines a legitimate way for a new run to take over an old run; the old run must terminate with `superseded`.

**Misunderstanding 5: compaction and pruning both delete history.**
Only compaction rewrites the transcript; pruning only modifies the current prompt projection.

**Misunderstanding 6: tool approval is part of the plugin hook.**
The approval chain happens before normal hooks and has an independent owner/final release stage.

## 14. Self-Test and Practice

### Self-Test

1. Draw the convergence points of the channel entry and `chat.send` entry, and mark the unique steps for each.
2. Explain the differences among `clientRunId`, `sessionKey`, `sessionId`, and `runId`.
3. Why does `chat.send` need to ACK first? What happens if it doesn't during a reconnect?
4. When the writer fence finds an old writer, why must the old run be terminated with `superseded` instead of being silently ignored?
5. What are the two continuation conditions in the inner loop of the Agent Loop? Who fulfills each?
6. When steering arrives, why can't the already executing tool be forcibly interrupted?
7. What do compaction and cache-TTL pruning modify respectively? Who owns each?
8. What may happen after `agent_end`?

### Practice

- In `chat-send-admission.ts`, find all return points of `in_flight` and draw a "duplicate request state machine".
- In `session-bootstrap.ts`, track a writer takeover and write out the termination path of the old run.
- In `agent-loop.ts`, label the termination reason for each `return newMessages`.
- Choose a tool, trace it from `agent-tools.ts` to the actual execution function, and mark the policy/approval layers it passes through.
- Intentionally create a provider error, observe the fallback events, and see whether the final session only advances once.

---

### Self-Test Answer Key

1. **Channel Entry**: `dispatchInboundMessage` → `finalizeInboundContext` → Cluster/thread-specific branch → `dispatchReplyFromConfig` → Unified agent command; Unique features include channel context normalization and `ReplyDispatcher` output. **Gateway Entry**: `chat.send` → Parameters/Permissions/Idempotent Access → ACK → detached dispatch → unified agent ingress; Unique features include WebSocket connection, event push, and disconnection recovery. The two lines merge at agent command/embedded runner, and the session remains owned by the Gateway. 
2. `clientRunId` is the client-retried identities; `sessionKey` is the routing identity of the gateway, determining which conversation the message goes to; `sessionId` is the persistence record identity, which may change after compaction/rewrite; `runId` is the identity of a single execution, usually derived from `clientRunId`, but with different meanings. 
3. Because model execution can take a long time, connection disconnection or page refresh cannot discard the request together. First, ACK turns the request into a recoverable accepted fact, executes detached, and continues; The client uses events and snapshots to recover. If the model is synchronously waiting, after disconnection, there is no stable acceptance credential, and retries may repeat the process. 
4. The old writer must be explicitly terminated with `superseded` to make the "single writer" auditable: the old run cannot add transcripts, and resources can be released in the terminal state. Silent ignoring causes the old process to continue writing, causing interleaved or repeated side effects, and it is impossible to determine who owns the final state. 
5. Inner layer: `hasMoreToolCalls || pendingMessages.length > 0`, filled by tool batch and messages to be injected; Outer layer: `getFollowUpMessages()`, filled by follow-up added by users at the run end boundary, so that supplementary messages still belong to the same logic execution. 
6. Started tools may have already experienced external side effects; forcibly interrupting will leave a semi-execution state; Steering only takes effect at security checkpoints, allowing the already started tool to complete; calls that have not yet started generate `skipped`/synthetic error, thus maintaining tool call/result pairing. 
7. **compaction** Rewrites the historical structure and writes a summary, with the compaction mechanism in harness/`packages/agent-core` as the owner; **cache-TTL pruning** Only changes the tool result projection for the next request, with the truncation layer of the embedded-agent runner as the owner, and the disk transcript remains unchanged.
8. `agent_end` After this, there are: terminal outcome record, transcript commit, ReplyDispatcher settle/send, session/lifecycle metadata update and resource release. A model stop only means the loop ends, not that the reply has been delivered. 

### Practice Reference Methods

- **`in_flight` State Machine**: No deduplication records → admitted and entered in-flight; Same `clientRunId` In in-flight →, it returns in-flight directly, no longer creating run; Terminal record exists → returns the original result; Only records expired/missing → are allowed to be re-entered. The acceptance point is that the same idempotency key can generate at most one execution and one transcript. 
- **writer takeover**: Read the old `activeWriterRunId` → condition: CAS writes the new runId; CAS failure indicates the session has changed or has a concurrent claim, which should be reread and retried or return for conflicts; unconditional override is not possible. After success, call supersede on the old run, ending the old run with `superseded`. 
- **`return newMessages` Annotations**: At least distinguish between natural no work, abort, provider error, tool-loop terminate, strategy stop, superseded; For each, specify which layer is responsible for terminal state and cleanup. 
- **Tool Tracing**: Records capability/profile → tool policy/approval → sandbox/executor from `agent-tools` assembly points, and finally asserts that reject, skip, and success can all result into matching tool results. 
- **Provider fallback**: Observe whether `rotate_profile` or `fallback_model`; Failed candidate assistant errors must not contaminate the final transcript; Only accepted candidates can advance the session. 

*OpenClaw 2026.10.9 · A Lifetime of a Message*
