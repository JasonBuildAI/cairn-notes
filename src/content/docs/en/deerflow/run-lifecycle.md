---
title: "01 · The Life of a Run"
description: "Trace a Run from HTTP order reception, status transitions, Agent assembly to delivery and final state along the complete main workflow."
---

> Baseline: DeerFlow `v2.1.0` (`345f08be`). Paths are relative to `backend/`, unless otherwise noted.  
> This article only follows a single line: **How a single HTTP Run goes from a request to an executable that is recoverable, observable, and deliverable.**  
> After reading, you should be able to accurately say: who creates the Run, who approves it to start, who assembles the Agent, where the events go, and which layer is responsible for cleanup after failure.

## 1. First, establish a mental model: Run is a 'work order', not a 'function call'

Ordinary function calls are `call → return`. A DeerFlow Run is more like a work order:

```text
Order acceptance (Gateway) → Registration (RunStore: pending) → Start work (pending → running)
     → Production (LangGraph Agent +  tools) → Record process (journal/event store)
     → Acceptance and delivery (delivery receipt) → Archiving (success/error/interrupted)
```

This work order chain stores four types of facts separately:

| Fact | Storage | Question Answered |
| --- | --- | --- |
| Whether this execution still exists and who is responsible | `RunRecord`   `RunStore` | Is there duplicate admission? Is the worker still alive? |
| How far the dialogue graph has progressed | LangGraph checkpoint | Can it continue from the same thread next time? |
| What happened during the run | run journal   event store | What should the frontend see? What can be replayed during auditing? |
| What was ultimately delivered | delivery receipt / outputs | Was the result truly produced, or did the 'model just finish talking'? |

So when reading the Run lifecycle, don't just focus on `agent.astream()`. **What really makes DeerFlow a product-level harness are these four layers: admission, fencing, events, and delivery.**

## 2. Entry: Three HTTP forms, one creation function

`app/gateway/routers/thread_runs.py` exposes three common entry points:

| Route | Behavior | Suitable For |
| --- | --- | --- |
| `POST /api/threads/{thread_id}/runs` | Creates and immediately returns `RunResponse` | Background tasks, polling, program integration |
| `POST /api/threads/{thread_id}/runs/stream` | Creates and subscribes to SSE | Frontend web sees the process in real time |
| `POST /api/threads/{thread_id}/runs/wait` | Creates and waits for terminal state, returns final data | Synchronous calls, scripts, short tasks |

All three ultimately call the same function:

```text
thread_runs.py
  ├─ create_run       → services.start_run(...)
  ├─ stream_run       → services.start_run(...) + StreamBridge.sse_consumer(...)
  └─ wait_run         → services.start_run(...) + wait_for_run_completion(...)
```

This is the first important design: **`start_run()` is the sole convergence point for all Run creation paths**. HTTP, scheduled tasks, IM channels, and internal notifications all enter from here. The source code clearly states at `app/gateway/services.py:1459`: "single choke point every run-creation path flows through." As long as permissions, model whitelists, and input validation are handled here, no entry point can bypass them.

### 2.1 Why can't validation be scattered across the router?

Because the router only represents the "HTTP entry." If validation is written in the router:

- Scheduled tasks called directly from the scheduler to the service will bypass it;
- IM channel calls initiated through the channel service will bypass it;
- Internal notification Runs might follow another call chain, also bypassing it.

Placing the rules at `start_run()` is equivalent to putting the "admission rules" at the admission desk rather than at a specific door.

## 3. `start_run()`: Perform seven types of checks before taking an order

According to the source code order, `start_run()` must at least pass through these checks:

```text
1. Cancel ability check
2. thread_id Legality
3. Secret cleaning inspection in metadata/config
4. Model Whitelist
5. Thread Access Rights and Owner Attribution
6. Request context whitelist merge
7. checkpoint initialize + persistent atomic access
```

### 3.1 Cancellation Capability: The Right to Create and the Right to Cancel Are Not the Same Thing

`require_cancel_permission_if(request, body.multitask_strategy != "reject")` Check the cancellation capability before creation.

The reason is straightforward: `interrupt` / `rollback` type strategies will terminate an existing Run on the same thread. A token that only has `runs:create` should not gain the ability to terminate others just because it "happens to carry a strategy parameter." Only explicit `reject` that doesn't reach existing executions does not require cancellation rights.

This reflects a general principle: **parameters are not permissions. The strategy name passed by the client must be mapped by the server into a capability check.**

