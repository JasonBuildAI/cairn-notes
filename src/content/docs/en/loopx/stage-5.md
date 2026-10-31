---
title: "Stage 5: Verification, Write-back, Quota, and Scheduling"
description: "Stage 5: Validation, write-back, quotas, and scheduling. Understand facts, contracts, observable evidence, and failure recovery along the main line of the source code."
---

> Course: LoopX Source Code Class · Stage Exercises
> Prerequisite: Stage 4, understand Capability, Provider, and Host result
> Corresponding overview: Settlement section of `turn-lifecycle.md`
> Goal of this phase: Master result kind, commit order, terminal closeout, and prefix recovery after crashes.

## 1. What this phase addresses

After the Host returns results, the system faces a series of problems that cannot be merged:

- Does this result have evidence, and can it enter a long-term state?
- If it can, should the state be written first or the quota deducted first?
- Does the written state include the Todo lifecycle, subsequent goals, or terminal closeout?
- How far should the scheduler's RRULE be applied, and when to ack?
- In case of a crash in the middle, from which phase should the next round continue?

LoopX's answer is a seven-phase transaction, rather than "stuff all side effects into a try".

## 2. Remember a rule first

**Host execution and typed result are only the first half; only when validation, writeback, and spend all commit does the Turn have provable delivery.**

`quota_spend` comes after `durable_writeback` because spending must be proven by an accepted state change; conversely, deducting fees before a writeback failure leaves bad debt that cannot be safely refunded or recharged.

## 3. Source Code Mainline

1. `transaction.py` defines phase order, material/no-spend result collections, and failure phase mapping.
2. `executor.py::_task_validation_stage()` checks result and evidence, deciding whether to enter material settlement or stop.
3. `settlement.py::execute_turn_driver_settlement()` sequentially performs validation, durable writeback, quota spend, and terminal closeout.
4. `quota/spend_commit.py` uses run-index CAS and `effect_ref` to ensure no double consumption.
5. `executor.py` calls scheduler callback after spend, completing apply/ack or leaving recovery actions pending.
6. `terminal_closeout_requirement()` determines whether completion requires closing Goal/Todo/scheduler.

## 4. Key Objects and Contracts

### Three sets of result kind

| Group | Type | Meaning |
| --- | --- | --- |
| material | `validated_progress`, `validated_completion`, `repair_required`, `replan_required` | Controlled state changes that require settlement |
| no-spend | `user_action_required`, `wait`, `iteration_failed`, `host_failure`, `validation_failed`, `writeback_failed`, `quota_spend_failed` | Do not consume quota and cannot masquerade as success |
| terminal failure | `terminal_closeout_failed` | First five phases committed, only closeout missing |

`validated_progress` indicates there is evidence but not completed; frontier is recalculated after settlement; `validated_completion` must declare successor, active goal, or `no_followup`, and may need a lifecycle adapter.

### Commit Order

```text
host_execute
  < typed_result
  < validation
  < durable_writeback
  < quota_spend
  < scheduler_apply
  < scheduler_ack
```

Besides semicolons, there is also cadence semantics: `apply<ack; cadence:no-spend`. The scheduled cadence cannot fake a single consumption, and ack cannot skip over an already applied RRULE.

### Key Objects

| Object | Fact | Recovery Purpose |
| --- | --- | --- |
| `effect_ref` | Stable reference of this external effect | Replay and deduplication |
| `completed_phases` | Ordered prefix of the committed stage | Determine where to continue |
| `quota_spend` receipt | Which consumption has been committed | Prevent double charging |
| scheduler receipt | How far apply/ack has reached | Avoid modifying cadence repeatedly |
| terminal closeout receipt | Whether the terminal has been closed | Only fill in missing closeouts |
| recovery decision | Allow continuation or block | Preserve audit and refusal reasons |

## 5. An Observable Chain

```text
typed result
  → validation (evidence/scope/transition)
  → durable writeback (status + lifecycle)
  → quota spend(effect_ref + run-index CAS)
  → scheduler apply(RRULE/ownership)
  → scheduler ack (acknowledged as applied)
  → terminal closeout (completion only  + no_followup)
  → refresh-state
```

During debugging, use the journal's `completed_phases` as the sole progress scale. Do not assume submission based on "the log looks complete." 

## 6. Experiment

### Experiment A: Compare progress with completion

