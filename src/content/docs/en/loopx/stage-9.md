---
title: "Stage 9: Capstone Project"
description: "Stage 9: Capstone Project. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: LoopX Source Code Course · Stage Assignment
> Prerequisite: Stages 0~8
> Corresponding Overview: Design exercises in `engineering.md`
> Goal of this Stage: Complete a verifiable, settleable, and recoverable Capability design, rather than writing another summary.

## 1. What this Stage Solves

After reading the first eight stages, the real test is not reciting stage seven, but whether you can add a domain capability to LoopX without breaking:

- Fact ownership and projection boundaries;
- Admission for Goal/Todo/claim/gate/quota;
- Host's privilege of only producing candidate results;
- The sequence: validation → writeback → spend;
- Crash recovery driven by journal/receipt;
- Single source of truth in CLI/Dashboard.

This design exercise uses an example of a "Document Delivery Capability": the Agent must generate a review material and deliver it to a controlled channel. The difficulty is that "file generated" does not equal "delivery completed".

## 2. First Remember a Judgment

**The core of Capability design is not utility functions, but "what evidence can drive a state transition."**

If you cannot define evidence, cannot read it back after a crash, or cannot distinguish normal delivery from recovery, no matter how callable your tools are, the design is still inadequate.

## 3. Source Code Mainline: Implement as a First-Class Citizen

1. In `capabilities/catalog.py`, refer to existing Capability declarations for success conditions, evidence, and transitions.
2. In `capabilities/registry.py`, register Provider, implementation, and `declared/installed/enabled/ready` lifecycle.
3. In `control_plane/capability_hooks.py`, only project the context needed for this round, without exposing internal handles to the Host.
4. In `turn_driver/host_candidate.py`, define typed result fields that can be used for validation.
5. In `turn_driver/executor.py`, check scope, evidence, and completion lifecycle at the validation layer.
6. In `turn_driver/settlement.py`, write back, consume, and close only via effect/readback.
7. In `turn_driver/turn_contract_generated.py` and `turn_transaction_contract.json`, maintain consistency in result/phase terminology.
8. In `presentation/` and `status.py`, add read-only projection without adding new fact buckets.
9. In `tests/`, add success, rejection, repeat execution, crash recovery, and public safety use cases.

## 4. Key Objects and Contracts

### Task: Controlled Document Delivery

It is recommended to define two material transitions:

| transition | evidence | settlement |
| --- | --- | --- |
| `draft_ready` | File path, content digest, generation command receipt | Write back draft status, continue waiting for approval |
| `delivery_completed` | Channel message id, target scope, approval receipt, content digest | Write back delivery status, schedule follow-up/close |

At a minimum, also include:

- `wait`: Waiting for owner approval, no quota consumed, save resume condition;
- `host_failure`: Generation failed, do not consume, do not write back delivery success;
- `repair_required`: Evidence missing fields, path out-of-bounds, or digest mismatch;
- `terminal_closeout_failed`: Delivery submitted, but lifecycle closure failed.

### Design Tables that Must Be Written Out

| Question | Your answer must explain |
| --- | --- |
| Source of Fact | Where are draft, approval, and delivery stored, and who is canonical |
| Provider | What layer (declared/installed/enabled/ready) are the generator and channel |
| Host Boundary | What scopes can the Host know at most, and which fields can it return |
| Evidence | How to prove that the target channel received the same content |
| Idempotency | How repeated Turns use effect_ref/channel id to prevent duplicate delivery |
| Recovery | Where to inject crashes at 5 points, and which phases to supplement for each |
| Projection | What the Dashboard displays, and why it cannot reverse-modify delivery status |
| Safety | How to handle paths, credentials, public-safe output, and unauthorized channels |

## 5. An Observable Chain

```text
Goal: Submit review materials
  → Todo: Generate Draft
  → should-run / claim / gate
  → Host Generate file (candidate)
  → validation: path + digest + scope
  → writeback: draft_ready
  → spend
  → wait: owner approval(no-spend)
  → New Turn: delivery
  → validation: approval + content digest
  → writeback: delivery_completed
  → spend + scheduler
  → closeout
  → refresh frontier
```

Note that approval before and after are two separate logical Turns. Waiting for approval should not consume quota, nor should it allow the Host to poll for permanent execution.

## 6. Experiment: Five Mandatory Deliverables

### A. Capability Contract

Write a one-page contract: success criteria, evidence, error classification, transition, scope, public-safe fields. Acceptance criteria: another engineer can determine when completion is valid without looking at the implementation.

### B. Provider Lifecycle

