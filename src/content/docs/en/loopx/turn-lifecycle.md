---
title: "01 · The Life of a Turn"
description: "Track a bounded Turn from should-run and Host execution to verification, write-back, and scheduling mainline."
---

> Baseline: LoopX `v2.1.1`. Main path source code: `loopx/control_plane/turn_driver/driver.py`, `executor.py`, `transaction.py`, `settlement.py`.

## 1. Problems This Chapter Aims to Solve

When a user says, "Continue fixing this PR," the system does not truly make a safe incremental step in a single function call. LoopX must sequentially answer:

1. Is this Goal currently allowed to run automatically?
2. Which Todo is the Agent legally allowed to execute right now?
3. Is this round execution, observation, waiting, asking a human, fixing, or replanning?
4. What identities, permissions, and boundaries are included in the contract given to the Host?
5. After the Host completes, what counts as a "valid result"?
6. Which durable effects have already occurred, and how to recover after a crash?
7. When to deduct quotas, update the scheduler, and declare terminal?

This chapter follows this line step by step. First, remember the overall diagram:

```text
Registry + Goal State + Run History
        │
        ▼
quota should-run
        │  TurnEnvelope / effective_action / selected Todo
        ▼
build_loopx_turn_plan()
        │ route +  transaction plan (read-only planning, not executed)
        ▼
turn run-once
        │
        ├─ journal / admission / host invocation
        │
        ├─ host_execute
        ├─ typed_result
        ├─ validation
        ├─ durable_writeback
        ├─ quota_spend
        ├─ [terminal_closeout when completing]
        ├─ scheduler_apply
        └─ scheduler_ack
        │
        ▼
refresh-state / next should-run
```

---

## 2. Entry: Commands Are Not the Kernel

`pyproject.toml` points the `loopx` command to `loopx.entrypoint:main`. The entry first handles UTF-8 and a very small number of fast paths, then enters the gigantic command surface of `loopx/cli.py`. `cli.py::build_parser()` registers commands such as status, todo, quota, turn, history, capability, extension, etc.

When reading the source code, do not mistake "many commands" for "all logic is in the CLI." The CLI mainly does:

- Parsing parameters and selecting formats;
- Parsing the registry/runtime root;
- Calling the corresponding handler;
- Printing JSON or Markdown projections.

The real state rules are in `loopx/control_plane/`. Commands are just an entry point for the control surface; the Host adapter, Heartbeat, and scripts should ultimately land on the same contract.

### 2.1 First Parse "Which Project, Which Goal"

The default project path convention for the registry is `<project>/.loopx/registry.json`. A registry goal must at least have:

- Stable `id`;
- Belonging repo/project;
- `state_file`;
- Adapter kind/status;
- Authority sources;
- Configurations related to quota, guard, and status.

`loopx/registry.py` checks whether multiple Goals erroneously share the same state file, whether the state file exists, and whether the adapter is missing. `loopx/runtime.py` further ensures that the goal directory does not escape the runtime root.

This step looks like "finding files," but in reality, it is about fixing the source of truth: **the same request cannot quietly read different Goals in different commands.**

---

## 3. `quota should-run`: The Fork in the Control Loop

`loopx/quota.py::quota_status()` (about 437 lines) first calculates the quota status, with a fixed order:

```text
blocked_health
operator_gate
focus_wait
eligible
waiting
throttled
paused
```

This is not a "severity ranking," but a decision order: the earlier a condition appears, the sooner it intercepts.

### 3.1 What the seven states mean

| State | Meaning | Common recovery method |
| --- | --- | --- |
| `blocked_health` | Healthy / contract blocked, repair system first | Fix contract, projection, or adapter |
| `operator_gate` | Artificial gate block: gated delivery | Humans can allow safe bypass, but cannot perform actions blocked by the gate |
| `focus_wait` | Current delivery focus not yet met | Wait for focus conditions to be lifted |
| `eligible` | There is a runnable next turn | Generate TurnEnvelope and enter execution |
| `waiting` | External evidence or no Codex-ready work | Observe, monitor, wait for external conditions |
| `throttled` | Quota for the window has been used up | Wait for the window or adjust the budget |
| `paused` | Owner stopped Goal or compute=0 | Explicit resume / adjust quota |

