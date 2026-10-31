---
title: "Stage 8: Engineering and Troubleshooting"
description: "Stage 8: Engineering and troubleshooting. Understand facts, contracts, observable evidence, and failure recovery along the main source code path."
---

> Course: DeerFlow Source Code Class · Stage Exam
> Prerequisite: Stages 0–7
> Corresponding Overview: `engineering.md`
> Goal of this Stage: Use "hierarchy   evidence" to locate problems, rather than guessing from scratch.

## 1. What this Stage Solves

Failures in Agent systems are rarely single points:

~~~text
Request failed
  ├─ Order Taking/Permissions/Configuration
  ├─ worker/lease/State Machine
  ├─ Assembly/Model/Context
  ├─ Tool/sandbox/Approval
  Persistence/Delivery/Frontend
~~~

Engineered work is about turning each layer into a testable, observable, and rollbackable contract.

## 2. First, remember a judgment

**First identify "which type of factual inconsistency," then decide which layer of code to look at.**

A page not displaying, SSE breaking, Run succeeding but no file, the model being repeatedly called, all point to different sources of facts. Do not use a universal log search to replace layered judgment.

## 3. Source code mainline

1. `backend/tests/test_harness_boundary.py` Enforce a unidirectional dependency between the kernel and app.
2. Run lifecycle tests cover `pending`, cancellation, idempotency, lease, recovery, and terminal state.
3. Middleware tests cover tool pairing, budgeting, read-before-write, empty responses, and terminal state protection.
4. Sandbox tests cover path mapping, provider, lease, out-of-bounds and truncation.
5. `RunJournal` and event store provide time order for debugging; trace/usage provide cross-layer correlation.
6. `engineering.md` provides experimentation and fault matrices, serving as a companion exercise book for this chapter.

## 4. Key objects and contracts

| Evidence | Can answer | Cannot answer |
| --- | --- | --- |
| RunRecord | Whether Run is registered/started/terminal | Why the model responded this way |
| journal | Process events and tokens | Complete graph state |
| checkpoint | How far graph execution has reached | Whether external messages have been sent |
| tool receipt | Tool invocation facts | Whether side effects were visible to the user |
| trace/log | Cross-service call chains | Whether business delivery is real |

## 5. An observable chain

~~~text
Symptoms
  → Check RunRecord: Is there a work order/owner/lease
  → Check journal: What was the last successful event
  → Check checkpoint: Can the model continue running
  → Check tool receipt/outputs: Whether side effects occur
  → Check SSE/event store: Is what the audience sees consistent
  Go back to the corresponding layer and write the minimal reproduction
~~~

## 6. Experiments

### Experiment A: SSE and Fact Separation

Disconnect the browser and then reconnect. Acceptance reference: Real-time events may be lost during disconnection, but persistent events and Run status can still be read; the UI should not rerun the Run based on this.

### Experiment B: Empty Response

Have the provider return an empty AIMessage. Observation reference: `TerminalResponseMiddleware` triggers a retry or visible error once, rather than silently succeeding.

### Experiment C: Boundary Regression

Run boundary tests after temporarily importing the app into the harness. Acceptance reference: The test fails, and the error points to a dependency direction, not business logic.

### Experiment Reference Answers

1. Reconnecting only restores real-time views/history events and cannot be used to determine that a Run is incomplete and rerun it; the final facts come from RunRecord, journal, and checkpoint.
2. An empty response should trigger terminal state protection, one controlled retry, or a visible error, and cannot silently succeed.
3. Boundary tests after temporarily importing app into the harness should fail, and the error should point to a dependency direction violation rather than a business assertion.

## 7. Failures and Recovery

| Symptom | Most Likely Layer | First Evidence |
| --- | --- | --- |
| Request 400 | Order/Whitelist | Request validation and model configuration |
| Run always pending | Worker/Queue | RunRecord and lease |
| Duplicate tool writes | Idempotency/Middleware | Journal and receipt |
| Success but no output | Delivery verification | Delivery content and outputs |
| Frontend duplicate messages | Event projection/consumer | Event sequence and message ID |

## 8. Self-Test

1. Why is boundary testing more reliable than code review?
2. How to determine if a problem is "inside the graph" or "outside the graph"?
3. If a Run succeeds but files do not exist, which two layers should be checked first?
4. Why can't logs replace receipts?

### Reference Answers

1. Code review can only sample; boundary testing continuously verifies all import relationships in CI and can prevent unintentional reverse dependency buildup.
2. First check if the checkpoint/journal recorded the graph nodes and model/tool events. If the graph has ended normally, the issue is likely in delivery, event projection, or UI; if the graph did not progress, the problem is in assembly, model, tool, or state.
3. First check delivery verification and receipt, then check the actual files and path mappings in sandbox/outputs. Do not just look at model text or the Run's `success` field.
4. Logs are observation outputs; they may be missing, truncated, or not guarantee order; receipts are factual evidence tied to calls/Runs. Proof of side effects should rely on receipt, readback, and outputs, not "seems to be in the logs."

## 9. Source Code Coordinates

- `backend/tests/test_harness_boundary.py`
- Run, middleware, sandbox tests under `backend/tests/`
- `backend/packages/harness/deerflow/runtime/journal.py`
- `backend/packages/harness/deerflow/runtime/events/`

## 10. Next Steps

Enter Stage 9: Choose a real refactor, and link order, assembly, execution, evidence, and recovery into your own project.