Document the manifest/state changes of generator and channel Providers. Acceptance criteria: cannot install if not declared, cannot enable if not installed, cannot reach ready if not enabled; if channel credentials are missing, go through the capability gate.

### C. Crash Matrix

Inject failures at five points: after Host, after validation, after writeback, after spend, after scheduler/closeout. For each point, describe the submitted facts and the only valid recovery action.

### D. Idempotency Experiment

Execute the same Turn twice. Acceptance criteria: the second time reads the existing effect/receipt, without regenerating or redeploying; if the content digest differs, explicitly report a conflict.

### E. Projection Experiment

Manually tamper "Delivered" on the Dashboard and refresh. Acceptance criteria: return to canonical state; the presentation layer does not maintain its own delivery table.

### Sample Answers for Experiments

1. The contract must allow others to determine if completion is valid based only on success criteria, evidence, error classification, transition, scope, and public-safe fields.
2. The lifecycle should reflect declared → installed → enabled → ready, and missing channel credentials should go through the capability gate rather than causing a runtime crash.
3. All five crash points should clearly specify submitted facts and the sole valid recovery action: after Host, validation, writeback, spend, scheduler/closeout, only the missing stage is added.
4. Re-running the same Turn should hit existing effect/receipt without regenerating/redeploying; the same identity with a different content digest must explicitly indicate a conflict.
5. After manual tampering, a refresh should return to the canonical delivery state; the Dashboard cannot maintain its own delivery facts table.

## 7. Failure and Recovery

| Design Flaw | Consequence | Fix |
| --- | --- | --- |
| Treating file existence as delivery | Generated but not delivered | Completion evidence must include channel receipt |
| Using filename as idempotency key | Overwrites/redeploys with the same name | Use content digest + effect_ref/channel id |
| Spending before approval | Waiting also deducts quota | Wait is no-spend; start a new Turn after approval |
| Host writes directly to Dashboard | Double source of truth | Only through writeback; presentation layer is read-only |
| Completion without lifecycle | Task left hanging | Add successor/active goal/no_followup |
| Readback failure triggers rerun | Duplicate deployment | Check channel/effect first, then recover |
| Rerunning Host during recovery | Duplicate generation/side effects | Continue from completed_phases prefix |

## 8. Self-Check

1. Why can "file generated" not directly equal delivery completion?
2. Why should approval waiting be designed as a no-spend Turn?
3. Idempotency of repeated channel delivery relies on what facts?
4. After crashing post-spend, why not regenerate the document during recovery?
5. Why must Capability design also define failure classifications?
6. How to prove the Dashboard has not become a second source of truth?

### Reference Answers

1. File existence only proves local generation, not that the target channel received it, that content matches, permissions are correct, or the owner has approved. Completion requires channel receipt, content digest, scope, and lifecycle evidence.
2. Approval waiting does not advance work, nor is there provable delivery; charging during this time incurs cost without benefit and complicates recovery. Save the resume condition and start a new delivery Turn after approval passes.
3. Use a stable effect_ref, and write the channel message id, target scope, content digest into the receipt; on retry, readback first, reuse if present, report a conflict if the content differs.
4. Host execution and writeback are complete; only scheduling/closeout wasn't submitted. Rerunning Host would regenerate or change content; recovery only reads the receipt and completes scheduling/closeout.
5. Different failures correspond to different responsibilities and recoveries: Host failure fixes executor, validation failure supplies evidence, writeback failure fixes state contract, spend failure reconciles ledger, closeout failure only completes finale. Without classification, retries are blind.
6. After tampering and refreshing, the state returns to canonical fact; verify all write operations went through typed commands, authority, writeback, and receipt, and ensure the presentation layer has no independent persistence.

## 9. Source Code Coordinates

- `loopx/capabilities/catalog.py`
- `loopx/capabilities/registry.py`
- `loopx/control_plane/capability_hooks.py`
- `loopx/control_plane/turn_driver/host_candidate.py`
- `loopx/control_plane/turn_driver/executor.py`
- `loopx/control_plane/turn_driver/settlement.py`
- `loopx/control_plane/turn_transaction_contract.json`
- `loopx/presentation/`
- `tests/test_turn_loop_disposition.py`
- `tests/test_state_recovery.py`

## 10. Completion Criteria

You should be able to place your own Capability back into the entire main chain and clearly answer:

```text
Why run now?
Which thing should I run?
Host Can only see what and return what?
What evidence allows write-back?
Should I write back first or consume first?
After which step fails, do you only fix that step?
Where will the next round of frontier be recalculated from?
```

Only by being able to answer these seven questions can you be considered to have truly finished learning the LoopX control interface.