`paused` only has two typed causes: `goal_stopped` and `compute_quota_zero` (`loopx/control_plane/quota/states.py`). Do not let the UI text invent pause reasons on its own.

### 3.2 `should_run=false` is not a single failure

`should-run` output, besides a Boolean, will also provide:

- `effective_action`: the type of action to take this round;
- `selected_todo`: which work card is selected;
- `scheduler_hint`: when / whether to wake up again;
- `interaction_contract`: what is allowed, what is prohibited, the next CLI step;
- `requires_user_action` / attention information;
- `next_cli_actions`: executable next command, usually bound to an identity.

These fields are not decorative. `monitor_due`, `operator_gate_notify`, `quota_skip`, `terminal_no_followup`, `blocked_wait` might all be `should_run=false`, but their recovery paths are completely different. **Reading should-run must read reason and effective_action, not just run/no-run.**

### 3.3 Guidance is not an invisible whitelist

`next_cli_actions` is steering: it helps the Agent quickly choose a legal path. It is not the only legal set. As long as the Agent chooses an action that is currently authoritative and eligible, it should still go through the same preflight, receipt binding, validation, writeback, and spend paths for submission.

If you want to actually restrict it, you should put the restriction in the typed authority / transition contract, rather than relying on "it's not in the recommended list" or prompt hints.

---

## 4. From decision to contract: TurnEnvelope and `build_loopx_turn_plan()`

`quota should-run` generates TurnEnvelope. `build_loopx_turn_plan()` (`driver.py`, around 466 lines) projects it into a **side-effect-free execution plan**.

### 4.1 Supported environments

Current driver-supported Hosts:

```text
codex-cli
claude-code
dsh
generic-cli
```

Execution mode:

```text
interactive-visible
isolated-headless
```

Iterative context strategy:

```text
fresh
resume
```

`agent` session scope currently only allows `codex-cli`; other Hosts are by default bound according to Todo scope. This is not a model preference, but a limitation of the session identity contract.

### 4.2 Routing

The plan is to first obtain a `LoopXTurnRoute`:

- `ready_for_host`
- `capability_action_required`
- `repair_required`
- `replan_required`
- `user_action_required`
- `wait`
- `blocked`
- `contract_error`

Only `ready_for_host`, `repair_required`, `replan_required` will set `would_invoke_host=true`.

`capability_action_required` is intentionally separated as the fourth route: some actions must first go through the capability's own commands and receipts, and cannot directly start a regular Host Turn.

### 4.3 What's in the plan

Key outputs include:

```text
host / execution_mode / scheduler context
session plan
route + effective_action + selected_todo
turn_envelope
transaction plan
effects = all false
boundary.read_only = true
```

`transaction` Generated by `build_loopx_turn_transaction_plan()`, bound to:

- Goal / Agent / Todo / replan obligation;
- host, execution mode, session action;
- `turn_key`;
- settlement identity / effect id.

`turn_key` is not a random log id, but the canonical hash of identity and execution context. Subsequent Host results, journal, writeback, and spend must all align with it.

### 4.4 Why the "planning" stage must be side-effect-free

The planning stage can be repeatedly invoked by Preview, debugging, Host pre-check, and testing. If it conveniently writes state or deducts quotas, it cannot be safely replayed.

The source code explicitly states in the payload:

```text
host_invoked = false
state_written = false
quota_spent = false
scheduler_acknowledged = false
host_invocation_allowed = false
```

True execution must enter the explicit `turn run-once` path.

---

## 5. `turn run-once`: Bounded Execution and Journal

`run_loopx_turn_once()` at about 1435 lines in `executor.py`. It is the main execution thread, not a "directly Popen an agent".

### 5.1 Fail Closed First

Before touching the journal, Host, or quota, first check whether the planned executor can be started. If the planned executor is unavailable, return failure without leaving partial side effects.

Without `--execute`, only return preview. True execution requires writeback, spend, and scheduler callbacks to be complete, otherwise directly report an error.

### 5.2 The Journal is a Recovery Ledger

For each Turn, open the journal according to `turn_key` and acquire an exclusive file lock. The journal records:

- plan and turn identity;
- host call status;
- host result;
- `completed_phases`;
- each step's receipt/checkpoint;
- recovery audit;
- terminal closeout status.

