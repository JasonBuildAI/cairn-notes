---
title: "Stage 2: Should-Run and Quota"
description: "Stage 2: ShouldRun and Quota. Understand facts, contracts, observable evidence, and failure recovery along the main source code path."
---

> Course: LoopX Source Code Class · Stage Test  
> Prerequisite: Stage 1, understanding Goal, Todo, Claim, Gate, and projection  
> Corresponding overview: Admission part of `turn-lifecycle.md`  
> Goal of this stage: Break `should_run=false` into different reasons, and explain why `true` is still not authorization for arbitrary actions.

## 1. What this stage solves

The most common mistake of long-term agents is not 'can't do,' but 'doing when they shouldn't.' Before entering a Turn, LoopX first calculates a quota should-run decision to answer four questions:

- Is there currently any work that can be handled?  
- If not, who or what is it waiting for?  
- If allowed to run, which Goal/Todo route should run?  
- Does this permission only apply to recovery, observation, or a specific action, rather than all actions?

`should_run` is the conclusion at the admission layer, not the model's own judgment, nor proof of task completion.

## 2. Remember one judgment first

**`should_run=false` is not a state; `should_run=true` is not a blank check.**

The former has at least six sources: health, manual gate, focus wait, external waiting, throttling, and hard pause; the latter still needs to pass constraints from capability, interaction contract, workspace/action authority, and the current envelope.

## 3. Source code mainline

1. `quota/states.py` defines state priorities: `blocked_health`, `operator_gate`, `focus_wait`, `eligible`, `waiting`, `throttled`, `paused`.  
2. `build_quota_should_run()` summarizes facts about Goal, Todo, claim, gate, quota, and scheduler, generating candidate routes.  
3. `live_decision.py` adds real-time input: external wake-up, monitor, interaction contract, automation liveliness, and normal delivery permissions.  
4. `should_run_packet.py` assembles internal judgments into JSON consumable by the Host, attaching capability gate and envelope.  
5. `turn_envelope_budget.ts` checks the 8,192-byte base budget and generates `turn_envelope_budget_exceeded` diagnostics.

## 4. Key objects and contracts

| Object | Questions answered | Misuse |
| --- | --- | --- |
| `quota.state` | What is the current primary admission state | Treat all false as 'no work' |
| `should_run` | Whether entering a Turn candidate is allowed | Treat as permanent permission for all tools |
| `route` | Whether this round follows normal delivery, recovery, observation, or waiting | Bypass Goal/Todo scope |
| `capability_gate` | Whether a capability is missing, disabled, or not ready | Let Host guess an alternative action |
| `normal_delivery_allowed` | Whether delivery can follow the normal product path | Treat recovery path as normal completion |
| `interaction_contract` | Boundaries for human-computer interaction, approval, and notification | Directly rewrite as natural language advice |
| `automation_liveness` | Whether automatic rounds are still alive, whether to wake up | Continue running with old heartbeat |
| `turn_envelope` | The Host's visible and bounded contract package this round | Pack all history with no limit |

### Correct classification of `false`

| Category | Typical meaning | Next action |
| --- | --- | --- |
| Health blocking | Registry/state/contract corruption | Fix facts first, do not run Host |
| Manual gate | `user_gate` waiting for owner decision | Notify human, save waiting condition |
| Focus wait | No current driving focus or must avoid manual sections | Re-select focus or wait |
| External wait | Monitor, external events, dependencies not ready | Save resume condition |
| Throttling | Just ran, or cadence not reached | Calculate next valid window |
| Hard pause | Goal stopped or compute quota is zero | Owner must change strategy |

### `true` is still restricted

During `normal_delivery_allowed=false`, the system may allow recovery or observation but does not allow treating the outcome as normal delivery. `capability_gate` indicates unmet capability prerequisites; `interaction_contract` indicates whether confirmation is needed and whether sending is allowed; `automation_liveness` indicates whether the automatic round still has a legal lifecycle. A real action still requires typed authority.

## 5. An observable chain

```text
Goal state + Todo frontier + claim/lease + gates + quota
  → candidate route
  → live monitor / wake / interaction inputs
  → capability gate
  → normal_delivery_allowed
  → should_run payload
  → turn envelope (<= 8,192 basic bytes)
  → Turn plan
```

During debugging, do not print only `should_run`. At least print `quota.state`, blocking reason, `normal_delivery_allowed`, `capability_gate`, `interaction_contract.kind`, and envelope budget simultaneously. 

## 6. Experiment