### 3.2 Model Whitelist: Model Names Are Not Arbitrary Strings

If the request carries `context.model_name`, `start_run()` will call `app_config.get_model_config(model_name)`; if it's not on the configured whitelist, return a 400 immediately.

This prevents two types of problems:

- The client passing in an unconfigured provider/model can cause uncontrolled network access, billing issues, or key selection;
- Model names being used as configuration keys can affect subsequent provider resolution.

The actual model instance is created in `models/factory.py:174`'s `create_chat_model()`; the whitelist check happens during the admission phase, and the responsibilities are different: **first decide "which one is allowed," then decide "how to construct it."**

### 3.3 Thread Ownership: `thread_id` May Come From the Body

Some stateless routes put `thread_id` in the request body instead of the path parameter, so the usual path owner check cannot cover it. `start_run()` explicitly performs `thread_store.check_access(...)` before creating the Run.

Here is a detail that is easy to overlook: the internal channel is not a "superuser," but executes on behalf of the owner of the connection. The source code comments clearly state that even if an internal token leaks, it cannot gain cross-user thread access. **Internal identity only changes "on whose behalf," it does not cancel the check of "to whom it belongs."**

### 3.4 Context Whitelist: Clients Cannot Forge Server Facts

`body.config` has a free structure, and `body.context` may also carry agent parameters. The processing is done in two steps:

```text
merge_run_context_overrides(...)  # Only forward agent-related keys
strip_internal_context_keys(...)  # Clear keys for internal use only
inject_authenticated_user_context(...) # Inject server-side authenticated user
```

The core of this step is not 'field copying,' but **trust layering**:

- The client can express preferences: model, thinking, some runtime parameters;
- The server has identity, permissions, project ownership, internal keys, runtime context;
- Client fields cannot override server facts.

Later, the project context will be 'pinned' as a server snapshot at the start of Run, to prevent inconsistencies caused by changes in member relations during execution.

## 4. From Receiving an Order to a Work Order: `RunManager.create_or_reject()`

After validation passes, `start_run()` calls:

```python
record = await run_mgr.create_or_reject(
    thread_id, assistant_id,
    on_disconnect=disconnect,
    metadata=run_metadata,
    kwargs={...},
    multitask_strategy=body.multitask_strategy,
    model_name=model_name,
    user_id=owner_user_id,
    idempotency_key=idempotency_key,
)
```

`RunRecord` is the 'control plane record' of this execution. It has many fields, but they can be grouped according to their purpose:

| Group | Representative Fields | Purpose |
| --- | --- | --- |
| Identity | `run_id`, `thread_id`, `assistant_id`, `user_id` | Whose execution this is |
| Status | `status`, `error`, `stop_reason` | pending/running/success/error/interrupted |
| Control | `abort_event`, `abort_action`, `task` | Cancellation and local task handles |
| Ownership | `owner_worker_id`, `lease_expires_at`, `ownership_lost` | Who has the right to write the final state under multiple workers |
| Idempotency | `idempotency_key`, `idempotency_reused` | Whether retries will result in repeated execution |
| Cost | `total_*_tokens`, `token_usage_by_model` | Observation and billing |

Status is defined in `packages/harness/deerflow/runtime/runs/schemas.py`:

```text
pending → running → success
                  ├→ error
                  └→ interrupted
pending ───────────→ interrupted (canceled before starting work)
```

`RunManager.create_or_reject()` Responsible for thread concurrency strategy: `reject` reject an already active Run, `interrupt` / `rollback` follow the cancellation path. The actual persistence admission is carried out by the store's atomic operations, ensuring that two Gateways will not insert conflicting work orders for the same thread at the same time.  

### 4.1 Idempotent Replay: Return the old work order instead of creating a new one  

If the caller includes `Idempotency-Key`, the store may restore an existing `pending/running` Run. At this point, `idempotency_reused=True`, `start_run()` will compare `input`, `assistant_id`, `conversation_references`:  

- Match: directly return the old record without starting a second worker;  
- Mismatch: 409, indicating that the same key was used for different requests.  

This is called "idempotent admission," not "model result caching." It guarantees **work orders are not accepted repeatedly**; whether results can be duplicated depends on the execution itself and external tools.  

## 5. After work order persistence: how the worker starts  

`start_run()` creates a background task after persistence admission:

```python
worker = run_after_metadata(record)
record.task = asyncio.create_task(worker)
```

