---
title: "03 · Engineering Practice"
description: "Complete engineering practice using fault location tables, source code experiments, test maps, and safe modification paths."
---

> Baseline: DeerFlow `v2.1.0`(`345f08be`). Path relative to the repository root.
> The first two articles discuss "what it is and how to run it"; this article discusses "how to read it, how to debug it, how to modify it, and how to verify it."

## 1. The shortest route to reading DeerFlow

Do not start by spreading out through tens of thousands of lines in the directory. Use the five-layer positioning method:

```text
① Entrance Level   app/gateway/routers/
② Control Layer   app/gateway/services.py + runtime/runs/
③ Assembly layer agents/__init__.py + agents/factory.py + lead_agent/agent.py
④ Mechanism Layer agents/middlewares/ + tools/ + sandbox/ + models/
⑤ Support layer   persistence/ + runtime/journal.py + app/channels/
```

Each time I read a function, I first determine which layer it belongs to: 

- The request field has changed→ Check the router start_run first; 
- Run status is incorrect → First, check the RunManager worker; 
- The model sees or does not see a certain context→ First, check the ThreadState middleware; 
- The tool was not executed/rejected → First check the authorization, deferred, sandbox; 
- Missing front-end events → First, check journal, event store, and StreamBridge. 

## 2. Fault location table

| Symptoms | First Scene | Subsequent Examination | Common Root Causes |
| --- | --- | --- | --- |
| Create Run returns 400 | `start_run()` | Model whitelist, thread_id | Model not configured, ID invalid |
| Create Run and return 403/404 | auth / thread ownership | `check_access`, owner injection | Insufficient token capability, thread belongs to someone else |
| Run Card Always Pending | `RunManager.create/try_start` | Is the worker task installed? lease | Process crashes, store unavailable |
| Run Always running but no output | worker / stream | Are you waiting for models, tools, or capacity | provider to freeze, or sub-agent capacity to run out |
| SSE Not Receiving Events | StreamBridge | owner worker, Redis configuration, Last-Event-ID | Connection error worker, buffer gap |
| Page shows successful but no file | delivery logic | workspace snapshot, outputs, receipt | The model only made verbal claims |
| Tool Bulletin "Path Not Allowed" | sandbox path resolver | Virtual path, provider mapping | Out-of-bounds using host path |
| Sub-agent not starting | SubagentLimit / capacity | max_concurrent, max_total | Concurrency/Total Volume Over-limit |
| After process restart, Run becomes error | lease reconciliation | owner worker, heartbeat | Lease expired and taken over |
| Model Answers Irrelevant/Losing Context | context projection | summarization, budget, memory | Old messages are compressed, tool results are cropped |

## 3. Three must-read "sources of evidence" 

### 3.1 Log

First, look at the structured fields: `run_id`, `thread_id`, `worker_id`, `model_name`, `tool_name`, `error_type`. Don't just look at the last line of exceptions. 

An efficient sequence:

```text
request accepted
  → run admitted
  → run -> running
  → agent assembly
  → llm start/end
  → tool start/end
  → delivery receipt
  → terminal status
```

Which segment is missing, the problem is before or within that segment.

### 3.2 Events

`GET /api/threads/{thread_id}/runs/{run_id}/events` You can view the complete event stream (for debugging/audit). Focus on:

- Whether there is `metadata`;
- Whether model errors/fallback appear;
- Whether there is an end after the tool starts;
- Whether there is delivery / workspace_changes;
- Whether event sequence (seq) is continuous.

### 3.3 Checkpoint

Checkpoints are used to answer "how far the graph has executed, and what is in the state." Note that it may be compressed or in delta mode, and cannot be considered a complete chat log.

During debugging, first confirm:

```text
Is it correct?
Does checkpoint mode match?
Whether the correct checkpoint_id was selected
Whether it is overwritten by subsequent Run
```

## 4. Four Source Code Experiments

### Experiment 1: Cancel a Run in the Pending Stage

Objective: Verify the startup barrier.

Steps:

1. Add logs to branch `cancelled` of `RunManager.try_start()`;
2. Cancel immediately after creating a Run;
3. Observe whether Agent construction/model invocation occurs;
4. Check if the event flow ends with cancellation and if the status is interrupted.

Expected conclusion: **Cancellation occurs before starting work and should not incur model costs.**

### Experiment 2: Switch Memory / Redis Bridge

Objective: Understand the boundary of streaming deployment.

Steps:

