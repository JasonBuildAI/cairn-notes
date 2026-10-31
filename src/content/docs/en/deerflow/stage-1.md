---
title: "Stage 1: Entry and Run Lifecycle"
description: "Stage 1: Entry and the Run lifecycle. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: DeerFlow Source Code Class · Stage Assignment
> Prerequisite: Stage 0
> Corresponding Overview: `run-lifecycle.md`
> Goal of This Stage: Accurately state the moments when a Run is accepted, started, loses ownership, and completed.

## 1. What This Stage Addresses

An execution is not "calling a function and waiting for a return," but rather a work order with an identity:

~~~text
POST request
  → start_run Authorization and Cleansing
  → create_or_reject Atom registered as pending
  → Return RunResponse / Create SSE
  → worker try_start condition changed to running
  → astream execute
  → journal / checkpoint / delivery receipt
  → success / error / interrupted
~~~

`thread_runs.py`'s `create_run`, `stream_run`, and `wait_run` are just three consumption patterns, all ultimately going through `services.start_run`.

## 2. First, remember a judgment

**Accepting an order and starting work are two different commitments.**

`create_or_reject()` answers "whether this work order is allowed to exist"; `try_start()` answers "whether there actually is a worker who can take it now." Combining the two will cause queuing, cancellations, idempotency, and concurrent starts to lose their atomic boundaries.

## 3. Mainline of the source code

1. `thread_runs.py::create_run` calls `start_run`.
2. `start_run` checks cancellation ability, model whitelist, thread ownership, and input/internal key sanitization.
3. `start_run` assembles the server-trusted `RunContext`, then calls `RunManager.create_or_reject`.
4. `create_or_reject` processes idempotent keys, same-thread policies, and `pending` records within a controlled block.
5. Background workers enter `run_agent`, first invoking `run_manager.try_start(run_id)`.
6. `try_start` only changes it to `running` if the confirmation record is still `pending` and owner/lease is valid.
7. During graph execution, facts are recorded separately by `RunJournal`, `StreamBridge`, and checkpoints.
8. Finally, it ends with `set_finalizing`, delivery receipt, status writing, and resource release.

## 4. Key objects and contracts

| Contract | Meaning | Failure consequence |
| --- | --- | --- |
| Idempotent key | Replaying the same request cannot produce two work orders | Duplicate side effects, duplicate billing |
| Thread ownership | Only an authorized owner can create a Run | Cross-user read/write |
| `pending` | Registered but not started | Misreporting 'accepted' as 'in progress' |
| `try_start` | The sole gate for starting work | Multiple workers executing simultaneously |
| `ownership_lost` | This worker has lost write permission | Zombie writes overwrite new owner |
| finalizing | Exclusive finalizing block before terminal state | Delivery and success state not closed |

## 5. An observable chain

~~~text
create_run
  → start_run
  → create_or_reject: pending
  → background worker
  → try_start: running
  → run_agent / astream
  → finalizing
  → delivery receipt
  → terminal
~~~

Key observations: cancellations may occur at `pending`, waiting for the previous Run finalizing, model flow, and tool boundaries; Finishing varies at different locations, but none can be successfully forged. 

## 6. Experiment

### Experiment A: Verifying "Returning does not equal starting work" 

After creating a run, query the status immediately; Then observe in the `cancelled` branch of `try_start`. Reference acceptance: `pending → interrupted` should be visible, and no model construction or initialization tools should be used. 

### Experiment B: Verify the Idempotency

Commit twice concurrently using the same idempotent key. Reference observation: Only one valid ticket is generated, and the other takes a reuse or conflict path, rather than two workers running simultaneously. 

### Experiment C: Verifying the delivery threshold

Have the Agent only say "report.md generated" but do not write the file. Reference acceptance: Success cannot be marked solely by natural language; The delivered content must correspond to the real product. 

### Experimental Reference Answers

1. Immediate queries should see that `pending` has not yet been executed; If canceled before `try_start`, it enters `interrupted` without constructing models, initializing tools, or causing runtime side effects. 
2. Only one executable work order can be left for two commits; The second time should hit idempotent multiplexing or conflict, and two workers must not have the same run simultaneously. 
3. Only natural language "generated" cannot achieve clean success. Delivery must correspond to real products, receipts, or verifiable outputs; If products are missing, failures or marks should be incomplete. 

## 7. Failure and recovery

| Collapse location | Existing facts | Restoration principles |
| --- | --- | --- |
| `create_or_reject` Previous | No work order | Client can safely retry |
| After Pending, Before Work Start | With Work Orders, No Execution | Cancel or Reschedule |
| running | There are leases, events, and some checkpoints | Restored by the receiver, the old worker stops writing |
| finalizing | Result generated, terminal state not closed | First read journal/receipt, only add closing |
| After writing the final state | Work order completed | Only perform idempotent playback, do not rerun the tool |

## 8. Pass through customs and self-test

1. Why must both `create_or_reject()` and `try_start()` exist? 
2. Under what conditions does Run change from `pending` to `running`? 
3. `ownership_lost` Why must we stop writing the final state? 
4. When canceling during tool execution, which actions cannot be pretended to roll back? 

### Reference answers

1. The former solves order queues: idempotent, same-thread policy, and whether to allow work order creation; The latter resolves start queues: cancel, concurrent worker, and lease. Merging causes "allow existence" and "actually someone to execute" to form an unstable commitment. 
2. Only when a worker qualifies to start work, with the record still `pending`, and the owner/lease condition is met, only then is `try_start()` carried out. HTTP returns, SSE connection, and task enqueuement cannot prove that the process is running. 
3. After losing ownership, the old worker's final state, receipt, title, or usage will override the legitimate result of the new owner; It should stop persistence and hand over recovery responsibility to the receiver. 
4. Side effects such as external file writes, network requests, or message sending that have occurred cannot be "canceled" and erased; Partial execution, use idempotents, or readback to check if it is effective; blind redoing is not allowed. 

## 9. Source code coordinates

- `backend/app/gateway/routers/thread_runs.py`
- `backend/app/gateway/services.py::start_run`
- `backend/packages/harness/deerflow/runtime/runs/manager.py`
- `backend/packages/harness/deerflow/runtime/runs/worker.py::run_agent`
- `backend/packages/harness/deerflow/runtime/journal.py`

## 10. Next

Entering Stage 2: Run has already `running`, so what models, tools, and middleware will LangGraph assemble next?