The source code explicitly emphasizes: **there must be no await between persistent admission and task attachment**. Otherwise, a window may occur where "the store already has a pending Run, but the process crashes before attaching the worker." This window cannot be avoided by prayer; it is minimized by "completing admission first, then synchronously attaching." 

After the task starts, metadata is prepared first, and then it enters `worker.py::run_agent()` (`worker.py:807`).

### 5.1 The First Gate: `try_start()` Turns Pending into Running

`run_agent()` does not immediately assemble the Agent, but first:

```python
start_outcome = await run_manager.try_start(run_id)
```

`RunManager.try_start()` (`manager.py:893`) does three things:

1. Check the local `abort_event`;
2. If RunStore is configured, execute the persistent `start_run(run_id)`;
3. Only if the store accepts it and the record is still pending, change the status to `running`.

If it has already been canceled before starting, return `cancelled`; the worker will directly go through the cancellation cleanup, **without constructing the model, loading tools, or incurring LLM costs**.

This is the "pending-to-running startup barrier." It addresses the classic startup race condition:

```text
Request A: Create Run
Request B: Immediately cancel Run
worker: start execution
```

If there is no barrier, the worker might spend a few seconds initializing the Agent before realizing it has been canceled. The barrier puts the judgment of 'whether it's worth starting' at the forefront.

### 5.2 The Second Gate: Lease Turns "I Thought I Was Alive" into Verifiable Facts

In multi-Gateway deployments, RunStore records `owner_worker_id` and `lease_expires_at`. Workers regularly renew the lease; if the lease expires, another worker can take over an orphaned Run.

`RunRecord.ownership_lost` is an in-process fencing signal. Once set, this worker **can no longer write the Run final state or thread final state**, because another worker might have already taken over. The source code repeatedly checks `not record.ownership_lost` at the end of the final state—not as defensive redundancy, but to prevent a "zombie worker" from overwriting the results of a new worker.

In summary:

> The state machine answers "what is the current state of the work item," while the lease answers "who is authorized to change this state."

## 6. Pre-Construction Preparation: Logs, Snapshots, Checkpoint, Runtime Context

After `try_start()` succeeds, `run_agent()` begins preparing the execution environment. Key actions include:

### 6.1 Build RunJournal

If `event_store` is configured, `RunJournal` is created and attached to LangChain callbacks. It is responsible for:

- Capturing LLM requests/responses and token usage;
- Capturing chain/tool lifecycles;
- Generating persistable events;
- Maintaining final delivery information;
- Writing progress snapshots back to `RunManager`.

Here, two types of "history" need to be distinguished:

- **Checkpoint**: used for LangGraph state recovery;
- **Journal/event store**: for the user, for auditing, for SSE.

The former is execution state, the latter is process facts. They may contain similar messages, but their responsibilities are different.

### 6.2 Capture Pre-Run Workspace Snapshot

`capture_workspace_snapshot(...)` records the workspace baseline before the Agent truly runs. After the Run ends, scanning again allows calculation of:

- Which files were added/modified in this Run;
- Whether the final delivery includes artifacts;
- How workspace changes are presented to the frontend.

This reflects an important principle: **"The model says a file was generated" does not equal "the file actually exists."** DeerFlow uses pre- and post-run snapshots to turn "claims" into "verifiable differences."

### 6.3 Inject Runtime Context

The worker constructs `runtime_ctx` and hands over `thread_id`, `run_id`, server app config, task store, extensions, conversation reader, etc., to middleware and tools. Then:

```python
runtime = Runtime(context=runtime_ctx, store=store)
config["configurable"]["__pregel_runtime"] = runtime
```

Why do it manually? Because here it is driven by `agent.astream(config=...)`'s graph, rather than using the full runtime assembly of the LangGraph CLI. **The worker is the host and must complete the runtime context for LangGraph.**

At the same time, the worker will write the agent identity from the checkpoint, project context, trace ID, etc., as server-overridden values. Request metadata cannot forge these fields.

## 7. Assembling the Agent: Middleware is not decoration, it is the execution strategy layer

The worker enters the assembly chain through `agent_factory` / `make_lead_agent`:

```text
agents/__init__.py::make_lead_agent(config)
  → agents/lead_agent/agent.py
    → get_available_tools(...)
    → apply_tool_authorization(...)
    → assemble_deferred_tools(...)
    → build_middlewares(...)
    → apply_prompt_template(...)
    → create_agent(model=..., tools=..., middleware=..., system_prompt=...)
```

