---
title: "Stage 7: Expanding Channels and Multi-Agent"
description: "Stage 7: Expanding channels and multiple agents. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: DeerFlow Source Code Class · Stage Assignment
> Prerequisite: Stages 1, 2, 6
> Corresponding Overview: `core-mechanisms.md`, `engineering.md`
> Goal of This Stage: Understand why all new entry points should reuse `start_run`, and why a sub-Agent is not a second Gateway.

## 1. What this Phase Addresses

DeerFlow serves Web, REST, IM, TUI, embedded clients, scheduled tasks, and MCP tasks simultaneously. They take different forms, but all must comply with the same set of admission, idempotency, leasing, event, and delivery semantics:

~~~text
HTTP / IM / Scheduler / MCP task / SDK
          │ translate into RunCreateRequest
          ▼
      services.start_run
          ▼
   RunManager + worker
          ▼
 Lead Agent → task/subagent → same Run budget and event space
~~~

## 2. First Remember a Principle

**The entry points can be diverse, but there can only be one set of admission rules.**

A channel adapter is only responsible for translating external messages into trusted input and reply routing; it cannot create its own Run, bypass permissions, or write a separate loop. A sub-agent is also a controlled execution unit within the same Run, not an independent product.

## 3. Main Source Code Line

1. The adapter in `backend/app/channels/` normalizes messages from Feishu, Slack, Telegram, etc.
2. The channel service constructs `RunCreateRequest` and ultimately calls `services.start_run`.
3. `backend/app/scheduler/` and `launch_scheduled_thread_run` share the same admission interface.
4. `backend/app/mcp_tasks/` converts external task notifications into Runs with source information.
5. `backend/packages/harness/deerflow/tools/builtins/task_tool.py` triggers sub-agents; `SubagentLimitMiddleware` limits concurrency/total volume.
6. Sub-agents share run resources, event namespaces, and budgets, but must isolate context and output.
7. `extensions/` and `extension-api` provide extension points for middleware, tools, and building observability.

## 4. Key Objects and Contracts

| Entry/Capability | Must Reuse | Cannot Self-Build |
| --- | --- | --- |
| IM channel | `start_run`, reply routing | Proprietary Run state machine |
| Scheduler | Idempotence, admission, cancellation, lease | Direct model calls |
| MCP task | Source tagging, admission, events | Bypassing input sanitation |
| Subagent | Same Run budget/capacity/events | Second Gateway |
| Extension | Contract registration, scope policy | Directly modifying Kernel state |

## 5. An Observable Chain

~~~text
External input
  → channel / scheduler / MCP adapter
  → RunCreateRequest (reliable metadata + context)
  → start_run
  → pending
  → worker
  → lead agent
  → task/subagent (restricted concurrency)
  → Father Run journal / SSE
~~~

Observation point: Runs generated from different entry points should share the same state machine, event format, and terminal state; differences should only exist in input normalization, response routing, and source metadata.  

## 6. Experiments

### Experiment A: Compare two entry points

Create a Run from HTTP and IM separately, recording `RunRecord` after task acceptance. Acceptance reference: state transitions, idempotency, lease, and event shape should be consistent, with only the source field being different.

### Experiment B: Trigger sub-agent limit

Have the model initiate more than `max_concurrent_subagents` task calls. Observation reference: excess calls are cut off/rejected by middleware, not decided by the model itself.

### Experiment C: Add a read-only extension

Inject an observer through the extension to record assembly information. Acceptance reference: does not change Run permissions or state, only consumes public contracts.

### Reference Answers for Experiments

1. Two entry points should produce the same Run state machine, idempotency, lease, and event shape, with only source/metadata differing; if the state machine is different, it indicates the channel bypassed the task acceptance interface.
2. Calls exceeding `max_concurrent_subagents` should be rejected or truncated by middleware; the model must not bypass capacity on its own.
3. Read-only observers can only consume public contracts and cannot change Run permissions, state, or write paths; extensions must not become a second execution authority.

## 7. Failure and Recovery

| Failure | What to check | Recovery principle |
| --- | --- | --- |
| IM message duplication | Channel idempotency key | Reuse the same Run, avoid duplicate side effects |
| Replayed scheduled task | `start_run` idempotency | Do not create a second task |
| Sub-agent over capacity | Server capacity and middleware | Queue/reject, do not relax boundaries |
| MCP notification loss | Task store and events | Resend from persistent record |
| Extension throwing an exception | Scope and isolation | Downgrade extension, do not break main Run |

## 8. Self-Test for Clearance

1. Why can't the IM channel call the Agent graph directly?
2. What do sub-agents share with the parent Run, and what is isolated?
3. Which capabilities need to be reused for scheduled tasks?
4. Why can't extensions write the Run terminal state directly?

### Reference Answers

1. Direct calls bypass `start_run` permissions, model whitelist, input sanitization, idempotency, lease, events, and delivery. The channel layer should only translate inputs and deliver responses.
2. Share the same Run budget, capacity, event namespace, and lifecycle; isolate sub-task context, tool permissions, and output boundaries to avoid mutual contamination or infinite expansion.
3. Reuse unified task acceptance, idempotency key, thread ownership, cancellation, lease, SSE/events, delivery, and audit; scheduler only decides "when to initiate," not "how to execute." 
4. The terminal state is a control-plane fact and must be written by the worker/manager holding the lease after delivery evidence closure. Excessive writing by extensions could cause some states to be unverifiable, conflict with the journal, or overwrite the legitimate owner.

## 9. Source Code Coordinates

- `backend/app/channels/`
- `backend/app/scheduler/`
- `backend/app/mcp_tasks/`
- `backend/packages/harness/deerflow/tools/builtins/task_tool.py`
- `backend/packages/harness/deerflow/agents/middlewares/subagent_limit_middleware.py`
- `backend/packages/extension-api/`
- `backend/packages/harness/deerflow/extensions/`

## 10. Next Steps

Enter Stage 8: All functions are connected; how to use testing, boundaries, and observation to prove it hasn't broken the system?