Construct two typed results: one `validated_progress` and one with a lifecycle adapter `validated_completion`. Reference acceptance: the former writes back and continues frontier, the latter enters closeout to check; Completion missing a successor/intent is rejected. 

### Experiment B: Interrupt after writeback

Interrupts when `durable_writeback` has been recorded in journals but not yet `quota_spend`. Reference acceptance: Restore only spend, do not rerun Host, do not write back; `effect_ref` Maintain the same value. 

### Experiment C: Interrupt after spend

Interrupts when spend is committed or scheduler apply/ack is not completed. Reference acceptance: Resume reading spend receipt, only supplementing the scheduling phase; Never spend quotas again. 

### Experiment D: Failing to create closeout

Causes the terminal closeout adapter to report an error. Reference acceptance: The result becomes `terminal_closeout_failed`, recovery only closeout is added; Host, writeback, and spend are not redone. 

### Experimental Reference Answers

1. After writing progress, continue frontier; Only valid completion entries enter closeout. Completion without lifecycle or successor should be rejected. 
2. Restore only `quota_spend`; Host and durable writeback do not rerun, `effect_ref` remain consistent. 
3. After reading the spend receipt, only add the scheduler apply/ack, never consuming the quota again. 
4. If a closeout fails, it should become `terminal_closeout_failed`; restore only closeout; Host, writeback, and spend are all completed and cannot be redone. 

## 7. Failure and recovery

| Failure point | Submitted facts | Absolutely must not be done again |
| --- | --- | --- |
| validation failed | Host executed, typed result | No writeback, no quota spent |
| writeback failure | First three stages | Do not spend, keep the original receipt Fix |
| spend conflict/failure | First four stages | Cannot be changed effect_ref Heavy deduction, first readback |
| Scheduler apply failed | First five stages | Cannot be rewritten or consumed |
| scheduler ack failed | apply completed | Only add ack, no rollback fact |
| closeout failure | First five stages and scheduling | Only closeout | is added
| journal inconsistency | unknown prefix | Block and edit journal, don't guess progress |

## 8. Pass through customs and self-test

1. Why do both `validated_progress` and `validated_completion` need to be settled, but the next round is different? 
2. Why must `quota_spend` be placed after `durable_writeback`? 
3. `validated_completion` Why can't the lifecycle adapter be automatically downgraded when it is missing? 
4. `terminal_closeout_failed` At what stage has it been committed? Can the host be restarted upon recovery? 
5. What should be done to restore when scheduler apply succeeds but ack fails? 
6. `no-spend` Why is it still possible to leave a journal as a result? 

### Reference answers

1. Both change the long-term state being verified, so write back and consume it; progress only advances unfinished work; the next round of recalculation frontier continues; completion also arranges successors, switches active goals or `no_followup`, and triggers endgame closure. 
2. Write back to ensure delivery is only provable after acceptance. Spending first and then writing back fails will leave bad debt with "deducted but no status change"; Write back first to give spend a clear pre-receipt, which also allows recovery to judge whether consumption is appropriate. 
3. Completion changes the Goal/Todo lifecycle; without an adapter, it is impossible to determine who continues, whether to close, or how to leave traces. Automatic downgrading falsifies completion or leaves tasks suspended, so validation should fail and contract completion must be requested. 
4. The first five stages (Host, typed result, validation, writeback, spend) and completed schedules are all factual, only missing closeout. Recovery can only be done by adding closeouts; never rerun the Host, repeat writeback, or spend again. 
5. Read the apply receipt, confirm that the RRULE is implemented, and only add ack. You cannot roll back apply and re-consume it, nor treat the entire round as unexecuted just because the ack is missing. 
6. No-spend only means no quota is deducted, but does not mean there is no process fact. Journal still records host failures, validation failures, or waiting conditions for diagnosis, deduplication, and the next recovery. 

## 9. Source code coordinates

- `loopx/control_plane/turn_driver/transaction.py`
- `loopx/control_plane/turn_driver/executor.py`
- `loopx/control_plane/turn_driver/settlement.py`
- `loopx/control_plane/effect_program.py`
- `loopx/control_plane/quota/spend_commit.py`
- `loopx/control_plane/scheduler/arbitration.py`
- `loopx/control_plane/scheduler/heartbeat_commit.ts`
- `loopx/control_plane/scheduler/execution_context.py`

## 10. Next Steps

Enter Stage 6: After the settlement, the state has changed. From where will the context seen by the next round of models be reconstructed? Which are facts and which are just projections?