The final position for creating the Agent is around `lead_agent/agent.py:1239`; a more general assembly entry point is `create_deerflow_agent()` at `agents/factory.py:66`.

### 7.1 Why the assembly order matters

From the comments in `factory.py`, it can be seen that the middleware chain of the Lead Agent has a clear order, with `ClarificationMiddleware` always placed at the end. The order affects:

- Who sees the model response first;
- Who can intercept before a tool call;
- Who is responsible for cleaning up dangling tool calls;
- Who ultimately decides whether to ask the user for clarification;
- `after_model` in LangChain executes in reverse order, determining who has the final say.

So, "adding a middleware" is not simply appending. You must also answer: Is it before or after the model? Does it modify the message or just observe? Does it block the Run if it fails?

### 7.2 Tools don't just feed all definitions to the model first

The Lead Agent first obtains candidate tools and then goes through:

```text
get_available_tools
  → apply_tool_authorization
  → assemble_deferred_tools
  → build_mcp_routing_middleware
```

This indicates that the tool layer is divided into at least three levels:

1. **Available**: The tool exists in the system;
2. **Authorized**: The current user/context is allowed to use it;
3. **Assembled**: Actually exposed to the model in this round, or discovered later via tool search.

When there are many tools, putting them all into the prompt wastes tokens and increases misselection. DeerFlow uses deferred tools / tool search to separate the "tool catalog" from the "current tool definition."

### 7.3 The model entry has only one path

Whether it's the Lead Agent, bootstrap agent, or other entry points, it all ultimately goes through `create_chat_model()`. It is responsible for:

- Parsing the provider class from the model configuration;
- Merging the model profile with per-agent overrides;
- Handling thinking / reasoning effort;
- Passing only parameters recognized by the provider to the client;
- Handling duplicate spans in tracing attach.

This way, "switching models" changes the configuration without altering the Agent loop; "adding a provider" implements an adapter class without changing the business flow.

## 8. Actual Execution: `agent.astream(...)`

After preparation is complete, the worker calls:

```python
stream = agent.astream(
    input_payload,
    config=stream_config,
    stream_mode=lg_modes,
    subgraphs=stream_subgraphs,
)
```

Then consume frame by frame:

```python
async for item in stream:
    if record.abort_event.is_set():
        break
    mode, chunk, namespace = _unpack_stream_item(...)
    await _publish_stream_item(...)
```

Here are a few key points.

### 8.1 Multiple stream modes correspond to different observation surfaces

Modes `values`, `messages`, `updates`, `custom`, etc. generate events of different granularity:

- `values`: state snapshots, suitable for recovery/full page refresh;
- `messages`: token-level message streams, suitable for typewriter effects;
- `updates`: node updates, suitable for debugging graph execution;
- `custom`: business custom events, sub-agents/tools can report progress.

A worker is not just a "forwarder." It also performs:

- file tool chunk aggregation;
- sub-agent event buffering;
- message sequence stamping;
- LLM error fallback recognition;
- SSE serialization and `StreamBridge.publish`.

### 8.2 StreamBridge can be intra-process or cross-process

`StreamBridge` has two implementations:

- `MemoryStreamBridge`: intra-process queue, SSE can only be provided by the owner worker;
- `RedisStreamBridge`: write events into Redis Stream, multiple Gateways can subscribe via `XREAD` and retain `Last-Event-ID` replay semantics.

Therefore, the 409 condition in the router means "store-only Run bridge does not support cross-process," not an unconditional rejection of all cross-worker requests. The default memory mode is a single-process deployment constraint; for multi-worker streaming viewing, configure a Redis bridge. **State can be shared across workers and event streams can be shared across workers are two separate capabilities; do not confuse them.**

### 8.3 Cancellation is not as simple as 'killing a Python coroutine'

After `abort_event` is set, the stream loop will actively break. Then the worker goes through `_finish_cancellation`:

- publish a cancellation event;
- end SSE subscription;
- mark `interrupted`;
- release task resources;
- avoid treating partially completed work as a successful delivery.

If only `task.cancel()`, there may be unclosed streams, unflushed logs, and unreleased sandboxes. Therefore, cancellation is a business action with a clear closing sequence, not merely terminating a coroutine.

## 9. Closing: Success does not mean 'the model stops outputting'

After the main loop ends, the worker first determines:

```text
abort_event? → interrupted
LLM fallback? → error
Otherwise → calculates delivery content → success / error
```

