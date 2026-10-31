---
title: "03 · Engineering Practice: How to Understand, Debug, and Modify LoopX"
description: "Verify control plane changes through debugging, experiments, failure matrices, and recovery drills."
---

> Baseline: LoopX `v2.1.1`. This chapter turns the previous models into actionable working methods.

## 1. First, establish a 'evidence-first' debugging habit

Many issues in LoopX appear to be model behavior problems, but in reality, they are control plane state issues. When encountering anomalies, do not change the prompt first; instead, locate:

```text
Command not registered? → entrypoint / cli.py
Can't find Goal/project? → registry / runtime root / state_file
should-run selected wrong?        → quota / todo projection / gate / claim
Turn Not started?            → route / admission / host adapter
Execution result rejected? → result kind / validation / receipt binding
Writeback or recovery failed? → journal / settlement / authority
Page data is incorrect?           → projection / history / cache
```

### 1.1 Read JSON First, Don't Guess the Code

The recommended troubleshooting entry for the repository `docs/development/project-code-tour.zh-CN.md` is:

```bash
loopx status --format json
loopx quota should-run --goal-id <goal-id> --agent-id <agent-id> --format json
loopx history --format json
loopx commands --format json
```

If there are differences in versions/parameters, first use `loopx commands --format json` to check the command interface, do not write parameters from memory.

When reading `should-run`, at least record:

- `effective_action`
- `selected_todo.todo_id`
- `scheduler_hint`
- `interaction_contract`
- `requires_user_action`
- `next_cli_actions`
- reason / blocker / gate fields

Then only follow the modules actually read by this decision, do not blindly read from the repository root.

### 1.2 When encountering duplicate/stale effects, first look at identity

Priority check:

```text
goal_id
agent_id
todo_id
turn_instance_id
turn_key
effect_id
completed_phases
failed_phase
receipt identity
```

These fields determine whether "this is the same Turn or a new Turn." If the identity does not match, even the smartest retry may produce duplicate side effects.

---

## 2. Local Environment

`pyproject.toml` Requires Python 3.11, TypeScript control plane requires Node.js 22.22.3. The contribution guide uses `uv`:

```bash
uv sync --extra test
npm ci
```

Before running the Python architecture test for the first time, you need to `npm ci`, because they will parse the TypeScript control plane. The command line can be used:

```bash
uv run --extra test python -m pytest -q <test files>
npm run -s typecheck:control-plane
npm run -s test:control-plane
```

Static Check:

```bash
uv run --extra test python -m ruff check tests loopx/canary loopx/control_plane loopx/domain_packs loopx/presentation
uv run --extra test python -m mypy
```

Don't run the full suite the first time. The LoopX repository is very large. The correct order is:

1. Unit tests corresponding to the points of change;
2. Adjacent contract / recovery tests;
3. Architecture boundary tests;
4. Typecheck;
5. Finally, the full suite.

---

## 3. Experiment A: Follow a should-run decision once

### Goal

Understand why the system chose an action, rather than just looking at the final JSON.

### Steps

1. Choose a test fixture or a local Goal that you own; do not perform the experiment on a real production Goal.
2. Run `quota should-run --format json`.
3. Divide the output into four parts:

```text
state facts: goal / todo / gate / quota
decision: effective_action / route / selected_todo
boundary: interaction_contract / allowed/blocked scope
continuation: scheduler_hint / next_cli_actions / terminal
```

4. Use `rg -n "<field-name>" loopx/control_plane` to reverse-check the assembly point.
5. Draw the field flow from status → quota → should-run packet.

### Verification Questions

- If `should_run=false`, is it in waiting, gate, throttle, pause, or health block?
- If `selected_todo` is empty, why can't it directly report "no work"?
- Is `next_cli_actions` the only valid action set?

---

### Experiment A Reference Answers

- `should_run=false` cannot be judged by Boolean alone; one must read `effective_action`, route/reason, quota state, gate, attention, and health. It may be in: waiting for monitor/external conditions, operator gate, throttle/budget window, manual pause, health block, or require repair/replan.
- `selected_todo` being empty does not mean "no work." It could be that all work is blocked by gate/claim/scope, that only safe read-only actions are allowed currently, or that re-planning is needed among several Goals/priorities. Must check the blocked scope and attention reasons.
- `next_cli_actions` is not the only valid set, just the steering. Validity is determined by typed authority, transition contract, preflight, and receipt binding; recommended actions must also be re-verified.

## 4. Experiment B: Following the Seven Phases of a Turn

### Goal

Align `completed_phases` with the real effect.

### Steps

1. Construct a fake host/validator/writeback/spend in the test; do not use real external writes.
2. Call `turn plan` or directly call `build_loopx_turn_plan()` to confirm the plan does not produce effects.
3. Call `run_loopx_turn_once()`, simulating separately:
   - host success   validation success;
   - validation failure;
   - writeback failure;
   - spend failure;
   - terminal closeout failure.