`completed_phases` must always be an ordered prefix of seven stages. For example:

```text
["host_execute", "typed_result", "validation"]
```

Indicates that verification is complete, but durable writeback has not been confirmed. Skipping stages or reordering is not allowed.

### 5.3 Recover first, then decide whether to re-invoke Host

If the journal already exists, `assess_existing_turn_recovery()` will determine:

- The same Turn has been completed: return existing, do not execute again;
- Host result exists but settlement is not complete: reuse the result and only complete the settlement;
- Failures are retryable and the request allows it: clean up by stage and continue;
- Identity/session mismatch: require typed recovery continuation, cannot force execution.

Admission is only invoked if it is truly necessary to re-call the Host. This avoids mistaking "recovery settlement" as a "new automatic execution" that would consume budget again or produce external side effects unnecessarily.

### 5.4 Host requests themselves have hard boundaries

`build_loopx_turn_host_request()` constructs Host requests based on the plan; the result entry has restrictions on fields, text length, and the number of evidence items, e.g., a total result limit of `12_000` bytes, a limit on the number of evidence entries, etc.

The purpose of these constraints is not to save a few KBs, but to:

- Prevent the Host from using excessively long free text in place of structured facts;
- Ensure that results are projectable, verifiable, and recoverable;
- Avoid putting private original materials directly into public state.

---

## 6. Host results: only the first two stages out of seven

Host/Agent returns `result_kind`, `completed_phases`, evidence, summary, etc. What it completes is:

```text
host_execute
typed_result
```

Then LoopX does not 'believe in the result' but enters verification and settlement.

### 6.1 Result Types

`turn_contract_generated.py` defines 12 `LoopXTurnResultKind`:

| Result | Meaning | Quota Consumed |
| --- | --- | --- |
| `validated_progress` | Progress with verified evidence but not completed | Can enter material settlement |
| `validated_completion` | Todo completed after verification, continuation required | Can enter material settlement |
| `repair_required` | Control plane/execution environment needs fixing | Can enter material settlement |
| `replan_required` | Current route invalid, replanning required | Can enter material settlement |
| `user_action_required` | Specific manual action required | Does not consume |
| `wait` | Waiting for a type | Does not consume |
| `iteration_failed` | This iteration failed, no typed continuation | Does not consume |
| `host_failure` | Host execution failed | Does not consume |
| `validation_failed` | Verification failed | Does not consume |
| `writeback_failed` | Writeback failed | Does not consume |
| `quota_spend_failed` | Quota deduction failed | Does not consume |
| `terminal_closeout_failed` | After writeback and quota submission, final closeout failed | Consumed, cannot be considered unconsumed |

`NO_SPEND_RESULT_KINDS` excludes `terminal_closeout_failed`. This is intentional: when this failure occurs, the first five stages have been submitted, and recovery can only supplement the closeout; writeback/spend cannot be repeated.

### 6.2 Completed Results Must Provide Continuation

`validated_completion` cannot just say 'done'. It must have the selected Todo and declare:

- `successor`: Generates successor Todo, successor ids must be provided;
- `active_goal`: Goal still active, next round continues from the new frontier;
- `no_followup`: No successor work, can proceed to final check.

This prevents partial task completion from being mistaken as overall Goal completion.

### 6.3 Verification Phase

After verification, a third phase is added:

```text
host_execute → typed_result → validation
```

If the verification fails, the result is usually `validation_failed`. Some failure stages allow re-invoking the Host to get a new result; however, this is a recovery constrained by the journal and stage state, not an arbitrary retry.

---

## 7. Settlement: from verification to durable effect

`execute_turn_driver_settlement()` at about line 428 in `settlement.py`. It receives the transaction plan, completed stages, writeback/spend/closeout payload, and effect callback, and progresses step by step.

The full seven stages come from `turn_transaction_contract.json`:

```text
1. host_execute
2. typed_result
3. validation
4. durable_writeback
5. quota_spend
6. scheduler_apply
7. scheduler_ack
```

In addition, `terminal_closeout` is an extra provider effect of a completed Turn. It occurs after writeback and spend, but before the final scheduler shutdown; a failure will return `terminal_closeout_failed`.

### 7.1 Why writeback happens before spend

