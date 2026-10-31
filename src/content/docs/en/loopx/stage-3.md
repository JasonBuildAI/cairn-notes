---
title: "Stage 3: Turn Planning and Transactions"
description: "Stage 3: Turn planning and affairs. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: LoopX Source Code Course · Stage Paper
> Pre-Run: Stage 2, Understanding should-run
> Overview of Matches: `turn-lifecycle.md`
> Goal of this stage: Clearly understand the identity, envelope, seven-stage and settlement plan of a Turn. 

## 1. This stage addresses what to address

Access only answered "can start." Turn plans to answer tougher contract questions: 

- Which turn is this, exactly? 
- Which Goal/Todo/agent/session is it bound to? 
- What is the maximum amount of context a host can see? 
- After completion, in what order should verification, write-back, consumption, and scheduling be followed? 
- After a crash, which prefix should you continue from, and which effects can't be redone? 

## 2. Remember one judgment first

**Turn is not a one-time function call but a contract that can be persisted, recovered, and has idempotent identities.** 

Once a plan is established, subsequent layers should not reinterpret "what to do this round." Host, validation, writeback, spend, and scheduler all revolve around the same identity. 

## 3. Source code main storyline

1. `loopx/control_plane/turn_driver/driver.py` Organize the Turn plan and executable paths based on route/goal/todo. 
2. `transaction.py::build_loopx_turn_transaction_plan()` Calculate `turn_key` to generate a list of stages and a settlement plan. 
3. `turn_transaction_contract.json` is the factual source of the stage sequence: `host_execute`, `typed_result`, `validation`, `durable_writeback`, `quota_spend`, `scheduler_apply`, `scheduler_ack`. 
4. `effect_program.py::TURN_TRANSACTION_PHASES` From the contract loading phase, `SettlementStepKind` defines the provider-level settlement action. 
5. `quota/turn_envelope.py` Assemble this round of envelope, `turn_envelope_budget.ts` responsible for byte budget and overlimit diagnostics. 
6. `turn_driver/executor.py` Only accept `turn_key` that is consistent with the plan during execution. 

## 4. Key Objects and Contracts

| Object | Function | Key invariants |
| --- | --- | --- |
| `turn_key` | Turn standard hash identity | Same as lineage/host/mode/scheduler/session Stable | input
| `turn_instance_id` | Distinguish specific instances when needed | After normalization, it can replace the default turn_key to bind |
| `turn_envelope` | Host Visible context for this round | Bounded, measurable, fields belong to the current decision |
| `transaction.phases` | Settlement stage sequence | Can only advance by prefix |
| `commit_policy` | Submit the Cause | `result<validate<writeback<spend;apply<ack` |
| `settlement_plan` | Provider settlement steps | validation is owned by turn_driver and is not a provider effect |
| `receipt_seed` | Initial receipt | `not_executed`, and points to the first stage |

### Why turn_key Standardize Hashing

If you put timestamps, random UUIDs, or natural language digests into identity, the same round will be counted as a new turn after reboot, and writeback and spend may duplicate. The source code generates stable keys using normalized fields and canonical JSON/SHA-256, while business randomness is only set in explicit `turn_instance_id`. 

### Why Envelope Has a Budget

More Host context is not always better. Envelope requires routes, selected Todo, gate, evidence requirements, resume conditions, and output contracts; Exceeding the budget squeezes out the actual task information. So the budget first protects the "current round contract" before accommodating interpretive projections. 

## 5. An observable link

```text
should-run payload
  → route and selected Todo
  → lineage / host / execution_mode / session_action
  → turn_key
  → turn_envelope (within budget projection)
  → transaction phases + settlement_plan
  → receipt_seed
  → host request
```

During debugging, first print `turn_key`, then look at `transaction.phases` and `receipt_seed.next_phase`. If the three do not match, do not continue execution.

## 6. Experiment

### Experiment A: Compare the turn_key of two plans

Construct two plans with the same lineage/host/mode/session to confirm `turn_key` is the same; only change `session_action` or host to confirm the change.

### Experiment B: Observe the stage order

```powershell
Get-Content loopx\control_plane\turn_transaction_contract.json
rg -n "commit_policy|effect_ref|settlement_plan" loopx\control_plane\turn_driver\transaction.py
```

Acceptance Criteria: Able to write the Seven Stages and `result<validate<writeback<spend;apply<ack;cadence:no-spend` word for word.

### Experiment C: Creating Envelope Overrun

Inject large, recomputable instructions into the test to trigger `turn_envelope_budget_exceeded`. Reference Observation: The system reports a warning/excess instead of quietly deleting the identity or settlement fields.

### Experiment Reference Answers

1. The same lineage/host/mode/session should produce the same turn_key; changing session_action or host changes the identity, preventing reuse of the same key across different transactions.
2. The Seven Stages and order should be written word for word: `result < validate < writeback < spend; apply < ack; cadence: no-spend`.
3. Envelope overrun only reports a warning/excess; identity, receipt, and settlement fields cannot be silently deleted.

## 7. Failures and Recovery

| Failure | Root Cause | Recovery |
| --- | --- | --- |
| turn_key inconsistent with the plan | identity rebuilt / field drift | Reject execution and return to plan generation |
| receipt not found in plan | plan not persisted or version mismatch | Do not recreate receipt; fix persistence boundary |
| Stage jump | caller skipped prerequisites | Only allow the next stage after completed prefix |
| Envelope overrun | too many projections | Reduce non-contract fields, recompute the budget |
| effect_ref empty | identity incomplete | Prevent provider execution, fix identity first |
| New key generated after restart | random fields went into hydration | Move randomness to turn_instance_id |

## 8. Self-Test

1. What is the difference between `turn_key` and `turn_instance_id`?
2. What are the Seven Stages?
3. Why is `commit_policy` not an ordinary comment?
4. Why does validation not belong to Provider effects?
5. Why can't fields be directly deleted when envelope exceeds budget?
6. Why does receipt_seed start from `not_executed`?

### Reference Answers

1. `turn_key` is computed from stable lineage/host/mode/scheduler/session identity, representing a logical Turn by default; `turn_instance_id` is an explicit instance identity used for stable binding when distinguishing multiple instances is needed, and random numbers should not be secretly inserted into turn_key.
2. `host_execute → typed_result → validation → durable_writeback → quota_spend → scheduler_apply → scheduler_ack`; a completed Turn may also append a terminal closeout provider effect.
3. It specifies the observable commit order: results appear first, validation allows write-back, write-back occurs before consumption, ack only after apply; code, testing, and recovery all rely on this order.
4. Validation is completed independently by the turn_driver based on typed results, evidence, and domain contracts; it is not a side effect declared by the Provider itself. Providers can only provide write-back, consumption, and closeout effects.
5. Fields may carry identity, route, gate, receipt binding, or recovery conditions. The correct approach is to compress recomputable content according to projection priority while retaining contract fields.
6. It indicates that the plan is established but not yet executed; each subsequent checkpoint can only advance along completed stages and cannot claim that a stage has been submitted.

## 9. Source Code Coordinates

- `loopx/control_plane/turn_driver/driver.py`
- `loopx/control_plane/turn_driver/transaction.py`
- `loopx/control_plane/turn_transaction_contract.json`
- `loopx/control_plane/effect_program.py`
- `loopx/control_plane/quota/turn_envelope.py`
- `loopx/control_plane/quota/turn_envelope_budget.ts`
- `loopx/control_plane/turn_driver/executor.py`

## 10. Next Steps

Enter Stage 4: The plan lists Host and Capability; what can each do, and what can't they do? How does a typed result become a verifiable result?