4. Each time, read the journal using `turn inspect-journal --goal-id ... --agent-id ... --turn-key ...`.
5. Mark on paper which phases are committed and which effects have readback but are not yet checkpointed.

### Experiment B Reference Observations

The following five points are the reference conclusions for this question:

- When host returns, phases reach at most `typed_result`;
- Only after validation does material writeback qualification exist;
- Spend can occur only after writeback checkpoint;
- `terminal_closeout_failed` occurs after the first five phases are completed;
- Recovery must not repeat already committed effects.

### Recommended Test Files

Look for adjacent tests from these directions:

```text
tests/test_loopx_turn_executor.py
tests/control_plane_ts/*turn*.test.ts
tests/architecture/test_control_plane_import_boundaries.py
```

Don't just assert 'the function returns 200'; assert the journal's phase, receipt, effect flags, and recovery behavior.

---

## 5. Experiment C: Looking at Domain Boundaries from the Perspective of Capability

Pick a real Capability, such as issuing a fix or PR review, and go through it:

```text
CLI handler
  → capability contract
  → provider observe/effect
  → normalized evidence
  → typed transition proposal
  → Kernel validation / writeback
```

Ask at every step: 

- Which step only returns the proposal and doesn't write the durable state? 
- Which step must be readback? 
- Which steps can be retried, and which steps must be idempotent? 
- Which step will change Todo/Turn/quota? 
- Did this capability secretly import presentation or kernel private internals? 

If the business capability directly changes the Goal file, this is a boundary error; If the provider marks Todo as done, that is also a boundary error. 

--- 

### Experiment C Reference Answer

A typical Capability chain should be divided into: 

| Steps | Product | Can be written canonical state | Restore focus |
| --- | --- | --- | --- |
| CLI/command | Parameter and Object identity | No | Idempotent request, parameter validation |
| Capability contract | Success conditions, allowed transition, error taxonomy | No | Contract version and lineage |
| Provider observe/effect | External observation/effect receipt | No (only typed proposals can be submitted) | readback, idempotent key |
| normalized evidence | Facts with source, time, and scope | No | Freshness and verifiability |
| typed transition proposal | Desired changes | No | Bind Goal/Todo/Turn |
| Kernel validation/writeback | accepted state and durable receipt | Yes | CAS, lease, journal, readback |

Therefore: before proposal, you cannot directly change Goal/Todo; Any external effect must have a readback or idempotent identity; Retry can only redo the "unacknowledged" step. Capability: If you directly import the presentation or write kernel private state, it is a boundary error; If the provider marks Todo as done itself, it also swaps observation for transition. 

## 6. Failure matrix: What to do when you see the result

| Results/Symptoms | Check First | Handle Correctly | Wrong Practices |
| --- | --- | --- | --- |
| `contract_error` | TurnEnvelope schema/signature/lineage | Revise the contract or regenerate envelope | Forcibly change route |
| `blocked` | gate/claim/scope/capability | etc. or supplementing prerequisites | Treat blocked as host_failure |
| `wait` | monitor/resume condition | Scheduling the next observation | Hot polling, repeated flower quotas |
| `host_failure` | host executable/session/admission | Fix the host or try again according to the strategy | Directly change the status and say it succeeded |
| `validation_failed` | validator, evidence Freshness | Re-foraging/reconciliation results | Skipping validation and writing back |
| `writeback_failed` | authority/lock/schema | Fix writeback to preserve host results | Rerunning host causes repeated external side effects |
| `quota_spend_failed` | spend receipt | Read receipt, make up for any missed steps | Repeat spend |
| `terminal_closeout_failed` | closeout receipt | Only add closeout | Redo writeback/spend |
| Two rounds with no progress | Stall/self-repair conditions | Check projection/claim/gate/budget | Change a prompt to continue burning quota |
| Page expired | runtime projection/history | Re-derivate or modify projection | Treat the UI as the source |

--- 

## 7. Four boundaries when modifying LoopX

### 7.1 First, determine which layer is being changed

| What do you want to change | Where should it be changed | Where should it be changed |
| --- | --- | --- |
| Acceptance Rules for a Business | Capability | Kernel General-Purpose State Machine |
| External System Calls | Provider | Todo Lifecycle |
| New Host | goal-mode / adapter | Copy a set of quota/scheduler |
| Display Sorting | presentation/projection | canonical state |
| Turn Phase/Idempotency | Kernel contract   tests | Only change the CLI copywriting |
| Permissions/Scope | typed authority/transition | Add a sentence like "Don't" to the prompt |

### 7.2 Any new effect must answer five questions

1. What is Stable Identity? 
2. How to identify duplicate requests? 
3. How to readback when it has already occurred but not yet checkpointed? 
4. After failure, which checkpoint decides whether to retry? 
5. Does it change the semantics of quota/claim/gate/terminal? 

If you can't answer, don't add the effect to the execution path. 