Writeback first, in order to prove that there has been an "accepted state change"; then spend the quota, to bind the budget to the actual delivery.

Conversely, if you spend first and then writeback, a single writeback failure could leave "money spent but no state change" bad debts. Therefore, LoopX clearly stipulates:

- The material result must complete validation before it can be written back;
- Durable writeback must be completed before it can be spent;
- Stop/failure types cannot spend;
- Only a persisted checkpoint can advance the next provider effect.

### 7.2 Idempotency contract for each step

Settlement does not assume the process never crashes. Each external effect carries a stable effect reference:

```text
effect_id + step_kind + turn identity
```

During recovery:

- Journal indicates the submitted effect: do not redo;
- External readback exists but local has not checkpointed: read the proof first, then decide whether to checkpoint;
- Status uncertain: return typed failure, request repair, instead of guessing success;
- Already spent, already written back but closeout failed: only retry closeout.

Therefore, **idempotency is not just "the tool supports retrying"**, but the control plane must know the submission status of each stage.

### 7.3 Scheduler apply / ack

The last two stages record the "wake/stop state after this round" on the scheduling side:

- `scheduler_apply`: write scheduler hints or subsequent run arrangements;
- `scheduler_ack`: confirm that the scheduling side has indeed accepted.

The most common mistake in systems with quotas and scheduling is treating "I called the scheduler API" as "scheduler has accepted it." LoopX separates apply and ack precisely to preserve this confirmation boundary.

---

## 8. Terminal states and recovery: four typical scenarios

### Scenario A: `wait`

The host observes and determines that external evidence has not yet arrived, returning `wait`.

```text
host_execute ✓
typed_result ✓
validation ✓
durable_writeback ? (typed wait usually does not submit material state)
quota_spend ✗
Handle according to the contract
```

This is not a failure, nor should it consume the delivery quota. Observe again in the next round according to monitor/backoff.

### Scenario B: Writeback succeeds, spend fails

The journal has recorded the durable writeback, but there is no confirmation for spend. During recovery:

- The writeback must not be redone;
- The spend readback or cause of failure must be checked first;
- If the spend indeed did not occur, then submit the spend;
- The entire round must never be rerun from the beginning.

### Scenario C: Both writeback and spend succeed, closeout fails

The result is `terminal_closeout_failed`:

```text
completed_phases = The first five stages
failed_phase = terminal_closeout
```

Recovery only fills in terminal closeout, without repeating writeback and spend. `docs/architecture.md` It is explicitly required that this failure cannot be treated as 'unspent'.

### Scenario D: Host Crashes Mid-Execution

The journal may only have partial evidence `host_execute`, or not even a typed result. The recovery strategy depends on:

- Whether there is a host result / session recovery record;
- Whether it is safe to retry;
- Whether admission allows a new host attempt;
- Whether the old Turn is already bound to the same Todo / agent / turn instance.

States that cannot be verified must fail closed, rather than hope for the best by 'running again'.

---

## 9. Design Trade-offs

### Trade-off 1: Complex Control Plane, Simple Host

LoopX puts identity, quota, phases, journal, and receipt all into the Kernel. The Host only needs to perform bounded work and report back according to the contract. This increases contract and adaptation costs but allows different Hosts to share the same reliability.

### Trade-off 2: Strict Typing Over Free Text

Domain results must be typed; text can only be used for summaries and explanations. This sacrifices some expressive freedom in exchange for verifiable, replayable, and projectable results.

### Trade-off 3: Recovery Over 'Automatic Retry'

When encountering uncertain states, the system first audits existing facts and then decides which step to fill. This may seem slow but avoids repeating irreversible external actions.

### Trade-off 4: Bounded State Projection

Agents should not receive the entire history at once. `status`, `history`, `should-run` all provide compact projections; if more facts are needed, the typed discovery route is used. This controls context cost but does not allow projections to secretly obtain canonical authority.

---

## 10. Common Misunderstandings

