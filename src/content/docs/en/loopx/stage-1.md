---
title: "Stage 1: Object Model and Control Plane"
description: "Stage 1: Object model and control plane. Understand facts, contracts, observable evidence, and failure recovery along the main source code path."
---

> Course: LoopX Source Code Class · Stage Test
> Prerequisite: Stage 0, understand the six-layer map
> Corresponding overview: `overview.md`, `core-mechanisms.md`
> Stage Goal: Clarify the ownership of Goal, Todo, Claim, Gate, Run, and projection.

## 1. What this stage addresses

The most common mistakes in long-term systems are not that the "model isn't smart enough," but that objects are mixed up:

- Treating Goal as a long-term chat;
- Treating Todo as a casual checklist written by the model;
- Treating Claim as "the model says it is responsible";
- Treating Gate as a sorting suggestion;
- Treating run history as a debugging log;
- Treating Status as the source of truth.

This stage puts each object back in its proper place.

## 2. Remember this judgment first

**Goal is "why we keep doing it," Todo is "the next action that can be accepted," Run/Turn is "a bounded execution," Status is "where to look now."**

These four cannot replace each other:
- Completing a Goal does not equal completing a single Todo;
- Checking off a Todo does not equal passing the evidence;
- A successful Turn does not equal completing the Goal;
- Status showing "running" does not mean the process really holds the lease.

## 3. Source Code Mainline

1. `loopx/registry.py`: Register Goal, parse paths, expose global health and canonical runtime root.
2. `loopx/control_plane/goals/state_resolution.py`: Parse the Goal's lifecycle, direction, acceptance, and current frontier into a decision-ready state.
3. `loopx/control_plane/goals/goal_frontier/`: Compute runnable/blocked/waiting frontiers and generate replan and successor rules.
4. `loopx/control_plane/todos/contract.py`: Define Todo's identity, status, scope, dependencies, and field normalization.
5. `loopx/control_plane/todos/completion_transaction.py`: Completion is not just "changing status," but a validated completion transaction.
6. `loopx/control_plane/todos/user_gate.py`: Manual gating, waiting conditions, and recovery.
7. `loopx/control_plane/runtime/run_history.py`: Record execution history for auditing, continuity checks, and recovery.
8. `loopx/status.py`: Compile the above facts into public state and attention projections.

## 4. Key Objects and Contracts

| Object | Question Answered | Ownership | Typical Failure |
| --- | --- | --- | --- |
| Goal | Why keep doing it, what's the boundary | Registry   Goal State | Goal drift, repeated activation |
| Direction | Which direction is still valid | direction/authority contract | old direction overridden without authorization |
| Todo | What to do next, when is it completed | Todo store   completion contract | self-reported completion, bypassing dependencies |
| Claim/Lease | Who is responsible in which scope | claim record and term | two Agents working on the same Todo simultaneously |
| Gate | Which preconditions must be met first | user/capability/workspace gate | treating wait as deny |
| Run/Turn | How far this execution went | journal   receipts | judging success solely by stdout |
| Evidence | Which observations support conclusions | evidence store   validation | writing guesses as facts |
| Projection | Where to look now | status/frontier computation | writing facts backwards from projection |

### Difference between Claim and Gate

Claim answers "who will do it"; Gate answers "can it be done now." Having a claim does not mean passing the gate, and passing the gate does not mean the Todo has been correctly claimed.

### Difference between Evidence and Validation

Evidence is the observed fact; Validation is judging according to domain contracts whether these facts are sufficient to support a transition. Having more evidence does not equal validation being passed.

## 5. An Observable Chain

```text
Goal state
  → calculate frontier
  → Filter done/blocked/waiting/dependency
  Found selected
  Check claim and gate
  → Generate should-run candidates
  Write back to Todo/Goal/evidence after → Turn are completed
  Recalculate frontier
```

Observation Point: After one Turn, first check whether the Todo facts and evidence have changed, then see whether the Status has changed. If the order is reversed, it is easy to mistake a cache refresh for business completion.

## 6. Experiment

### Experiment A: Draw an Object Relationship Diagram

Start from the fields of `goal_frontier` and `todos/contract.py`, draw a diagram: Goal → Todo → claim → gate → run → evidence → completion. For each arrow, write "who writes and who reads".

### Experiment B: Create a blocked but non-failed scenario

Construct a Todo with unsatisfied dependencies. Refer to the acceptance criteria: it appears in the blocked/waiting view of the frontier, but should not be incorrectly marked as failed, nor should it consume quota.

### Experiment C: Distinguish projection from facts

Read the status twice consecutively without changing any facts in between. Refer to the observation: Status can be recalculated, but the canonical fields of Goal/Todo/claim should not be modified by the status read action.

### Experiment Reference Answers

1. Goal provides long-term objectives, Todo provides executable units, claim/lease grants execution rights, gate determines whether it is currently allowed, run generates evidence, completion is only driven by legitimate write-back.
2. Unsatisfied dependencies should be blocked/waiting, not failed, and should not consume quota; it is waiting for prior fact changes, not execution errors.
3. Status is a projection derived at read time; consecutive reads should not modify the canonical fields of Goal/Todo/claim.

## 7. Failures and Recovery

| Failure | Root Cause | Recovery |
| --- | --- | --- |
| Two Todos point to the same work | Identity/deduplication rules | Fix using stable todo_id and scope, do not rely on text deduplication |
| Claim expired but still writing | Only checking memory flags | Re-read the lease term and owner; stop writing if failed |
| Gate bypassed | Treating recommended action as permission | Recheck the gate at the typed action entry |
| Frontier unchanged after completion | Writing back the projection instead of facts | Check Todo/Goal/evidence canonical writes |
| Doing the same one again after restart | Did not read run history/receipt | First read journal and completion receipt |

## 8. Self-Test

1. What questions do Goal, Todo, and Turn each answer?
2. Why can't Claim and Gate be merged?
3. If a Todo is marked complete, why might the Goal still not end?
4. When Status and canonical state are inconsistent, what should be checked first?
5. Why is run history not ordinary debug log?

### Reference Answers

1. Goal answers "why continue, and what are the boundaries"; Todo answers "what is the next acceptable action"; Turn answers "how far was this execution step taken, which effects have been submitted".
2. Claim controls ownership and time window; Gate controls action preconditions. Claim cannot prove prior facts are satisfied; Gate cannot resolve the competition of two Agents claiming the same Todo simultaneously.
3. Marking is just a state intention; Goal completion still requires outcome/acceptance, subsequent arrangements, evidence, and terminal conditions; Todo completion may only mean moving on to the next frontier.
4. First check canonical Goal/Todo/claim/evidence and journal, then refresh projection. Do not directly adjust Status just for "apparent consistency".
5. It preserves Turn, effect, receipt, and recovery prefix, proving which side effects have occurred; ordinary logs usually do not guarantee structure, order, and idempotent identity.

## 9. Source Code Coordinates

- `loopx/registry.py`
- `loopx/status.py`
- `loopx/state_refresh.py`
- `loopx/control_plane/goals/state_resolution.py`
- `loopx/control_plane/goals/goal_frontier/`
- `loopx/control_plane/goals/acceptance.py`
- `loopx/control_plane/todos/contract.py`
- `loopx/control_plane/todos/completion_transaction.py`
- `loopx/control_plane/todos/user_gate.py`
- `loopx/control_plane/runtime/run_history.py`

## 10. Next Steps

Enter Stage 2: all objects are in place, but on what basis does the system decide "run now"? Start reading from the false branch of `quota should-run`.