### Experiment A: Creating three types of false

Use test fixtures to construct: `paused`, `operator_gate`, `waiting`. Reference acceptance: All three return `should_run=false`, but the reason for `resume` and the next action are different; It cannot be uniformly written as "Retry later". 

### Experiment B: Distinguishing Access from Permission

Retain `should_run=true` while injecting an unready Provider. Reference acceptance: If `capability_gate` appears, the Host should not automatically replace it with a non-existent ability, nor should the failure be marked as a normal completion. 

### Experiment C: Triggering the envelope budget

Expand the recalculable context in testing until it exceeds 8,192 bytes. Reference acceptance: Report `turn_envelope_budget_exceeded` (warning/overlimit diagnosis), identity, receipt, and settlement fields must still remain intact. 

### Experimental Reference Answers

1. All three are false, but the recovery conditions differ: paused waits to lift pause, operator_gate waits for manual access control, waiting waits for external/prerequisite conditions; Cannot retry simultaneously. 
2. A capability gate should appear and block Host from running; it must not be disguised as a ready Provider, nor should it be marked as completed if not executed. 
3. Envelope limit should generate explicit warning/diagnostic and retain identity, receipt, and settlement fields; You cannot reduce it by deleting key fields. 

## 7. Failure and recovery

| Phenomenon | What to check first | Principle of recovery |
| --- | --- | --- |
| Always false but not waiting for reason | `quota.state`, Todo frontier, health | Clarify the reason, do not blindly retry |
| Host overstepped his authority after true | action authority, scope, interaction contract | Refuse at the action entrance, without relying on prompts |
| Capability missing still runs | `capability_gate`, Provider lifecycle | Repair capability or switch to legal waiting |
| envelope over-limit | Projection fields and recalculable content | Compression instructions, do not delete identity/settlement contract |
| Monitor wakes up and still waits | `automation_liveness`, resume condition | Recalculate facts, no longer using old judgments |
| Recovery Wheels Delivered as Normal | `normal_delivery_allowed` | Restore semantics, no disguise completed |

## 8. Pass through customs and self-test

1. `should_run=false` Why can't it be uniformly treated as "no job"? 
2. `should_run=true` What hard boundaries are thereafter? 
3. What do `capability_gate` and `normal_delivery_allowed` restrict respectively? 
4. Why should the wait save the resume condition instead of just writing "See later"? 
5. Why can't fields be indiscriminately deleted when envelope exceeds budget? 
6. Why do we still need to watch auto-wake-up `automation_liveness`? 

### Reference answers

1. The cause of false determines the recovery path: health issues require fact-fixing, manual access control requires human decision, focus wait requires reselecting focus, external wait requires waiting for events, throttling requires window, hard pause requires the owner to change policy. Merging them creates meaningless retries or error wake-ups. 
2. Also require Goal/Todo scope, claim/lease, user gate, workspace guard, typed action authority, capability readiness, interaction/approval, and envelope contracts. `should_run` Only indicates candidacy access, not every tool or side effect is approved. 
3. `capability_gate` Restrict domain capabilities from being declared, installed, enabled, ready, and missing owners; `normal_delivery_allowed` Restrict whether the current round can produce results according to the normal delivery path; restore or observe paths cannot be falsely completed as normal. 
4. Resume condition is a recalculable and auditable factual condition, allowing the next round to determine whether to wait again. Vague "look at it later" has no owner, event, or time basis, and is prone to indefinite idling or premature operation. 
5. Fields may carry turn identity, receipt, gate, scope, and recovery conditions. The correct approach is to compress recalculable interpretive projections, retain contract fields, and make over-limit as visible diagnostics. 
6. Old Heartbeat may have stopped, been paused, lost ownership of the scheduler, or missed the wake-up window. `automation_liveness` Separate "Timer" from "Current Auto Round Still Valid" to avoid expired resurrection execution. 

## 9. Source code coordinates

- `loopx/control_plane/quota/states.py`
- `loopx/control_plane/quota/should_run.py`
- `loopx/control_plane/quota/should_run_prepare.py`
- `loopx/control_plane/quota/should_run_packet.py`
- `loopx/control_plane/quota/live_decision.py`
- `loopx/control_plane/quota/turn_envelope.py`
- `loopx/control_plane/quota/turn_envelope_budget.ts`
- `loopx/control_plane/todos/user_gate.py`

## 10. Next Steps

Enter Stage 3: Access has been granted, and next we must solidify "who exactly in this round, sees what, and in what order submits" into a Turn contract.