### 9.1 Delivery Verification

A successful path will:

1. Take the delivery content recorded in the journal;
2. Scan the actual outputs using snapshots of the workspace before and after execution;
3. Merge the output paths into the delivery content;
4. Call `_delivery_error(...)` to determine whether the success conditions are met;
5. Write the delivery receipt.

Therefore, the semantics of `success` is not "HTTP stream ended normally," but: **The Run has completed, and the delivery facts can be recorded/verified.**

### 9.2 Terminal State Write Order

The `finally` block reflects a very particular order:

```text
flush journal
  Write delivery receipt
  → Updating finalizing progress
  → Write duration checkpoint
  Persistent Final State
  → Persistence completion/token Statistics
  → Handling title, workspace changes, extension notifications, sandbox release
```

Why should the receipt come before the terminal state? The source code comments give the answer: to avoid a crash window where 'Run has already shown success, but the delivery receipt hasn't been persisted yet.' Have verifiable delivery first, then the terminal state.

### 9.3 Stop all persistent finalization when ownership is lost

Almost every persistence step is accompanied by `not record.ownership_lost`. If the lease is lost:

- This worker no longer writes the terminal state;
- It no longer writes the receipt;
- It no longer changes the thread title;
- It leaves the recovery responsibility to the take-over worker.

This rule is more important than "write as much as possible." In a distributed system, **well-intentioned writes by an expired owner can be more dangerous than not writing.**

## 10. A complete timing diagram

```text
Client
  │ POST /runs[/stream|/wait]
  ▼
thread_runs.py
  │ start_run(body, thread_id, request)
  ▼
services.start_run
  ├─ cancel permission / thread id / secret scan
  ├─ model allowlist / thread ownership
  ├─ context whitelist + authenticated user injection
  ├─ checkpoint history seed
  ├─ RunManager.create_or_reject  ──────────────► RunStore(pending)
  │     └─ idempotency replay? → return existing
  └─ asyncio.create_task(run_after_metadata)
                          │
                          ▼
                 worker.run_agent
                   ├─ wait_for_prior_finalizing
                   ├─ RunManager.try_start ─────► RunStore(running)
                   │    └─ cancelled → no agent build
                   ├─ RunJournal + workspace snapshot
                   ├─ build Runtime context
                   ├─ make_lead_agent
                   │    ├─ tools/auth/deferred/tool-search
                   │    ├─ middlewares
                   │    └─ create_chat_model
                   ├─ agent.astream
                   │    ├─ model ↔ tool loop
                   │    ├─ journal events
                   │    └─ StreamBridge → SSE
                   ├─ delivery content + outputs scan
                   └─ receipt → terminal status → cleanup
```

## 11. Five Most Memorable Design Trade-offs

1. **Take orders before starting work**: Pending work orders can be canceled, restored, and idempotently reused; directly starting work does not have these control mechanisms.
2. **Separation of state and ownership**: `status` indicates "what it is," while lease indicates "who can write." Both are indispensable.
3. **Separation of checkpoint and event store**: One service handles recovery, another handles observation/audit.
4. **Separation of in-process flow and cross-process state**: SSE binds the owner worker, history is read from storage.
5. **Success must come with delivery proof**: Model completion is not the end point, the product and receipt are.

## 12. Common Misunderstandings

| Misunderstanding | Correct Understanding |
| --- | --- |
| `POST /runs` return means the Agent has already started | Return indicates an admitted RunRecord; the worker still needs to pass `try_start` |
| SSE disconnection means the Run is canceled | Whether it is canceled is determined by `on_disconnect` and the cancellation policy, not the connection itself |
| `success` only means no exception was thrown | Verification must also be done through the delivery content/product and writing the receipt |
| Having a checkpoint means no need for event store | Checkpoint does not save complete process events and does not handle frontend playback |
| Any worker can stream any Run | Under memory bridge only the owner worker can provide it; Redis bridge supports cross-process |
| Idempotent key caches model answers | It only prevents duplicate order taking, does not guarantee consistent execution results |

## 13. Source Code Experiments

### Experiment A: Verify "Cancel before start does not construct Agent"

1. Set a breakpoint in `RunManager.try_start()` on the `cancelled` branch;
2. Create a Run and immediately call cancel;
3. Observe the logs: should see pending → interrupted, not create_chat_model/tool initialization.

### Experiment B: Verify SSE worker binding