1. Start two workers with the default memory bridge;
2. Create a streaming Run in A and try to join from B;
3. Record 409 conditions;
4. Configure the Redis bridge and repeat the experiment;
5. Observe the reconnection behavior of `Last-Event-ID`.

Expected conclusion: **Streaming capability depends on the bridge, not whether the RunStore is shared.**

### Experiment 3: Create a "Fake Delivery"

Objective: Verify the relationship between success and actual files.

Steps:

1. Have the model only reply "Report generated" without invoking the file-writing tool;
2. Check workspace changes and delivery receipt;
3. Then let the tool actually write to `/mnt/user-data/outputs/report.md`;
4. Compare the final state with frontend output.

Expected conclusion: **Delivery verification looks at actual products/delivery content, not the model's wording.**

### Experiment 4: Trigger Sub-Agent Concurrency Limit

Objective: Understand `SubagentLimitMiddleware`.

Steps:

1. Reduce `max_concurrent` in the test configuration;
2. Construct a response containing multiple task calls;
3. Observe the number of reserved/removed tasks and events;
4. Check if the total number of calls is also limited by `max_total`.

Expected conclusion: **The concurrency limit takes effect after the model response and before tool execution.**

## 5. How to Safely Modify a Feature

### 5.1 Modify Request Fields

Sequence:

```text
router schema
  → start_run validation
  → RunCreateRequest → graph_input/config
  → worker / middleware consumption
  → tests: API contract + behavior
```

Checklist:

- Could it be forged by the client?
- Does it need to include `strip_internal_context_keys`?
- Should it log RunRecord / event?
- Should the idempotent comparison include new fields?
- Is it compatible with old clients?

### 5.2 Add a tool

Sequence:

```text
tool definition
  → get_available_tools
  → authorization
  → deferred/tool search visibility
  → sandbox or server-side execution
  → result metadata / budget / receipt
  → prompt guide
  → tests
```

Checklist:

- Is the parameter schema strict?
- Is a sandbox virtual path needed?
- Can failures be classified and recoverable?
- Could the output be too large?
- Could it be misused by sub-agents?
- Are audit events needed?

### 5.3 Add a middleware

First, answer six questions:

1. Does it handle `before_model`, `after_model`, `wrap_tool_call` or other hooks?
2. Does it modify state or prompt, or just observe?
3. What is its anchor in the chain?
4. Does it block or degrade on failure?
5. Does it generate tokens/events/audits?
6. What is its order relative to Clarification, Summarization, ToolError?

Do not use 'append to the end' to bypass sequential design.

### 5.4 Modify checkpoint/persistence

This is a high-risk area. At minimum, verify:

- full/delta compatibility;
- migration of old data;
- multi-worker lease;
- cancellation/restart/rollback;
- event sequence and receipt;
- forward and backward compatibility of schema migration.

## 6. Test Map

### 6.1 Tests worth reading first

| Test | What it protects |
| --- | --- |
| `test_harness_boundary.py` | `deerflow` must not depend backward on `app` |
| `test_run_manager.py` | State, cancellation, lease |
| `test_thread_run_idempotency.py` | Idempotent access |
| `test_runs_api_endpoints.py` | HTTP contract |
| `test_run_worker_delivery.py` | Terminal state and delivery |
| `test_multi_worker_run_ownership.py` | Multi-worker ownership |
| `test_run_worker_delta_resume.py` | Delta checkpoint recovery |
| `test_sandbox_leases.py` | Sandbox usage and release |
| `test_subagent_limit_middleware.py` | Sub-agent concurrency limits |
| `test_run_event_stream_contract.py` | SSE event contract |

### 6.2 Common commands

```powershell
cd $DEERFLOW_SRC\backend
uv run pytest tests/test_harness_boundary.py -q
uv run pytest tests/test_run_manager.py tests/test_thread_run_idempotency.py -q
uv run pytest tests/test_run_worker_delivery.py tests/test_multi_worker_run_ownership.py -q
```

The repository root can also run:

```powershell
make test
```

Changes affecting multiple workers / Redis / sandbox mean passing unit tests does not equal completion; at least do one real multi-process or integration validation.

## 7. The "Why" of Five Design Trade-offs

### 7.1 Why Run Has a Pending State

Because a window is needed between "Admitted" and "Work Started" that can be canceled, resumed, and audited. Without pending, cancellation can only kill the process, and idempotency can only rely on guessing.

### 7.2 Why There Is an Event Store

Because checkpoints are for the graph, not for humans. Users need to see tool progress, model output, and delivery status; audits need to see failure reasons and event order.

### 7.3 Why Tools Are Deferred

