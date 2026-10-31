---
title: "Stage 1: Gateway, Session, and Run"
description: "Stage 1: Gateway, Session, and Run. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: OpenClaw Source Code Class · Stage Roll  
> Prerequisite: Stage 0  
> Corresponding Overview: Admission section of `message-lifecycle.md`  
> Goal of this Stage: Master the true semantics of chat.send acceptance, idempotency, lane, writer fence, and superseded.  

## 1. What this stage solves

The same session may simultaneously receive two requests: the user sends consecutively in WebChat, Telegram adds one, and an automated task also wakes up at the same time. The system must answer:

- Is this request a duplicate, and can the original result be reused?  
- ACK first or wait until the model finishes?  
- Are the two requests parallel or queued?  
- Who has the right to write the same segment of transcript?  
- When the old run is still alive, how does the new run take over?  
- After disconnection, cancellation, or restart, how to determine the real status of a run?  

OpenClaw places these issues at the Gateway/Session/Run layer, preventing the model from looping to resolve them on its own.

## 2. First, remember a judgment

**`chat.send` returning `in_flight` only indicates acceptance; the Session lane determines order, and the writer fence determines who has write authority.**  

Acceptance, execution, history commit, and sending replies are four different facts. Mixing them into one "success" would make offline retries, concurrent takeovers, and cancellations indeterminate.

## 3. Mainline of the source code

1. `chat-send-handler.ts` receives RPC, calls admission, and after completing idempotency/permissions/session binding, sends ACK.  
2. `chat-send-admission.ts` freezes sessionId, run authority, and idempotency record under the writer barrier, preventing concurrent replacement during preparation.  
3. `agent-run-handler.ts` starts detached agent execution; RPC disconnection does not cancel the run.  
4. `agent-command.ts` interacts with the embedded runner to handle session lane/global lane, ensuring serial per-session execution and bounded global resources.  
5. `embedded-agent-runner/run/session-bootstrap.ts` CAS compares sessionId and writes to `activeWriterRunId`.  
6. On detecting an old writer, calls supersede; the old run is terminated with `superseded` and cannot continue writing the transcript.  
7. `chat-abort-runtime.ts` handles cancellation; cancellation is an independent control fact, not equal to deleting history.

## 4. Key objects and contracts

| Object | Function | Key Invariant |
| --- | --- | --- |
| `clientRunId` | Client idempotency key | At most one acceptance/execution per key |
| `runId` | Server execution identity | Bound to events, terminal state, transcript commit |
| `sessionKey` | Routing identity | Determines which segment of logical conversation the message belongs to |
| `sessionId` | Persistent record identity | Writer CAS compares whether it changes |
| `activeWriterRunId` | Current writer | Only the new owner can write at the same time |
| lane | Concurrency control | Serial per session, global limit exists |
| terminal outcome | Run result | success/error/abort/superseded, all auditable |

### ACK status

- New acceptance: returns `in_flight`, indicating the run has been established;  
- Same idempotency key still executing: returns the existing `in_flight`, do not create a new run;  
- Terminal state already exists: return original result or explicit status;  
- Admission fails: return permission/parameter/conflict error, do not create execution.

### Writer takeover

```text
Read the current session sessionId and activeWriterRunId
  Conditionally write new runId
  → CAS Success: New run has write permission
  → Old run exists: marked superseded and stopped writing
  → CAS Failed: Reload/conflict, cannot overwrite unconditionally
```

## 5. An Observable Link

```text
chat.send
  → admission / idempotency
  → ACK in_flight
  → detached dispatch
  → sessionKey → sessionId
  → session lane
  → writer fence CAS
  → embedded runner
  → transcript commit
  → terminal outcome
  → event/reply
```

During debugging, separately record admission id, runId, sessionKey, sessionId, activeWriterRunId, and terminal outcome, to avoid looking at only one `in_flight`.

## 6. Experiment

### Experiment A: Repeating chat.send

Use the same `clientRunId` to run twice during execution. Acceptance criteria: the second time returns the `in_flight` of the same run, with no new execution or transcript commit.