1. Start two Gateway workers;
2. Create a Run on worker A;
3. Request `join` the same Run from worker B;
4. Observe 409 and error messages, then compare with history read from event store.

### Experiment C: Verify delivery validation

1. Let the Agent only reply "report.md generated" without actually writing the file;
2. Check the delivery content/workspace changes/final state;
3. Then let the tool actually write, compare receipt and success determination.

## 14. Self-Test Questions

1. Why does `start_run()` perform both model whitelist and thread ownership checks? What does each prevent?
2. `try_start()` and `create_or_reject()` both change state; which race condition does each resolve?
3. Why must `RunRecord.ownership_lost` prevent final state writing?
4. What do checkpoint, RunJournal, and RunStore each store? Can they replace each other?
5. Why can't SSE transparently span workers like RunStore?
6. If writing delivery receipt fails, what state should the Run be in? Why?
7. When canceling a Run that has already entered tool execution, what cleanup must at least be done?

### Reference Answers

1. **Model Whitelist** prevents the client from turning any provider/model name into HTTP access, billing, and key selection permissions; **Thread Ownership Check** prevents `thread_id` in the request body from bypassing path-level owner verification, leading to cross-user read/write. The former answers "which model is allowed," and the latter answers "who has the right to create a Run on this thread."
2. `create_or_reject()` addresses **admission race conditions**: concurrent creation on the same thread, idempotent key replay, and under the `reject/interrupt/rollback` policy, only one valid work order can be generated. `try_start()` resolves **start work race conditions**: pending may have been canceled, and multiple workers may try to start simultaneously; it uses conditional state transitions and leases to ensure that only one owner changes the Run to running.
3. `ownership_lost` indicates that this worker has lost write privileges, usually due to lease expiration or takeover by a new owner. At this point, if the old worker writes a final state, receipt, title, or usage, it would overwrite the new owner's legitimate result, creating "zombie writes"; therefore, it must stop all persistent finalization and hand over recovery responsibility to the successor.
4. **Checkpoint** saves the recoverable graph state of LangGraph; **RunJournal** saves runtime events, tokens, and delivered content; **RunStore** saves RunRecord, state, idempotent keys, leases, and control plane fields. The three serve recovery, observation/audit, and control plane respectively. Their formats and lifecycles are different and cannot replace one another.
5. Because real-time SSE is bound to the owner worker that generates the stream: by default `MemoryStreamBridge`'s queue is within the process. RunStore is a shared persistent layer, readable by any worker; but to view real-time stream across workers, a Redis bridge or replay from the event store is required, memory queues cannot be assumed to be transparently shared.
6. `success` cannot be marked. Delivery receipt is evidence of "successful verifiable delivery"; receipt write failure means the fact chain before the final state is not closed, and should enter the error/delivery-failure path while retaining recoverable information, forming the final state only after retry or manual handling. The source deliberately writes the receipt first and the final state later to eliminate the window where the page shows success but the evidence hasn't been persisted.
7. At a minimum: set `abort_event` and stop consuming the model/tool further; let already-started tools reach a safely finalizable boundary, and prevent unfinished calls from leaving dangling results; publish cancel events and end SSE; flush the journal, save existing checkpoint/partial facts; release sandbox lease and worker resources; terminate with `interrupted` without writing a successful receipt. External side effects that have occurred cannot be pretended to rollback, must be recorded as partially executed, and rely on idempotent keys/readback to recover.

## 15. Code Map

```text
backend/app/gateway/routers/thread_runs.py   HTTP Three entrances
backend/app/gateway/services.py              start_run / wait / SSE consumer
backend/packages/harness/deerflow/runtime/runs/manager.py
                                             RunRecord / State Machine / Lease / Idempotence
backend/packages/harness/deerflow/runtime/runs/worker.py
                                             run_agent / astream / terminal state
backend/packages/harness/deerflow/runtime/journal.py
                                             Process Event / Token / Delivery
backend/packages/harness/deerflow/agents/__init__.py
                                             make_lead_agent
backend/packages/harness/deerflow/agents/factory.py
                                             General Agent Assembly
backend/packages/harness/deerflow/agents/lead_agent/agent.py
                                             Lead Tools/Middleware/Model Assembly
backend/packages/harness/deerflow/models/factory.py
                                             create_chat_model
```

The next article will break down these components: how the context is assembled, where the tools are executed, the trust boundaries of the sandbox, how sub-agents share runs, and why production reliability is designed this way.