Because the tool directory will grow with MCP/extensions. Loading all prompts consumes a lot of tokens and can cause the model to mischoose between similar tools. Deferred discovery separates "knowing it exists" from "available now."

### 7.4 Why Sandbox Uses Virtual Paths

Because tool contracts should not depend on deployment paths. Virtual paths provide permission boundaries, cross-provider consistency, and prompt stability.

### 7.5 Why the Harness/App Boundary Is Retained

Because the kernel needs to be reusable by Web, IM, SDK, and embedded clients. Allowing the kernel to import the app is convenient short-term, but long-term will couple all hosts into the kernel.

## 8. Common "Looks Correct" Mistakes

| Mistake | Why It's Dangerous | Correct Direction |
| --- | --- | --- |
| Adding permission checks in the router | Other entry points can bypass | Place it at `start_run()` convergence |
| Using `task.cancel()` instead of the cancel process | Flows, logs, sandbox not finalized | Set abort_event and follow unified finalization |
| Passing full tool output to the model | Blows up context | Budget   synopsis   retrievable path |
| Treating checkpoint as audit log | Compression/overwrite/format change | Use event store / journal |
| Letting child Agent recursively call freely | Budget chaos | capacity   max_total   depth limits |
| Directly trusting MCP response | Injection, oversized payload | Result classification, summary, permission, and size limits |
| Changing status without checking lease | Zombie workers overwrite | Conditional update   ownership_lost fence |

## 9. Graduation Exercise

### Exercise A: Draw a "Failure Recovery Diagram"

Pick a failure point (model timeout, worker crash, sandbox disconnect, SSE disconnect, delivery write failure), and draw:

```text
Who discovers → Who decides → Who writes the status → What the user sees → How to retry
```

### Exercise B: Implement a Read-Only Tool

Requirements:

- Read-only access to `/mnt/user-data/uploads`;
- Strict parameter validation;
- Summarize if the result is too large;
- Errors can be categorized;
- Do not expose to sub-Agents;
- Include tests.

### Exercise C: Write Contract Tests for a Middleware

Choose an existing middleware and add three types of tests:

1. Normal path;
2. Tool/model error path;
3. Cancellation or timeout path.

### Exercise D: Explain a Cross-Worker Failure

Assume a Run is executed on worker A, and A crashes before writing the final state, and worker B takes over. Explain, in the order of lease, checkpoint, event store, receipt, what B should do and what it should not do.

### Reference Answers and Acceptance Criteria

**Exercise A (using "worker A crashes before writing final state" as an example)**

```text
Who found: Run heartbeat/lease expired, or restore/reconcile scan found owner absent
Who decides: RunManager's recovery path determines that the lease has expired, allowing a new owner to take over
Who writes the status: Only workers who have obtained a new lease can advance the status under the condition.
The user sees: first sees interrupted/resumed, rather than a fake success; then sees the replayed events and the final state
How to retry: continue from the last committed checkpoint; first read event store/journal/receipt, already occurred external effects are not redone
```

Acceptance point: After `ownership_lost` in the old worker, no more terminal state or receipt is written; The new owner will not repeatedly execute tools that have already left idempotent receipts; If side effects exist but the result is unknown, perform a readback first instead of rerunning directly. 

**Exercise B (Read-Only Upload Tool)** 

Reference practice: Declare a strict schema in the tool's definition, accepting only `/mnt/user-data/uploads/...` logical paths; Only after `get_available_tools → authorization → deferred/tool search` are exposed after it's done; During execution, the sandbox provider parses the real path and performs boundary checks; Read has a size limit; if the limit is over, it returns synopsis, byte count, and a queryable receipt, not the entire content; Errors should at least distinguish `not_found`, `permission_denied`, `too_large`, `transient`; At the authorization/visibility layer, it is explicitly not exposed to sub-agents. 

Acceptance points: directory traversal, symbolic link escape, and absolute host paths are all rejected; Large files do not overload the context; Errors can be understood by the model; Auditing can see calls and result summaries; It is not listed in the available tool list for child agents. 

**Exercise C (Middleware Contract Test)** 

1. **Normal Path**: Asserts the difference between state/prompt, event order, tool result structure, and whether it is executed only once. 
2. **Error path**: When a model or tool reports an error, it asserbates that the error is categorized, there is no dangling `tool_call`, failure is not mistaken for success, and if necessary, whether to re-raise or downgrade. 
3. **Cancel/Timeout Path**: Asserts that after `abort_event` takes effect, calls stop continuing, started tools are closed, unstarted calls have matching results, and in the end, they are not `success`, and resources and sandboxes are released. 