### Experiment B: Concurrent in the Same Session

Different `clientRunId` are sent to the same `sessionKey` at the same time. Reference acceptance: serialized/queued by lane; two writers will not append history simultaneously.

### Experiment C: writer takeover

Construct a new run to obtain write rights while the old run has not ended. Reference acceptance: CAS updates `activeWriterRunId`, the old run receives supersede and ends with `superseded`, the old writer no longer writes.

### Experiment D: Disconnection and Reconnection

Disconnect the WebSocket after ACK, then read the run status. Reference acceptance: execution continues, and the client recovers through events/snapshots; this does not mean resubmitting a model call.

### Experiment Reference Answers

1. The second request for the same `clientRunId` should reuse the same run, returning `in_flight`, without creating a new execution or transcript commit.
2. When different `clientRunId` belong to the same session, they are serialized/queued by lane, and at any moment, only one writer can append to the history.
3. The new run updates `activeWriterRunId` through CAS; the old run is superseded, and subsequent write operations should be rejected by the writer fence.
4. ACK only indicates acceptance. After disconnection, execution continues, and the client recovers through events/snapshots, and should not resubmit model calls.

## 7. Failure and Recovery

| Phenomenon | Check First | Restore |
| --- | --- | --- |
| Client executes repeatedly | clientRunId idempotent record | Reuse the original run, do not create a new one |
| Historical Interweaving | lane and writer fence | Block old writer, repair CAS |
| run always in_flight | terminal outcome/event stream | check process/heartbeat, conclude according to recovery strategy |
| New run overrides old history | Does sessionId change | Rebind or return conflict |
| Still write after abort | Writer permission/cancel dissemination | Revoke write permission and record cancellation final state |
| ACK success but no run | admission persistence/scheduling | fix acceptance transactions, do not silently drop requests |

## 8. Self-Assessment for Passing

1. `in_flight` Why is it not completed?
2. What is the difference between `clientRunId` and `runId`?
3. Why does the same session need a lane, and what does a writer fence solve?
4. What is the significance of CAS comparison `sessionId`?
5. Why does the old writer have to explicitly `superseded`?
6. Why can't a request be resent immediately after a disconnection?

### Reference Answer

1. It only proves that the request has been accepted and can be executed; the model, tools, transcript commit, and response delivery have not yet been completed. Treating it as completed may result in a mistaken success judgment and could cause repeated execution.
2. `clientRunId` is the idempotency key for client retries, and `runId` is the internal identity of a single execution on the server. The former is used for deduplication, and the latter is used for events, terminal states, write authority, and recovery.
3. Lane controls the execution order to prevent multiple agent turns from running concurrently in the same session; the writer fence controls the rights to write history, preventing rewriting/taking over in a mixed-up order outside the execution sequence. The two solve issues at different levels.
4. `sessionId` Changes mean that the underlying persistent record has been overwritten, switched branches, or replaced. If CAS only compares the writer and ignores the sessionId, it may write the new record's id to the old record.
5. Only an explicit supersede can cause the old run to stop writing, release resources, and leave an auditable final state. Silent ignoring may still allow the old process to append to history or produce side effects.
6. A disconnected line does not mean that the server-side run is lost. Resending may create a new execution or cause conflicts; you should first query/subscribe to events by runId and confirm the final state before deciding whether to resend.

## 9. Source Code Coordinates

- `src/gateway/server-methods/chat-send-handler.ts`
- `src/gateway/server-methods/chat-send-admission.ts`
- `src/gateway/server-methods/agent-run-handler.ts`
- `src/gateway/server-methods/chat-abort-runtime.ts`
- `src/agents/embedded-agent-runner/run/session-bootstrap.ts`
- `src/agents/embedded-agent-runner/runs.ts`
- `src/agents/agent-command.ts`
- `src/agents/command/session-store.ts`

## 10. Next Steps

Entering Stage 2: The request has been accepted and write access has been obtained. How does the Agent Loop organize model output, tool invocation, steering, and follow-up into a bounded execution?