### 7.3 Don't Use Free Text to Carry Machine Facts

- Use enum for result classification; 
- Use typed contracts for permissions; 
- Recommend actions with the advisory field; 
- Evidence uses stable references; 
- closeout uses explicit receipt. 

Natural language can explain "why," but it cannot be the sole basis for "whether to permit" or "whether to complete." 

### 7.4 Modification of the contract must simultaneously modify the evidence

When the following matters are involved, supplementary testing and compatibility explanations are required: 

- schema version; 
- transaction phase; 
- result kind; 
- receipt binding; 
- quota state; 
- Todo status; 
- scheduler ack; 
- public/private projection.  

If you only change the implementation but not the contract, you will encounter the problem of "testing passed, but old journals cannot be restored." 

--- 

## 8. Design review checklist

Before submitting a LoopX change, ask each question one by one: 

- [ ] Which canonical state is the real source of this change? 
- [ ] Is it just a projection? If so, is it read-only? 
- [ ] Has implicit permission been added or is suggestions whitelisted? 
- [ ] Has an irreversible effect been added? Where are identity and idempotent? 
- [ ] At what stage does the collapse point occur? What can journals prove? 
- [ ] Will writeback/spend/closeout be repeated during recovery? 
- [ ] `should_run=false` Is each cause still distinguishable? 
- [ ] Does it touch the public/private boundary? 
- [ ] Is there a focused test that overrides the happy path and a recovery path? 
- [ ] Is the CLI fallback maintained? 
- [ ] Does the control plane depend on CLI/capability/presentation? 
- [ ] Is an RFC or migration note needed? 

--- 

## 9. Graduation project: Build a mini control plane

Don't rewrite LoopX. Make a minimal implementation to verify if you truly understand it. 

### Minimum Features

- [ ] Registry with a Goal; 
- [ ] The four states of Todo; 
- [ ] claim/lease with a clear workspace scope; 
- [ ] Quota state machine, at least covering eligible / waiting / paused; 
- [ ] should-run output selected todo reason continuation; 
- [ ] Turn plans and seven-stage affairs; 
- [ ] One host, one capability, one provider; 
- [ ] durable writeback, quota spend, scheduler ack; 
- [ ] journal with collapse recovery; 
- [ ] A read-only status projection; 
- [ ] At least five recovery tests: writeback not acknowledged, spend unacknowledged, closeout failed, duplicate request, stale identity. 

### Must be explainable

- Why the model context is not long-term; 
- Why observation is not the same as transition; 
- Why write back before spend; 
- Why can't a submitted effect be redone? 
- Why can't projections have write permissions; 
- Why claim is not a permanent leader; 
- Why recommending actions doesn't equal permission. 

By this point, you are no longer "memorizing the LoopX API," but have mastered a control plane design method that can migrate to any long-range Agent system. 

--- 

### Capstone Project "Must Be Explainable" Reference Answers

1. **The model context is not a long-term state**: It is a projection/work memory that may expire, be truncated, or be injected; the canonical state is in the Registry/authority/journal and must be reconstructible.
2. **Observation is not a transition**: Seeing a PR page merged is just input; it still requires normalization by the Provider, verification of Capability against acceptance, and Kernel acceptance and writeback.
3. **Writeback happens before spend**: Durable delivery must exist before the budget can be deducted; otherwise, there will be an uncertain state of "money spent but no provable outcome."
4. **Committed effects cannot be redone**: External actions may be irreversible; redoing them would duplicate side effects/charges. Recovery must first read the receipt/readback and only supplement uncommitted stages.
5. **Projections cannot have write permissions**: Otherwise, the UI/board would become a second source of truth, and sorting, caching, or manual dragging could secretly alter permissions and lifecycle.
6. **Claims are not permanent leaders**: They are responsibilities with a time limit and scope; once expired/invalid, they must yield, otherwise crashes or network partitions could permanently hold up work.
7. **Recommended actions do not equal permissions**: `next_cli_actions` only helps choose a path; real authorization is in typed authority/transition contracts, and still must go through preflight, receipt binding, validation, and writeback.

## 10. Final diagram

```text
                  ┌──────────────┐
                  │  Goal State  │
                  └──────┬───────┘
                         │
         ┌───────────────▼────────────────┐
         │ Registry + Authority + History │
         └───────────────┬────────────────┘
                         │ projection
                         ▼
                  Status / Attention
                         │
                         ▼
                 Quota decision
                         │
                         ▼
              Turn plan (no effects)
                         │
                         ▼
          Host → Capability → Provider
                         │
                         ▼
       validation → writeback → spend
                         │
                         ▼
             scheduler apply / ack
                         │
                         Next round
```

If you can draw from Goal to the next round on the whiteboard, and write "Fact Source, Authority, Failure Recovery" next to each arrow, then this class can end.

---

*Based on LoopX v2.1.1 (`87e5b4f8`) source code · 2026-10-31*