The acceptance point is not the "function has been called," but these observable behaviors: states, events, tool result pairing, final state, and persistent side effects. 

**Exercise D (Cross-Worker Takeover)** 

Worker B should first confirm that A's lease has expired and obtain their own lease; Read the current state of the RunStore, checkpoint, journal/event store, and existing receipts. If A's last checkpoint is complete, restore it from there; If a tool effect already has an idempotent receipt, skip it; If there is no receipt but the external state may have changed, read back first before deciding. B cannot: write any state before receiving the lease; rerun the entire run from scratch; rewrite delivery receipt; and successfully program the unknown tool result left by A. Only after verifying delivery and writing receipt can B proceed to the final state. 

## 10. Finally, self-test

Answer without reading the document: 

1. What are the five key stages of a run? 
2. Which fields can only be written by the server? 
3. What three types of facts do checkpoint, runstore, and event store respectively exist? 
4. How should cancellation, failure, and delivery failure be resolved? 
5. How does ownership differ between SSE and Run states under multiple workers? 
6. What layers does a tool go through from registration to model call? 
7. What behaviors might changing the middleware order disrupt? 
8. Why can't `deerflow` import `app`? 

### Final self-test reference answers

1. Five key stages: **Order Acceptance (start_run) → pending → running Start/lease → Agent Assembly and astream Execution → Delivery Verification and receipt → Final State Writing/Cleanup** (in the code map, usually expanded as admission, start, execution, delivery, closure).
2. Can only be written by the server: `run_id/owner_user_id/status/timestamps/lease/ownership/token usage/checkpoint_id/delivery receipt`, authenticated user and project ownership, internal context key, event seq, and other lifecycle and authorization facts. The client can express preferences but cannot write identity, ownership, or final state.
3. **Checkpoint**: LangGraph graph state and recovery points; **RunStore**: Run control records, state, idempotency, and lease; **Event store/journal**: process events, audit/replay, delivery content, and receipt.
4. **Cancel**: set abort, stop further consumption, close already started tools, flush journal, release sandbox/stream resources, end with `interrupted` without writing a success receipt. **Failure**: record categorized errors, save checkpoint/journal, enter error based on ownership, retain recoverable evidence. **Delivery Failure**: cannot succeed; retain products/delivery verification failure information, go to error or retry recovery until receipt matches the final state.
5. In multi-worker setups, Run state is in the shared RunStore, readable by any authorized worker; real-time SSE is by default bound to the owner worker's in-process StreamBridge. Watching across workers requires a Redis bridge or replaying from the event store; "state readable" should not be mistaken for "stream can be transparently taken over."
6. Registration/definition → `get_available_tools` candidate → authorization filtering → deferred/tool search exposed this round → prompt/schema → model invocation → parameter validation/approval → sandbox or provider execution → result classification/budget/receipt → flow back as `ToolMessage`.
7. Will disrupt: system prompt and cache stability, context compression timing, tool authorization/approval, tool error handling and result matching, clarification order, sub-Agent concurrency limits, cancelation and closure. Middleware order is a behavioral contract, not a list decoration.
8. Because `deerflow` is intended as a reusable harness for Embedded Client, SDK, and other hosts; reverse dependency `app` would couple Web/IM/database implementations into the core, damaging portability and boundary testing.

## 11. One-page code map

```text
app/gateway/routers/thread_runs.py       HTTP Contract
app/gateway/services.py                  start_run / SSE / wait
runtime/runs/manager.py                  RunRecord / Status / Lease / Idempotent
runtime/runs/worker.py                   run_agent / astream / final state
runtime/journal.py                       Event / Token / Delivery
runtime/stream_bridge/ memory / redis stream bridge
runtime/checkpoint_mode.py               full / delta
agents/__init__.py + factory.py          Agent Assembly
agents/lead_agent/agent.py               Lead Assembly
agents/middlewares/ Context/ Tools/ Safety/ Clarification
Model Factory
tools/ + sandbox/                        Tools and execution boundaries
subagents/                               sub Agent runtime
mcp/ + skills/ + extensions/             Extension surface
app/channels/ IM Access
backend/tests/ Contract and Proof of Action
```

Reading up to this point, the core thread of DeerFlow can be condensed into one sentence:

> **Gateway turns untrusted requests into controlled Runs, workers reliably execute Runs using leases and state machines, Agents complete reasoning with context/tools/models, and journal/checkpoint/store respectively preserve the process, state, and deliveries as evidence.**
