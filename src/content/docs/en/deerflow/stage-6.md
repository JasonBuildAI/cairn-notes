---
title: "Stage 6: Persistence and Recovery"
description: "Stage 6: Persistence and Recovery. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: DeerFlow Source Code Class · Stage Exam
> Prerequisites: Stages 1, 3, 4
> Corresponding Overview: `core-mechanisms.md` and `engineering.md`
> Goal of this stage: Accurately determine which facts have been committed, which actions can only be compensated, and which must never be redone, in cases of crashes, cancellations, lease losses, and delivery failures.

## 1. What this stage addresses

A Run writes several types of states at the same time:

~~~text
RunStore       Control plane: status, owner, lease, idempotent key
Checkpoint     Execution surface: LangGraph Graphic state
Event Store    Observation aspect: chronological events, playback
RunJournal     Operating Ledger: tokens, tools, delivery facts
Product surface: workspace files and delivery path
~~~

They are not redundant copies, but answers to different questions. During recovery, it is necessary first to determine which type of facts are missing.

## 2. Remember this judgment first

**Evidence comes first, then the final state.**

DeerFlow deliberately writes the delivery receipt first and then the success state to eliminate the window where "the page shows success but the evidence is not persisted." Success without a receipt is not success; it is just the model saying something.

## 3. Mainline of the source code

1. `RunRecord` saves `status`, `owner_worker_id`, lease-related fields, idempotency keys, and control flags.
2. `RunManager.create_or_reject` atomic registration; `try_start` conditional migration; `set_finalizing` enter final state exclusive zone.
3. `worker.run_agent` read the last checkpoint before starting, and roll back to pre-run state if necessary.
4. `RunJournal` collects models, tools, tokens, and delivery events as a callback handler.
5. `StreamBridge` sends real-time events to SSE; the event store provides persistence and replay.
6. The checkpointer saves the graph state; the checkpoint mode determines full/delta channel compatibility.
7. Heartbeat and orphan recovery handle worker disconnection and leftover runs.
8. During closure, first verify deliveries, write receipts, then complete the final state and release resources.

## 4. Key objects and contracts

| Fact | Source of Fact | Recovery Use |
| --- | --- | --- |
| Who is running | `RunRecord.owner_worker_id` / lease | Prevent dual workers |
| How far it has run | checkpoint | Resume graph state |
| What has been done | journal / event store | Auditing, replay, delivery judgment |
| What has been delivered | receipt workspace outputs | Success threshold |
| Whether the request is duplicated | idempotency key | Prevent duplicate acceptance |

## 5. An observable chain

~~~text
checkpoint read
  Snapshot before → run
  → astream
  → journal event
  → event store / stream bridge
  → checkpoint update
  Delivery Scan
  → delivery receipt
  → terminal status
~~~

SSE is a view, not a source of truth. Real-time SSE across workers requires a shared bridge (such as Redis) or replaying from the event store; you cannot assume in-memory queues are transparently shared.

## 6. Experiments

### Experiment A: Verify receipt before final state

Observe the sequence near `_persist_delivery_receipt`. Reference acceptance: if receipt fails, Run should not be marked as clean `success`, but should enter the error/unclosed path.

### Experiment B: Simulate worker disconnection

Pause the heartbeat or terminate the worker, then start a new Gateway. Reference observation: orphan recovery takes over according to lease and persistent records, and the `ownership_lost` of the old worker prevents further writing.

### Experiment C: Compare events and SSE

Read the historical events of the same Run from the event store, then disconnect/reconnect SSE. Reference acceptance: the real-time stream can lose connections, but historical events can be recovered by cursor; their semantics are different.

### Experimental Reference Answers

1. When receipt fails, it cannot be marked as clean `success`; it should enter the error/unclosed path, and the recoverer should first verify the delivery facts before filling in missing writes.
2. The new Gateway should take over according to lease and persistent records; if the old worker continues writing, it will be blocked by `ownership_lost`-type fences.
3. Real-time SSE disconnections can lose transient connections, but persistent events can still be replayed by cursor; UI reconnection should not trigger a Run rerun.

## 7. Failures and Recovery

| Crash Window | Existing Facts | Recovery Action |
| --- | --- | --- |
| Before checkpoint update | Previous checkpoint, journal | Continue from the last recoverable point |
| After checkpoint, before final state | Graph state completed | Only fill in delivery and final state |
| After receipt, before state | Delivery proven | Idempotent fill-in of final state |
| ownership_lost | This worker no longer has rights | Immediately stop persistence |
| After final state | Job closed | Only idempotent read/replay allowed |

## 8. Self-Test

1. Can checkpoint, journal, and RunStore replace each other?
2. Why must the successful state come after the delivery receipt?
3. After `ownership_lost`, can the old worker still write usage or title?
4. Why can't cross-worker SSE rely on in-process queues?

### Reference Answers

1. No. RunStore controls state and leases, checkpoint manages graph continuation, journal manages process and audit; the readers, writers, and consistency boundaries differ among the three.
2. Because "success" must be backed by verifiable delivery. Writing receipt before state informs the recoverer that the result has been produced; otherwise, there could be a bad state where success exists but no delivery evidence is present.
3. No. Ownership has been transferred; any old writes could overwrite the new owner's legitimate results; writing should stop and recovery should be handed over to the new owner.
4. In-process `MemoryStreamBridge` queues belong only to one process. Other workers cannot see real-time events; a Redis bridge or replay from the event store is required. SSE cannot be treated as shared state.

## 9. Source Code Coordinates

- `backend/packages/harness/deerflow/runtime/runs/manager.py`
- `backend/packages/harness/deerflow/runtime/runs/worker.py`
- `backend/packages/harness/deerflow/runtime/journal.py`
- `backend/packages/harness/deerflow/runtime/events/`
- `backend/packages/harness/deerflow/runtime/checkpointer/`
- `backend/packages/harness/deerflow/runtime/stream_bridge/`

## 10. Next Steps

Enter Stage 7: A single Run is already reliable. How can channels, scheduled tasks, MCP, and sub-agents reuse this control plane?