| Misunderstanding | Fact |
| --- | --- |
| 'If Host returns success, the Turn is successful.' | Host only completes the first two stages; verification, writeback, spend, and scheduler remain. |
| '`should_run=false` means the system is idle.' | It may be waiting, access-controlled, rate-limited, or in need of repair; recovery actions differ. |
| 'Completing a Todo equals completing a Goal.' | Successor, monitor, acceptance, and terminal audit must also be checked. |
| 'Returning `terminal_closeout_failed` means this round didn't spend money.' | Writeback and spend have been committed, and recovery cannot redo them. |
| 'Recovery is just rerunning the same command.' | First read journal/receipt; committed effects must be skipped. |
| 'Recommended actions are a whitelist.' | They are just steering; the real boundaries are in typed authority/transition. |

---

## 11. Self-Test and Exercises

### Self-Test

1. Why must `build_loopx_turn_plan()` be side-effect free?
2. What problems do `turn_key` and `todo_id` solve respectively?
3. If a Turn's `completed_phases` is `["host_execute","typed_result","validation","durable_writeback"]`, what is the next valid phase?
4. Why cannot `quota_spend` come before `durable_writeback`?
5. What are the recovery differences between `terminal_closeout_failed` and `writeback_failed`?

### Exercises

Draw a state diagram where nodes are the seven phases and edges are 'successful checkpoint' and 'typed failure'. Then include:

- writeback readback exists but journal is unrecorded;
- spend succeeded but local journal is unrecorded;
- terminal closeout failed.

For each scenario, write down 'which steps can be retried, which must never be redone, and which readback is needed'. If you can clearly explain this diagram, you have grasped the core of LoopX Turn.

---

### Self-Test Reference Answers

1. Because the plan will be repeatedly read by Preview, debugging, Host precheck, and testing. As long as it conveniently writes state, deducts quota, or sends scheduler messages, it cannot be safely replayed, and it will also cause side effects from 'taking a look at the plan.' The plan must explicitly output `effects=false`, and actual execution can only enter `turn run-once`.
2. `todo_id` identifies 'which work card,' as one card can go through multiple Turns/retries; `turn_key` identifies 'which execution and its settlement context,' binding Goal, Agent, Todo, Host, session, and settlement identity into a canonical hash. Subsequent Host result, journal, writeback, and spend must align with the same `turn_key`.
3. The next valid stage is **`quota_spend`**. `completed_phases` must be an ordered prefix; the first four segments indicate that the state has durable writeback, but the budget has not yet been submitted.
4. Writeback first, to prove 'there is an accepted state change'; then spend, to bind the quota deduction to actual delivery. Conversely, if spend happens first and writeback fails, there will be an uncertain state of 'charged but no durable result,' which cannot be safely refunded or recharged upon recovery.
5. `terminal_closeout_failed` indicates that the first five stages (including writeback and spend) have been submitted, leaving only the terminal closeout; recovery can only complete the closeout, and must never rerun Host, writeback, or spend. `writeback_failed` indicates the state has not yet been confirmed submitted: verified typed results should be reused to retry writeback, but Host should still not be rerun; if readback discovers that writeback already exists, it should be treated as submitted and skipped.

### Reference Answer for Exercise

The seven-stage state diagram can be compressed into the table below:

```text
host_execute → typed_result → validation
             → durable_writeback → quota_spend
             → scheduler_apply → scheduler_ack
                              └→ terminal_closeout (additional effect of Turn in completed form)
```

For each successful edge, first write a checkpoint, then enter the next stage; a typed failure can only place a recovery point in the failure stage and cannot jump to a later stage. Three special scenarios:

| Scenario | What to do first readback | Can retry | Must never redo |
| --- | --- | --- | --- |
| writeback readback exists, journal not recorded | Read canonical authority/write back receipt to confirm whether the effect has been committed | Mark in journal `durable_writeback`, then continue from `quota_spend` | Rerun Host, repeat writeback |
| spend succeeded, local journal not recorded | Read quota ledger/spend receipt to confirm slot has been deducted | Only supplement journal/checkpoint, then continue from `scheduler_apply` | Spend again, rerun Host |
| terminal closeout failed | Read closeout receipt and completed stages | Only retry closeout | Redo writeback, spend, Host |

The key point this diagram illustrates: you can identify **source of truth, idempotent identity, recovery entry**, rather than just saying "if it fails, run it again." 

*Next chapter: `core-mechanisms.md`, separate Goal, Todo, Claim, Gate, Quota, Evidence, Projection, and extended boundaries.*
