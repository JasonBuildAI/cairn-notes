---
title: "LoopX 2.1.1 Source Code Course · Introduction"
description: "LoopX 2.1.1 Source Code Course Guide: Control Surface Positioning, Seven Responsibilities, Reading Order, and Core Boundaries."
---

:::note[Independent Study Notes]
These are independent study notes organized based on the source code and public documentation of [LoopX](https://github.com/loopx-project/loopx) version v2.1.1 (commit 87e5b4f8); they are not official documentation. This site does not include the upstream source code; $LOOPX_SRC represents your own local source code directory below.
:::

> Baseline: `loopx-2.1.1`, Git tag `v2.1.1`, commit `87e5b4f88d207adf062eea57002cda6fe04fd535` (2026-10-23).
> The path in this article is relative to `$LOOPX_SRC`.
> Old versions of the lecture notes are not in this repository; this lesson only refers to version v2.1.1 source code, and conclusions from older versions are no longer valid.

## Understanding LoopX in One Sentence

**LoopX is not another Agent runtime, but the "control plane" of a long-term Agent: it stores goals, Todos, execution rights, access control, quotas, evidence, and recovery states outside the model context, and then compiles the current state into a bounded, verifiable, writable Turn.**

The model is still provided by hosts such as Codex or Claude Code; tools are still executed by the Host or Capability. LoopX does not care about "what the model thinks this round," but rather:

- Whether this round should run at all;
- Who has the right to run and which Todo to execute;
- Whether external actions actually happened;
- Which results can be written back to long-term state;
- How to avoid repeating side effects in the next round if a crash occurs after writing back or spending quota.

Think of it as an "executable long-term Kanban board":

```text
Goal / Issue / External Events
          │
          ▼
Registry + Goal State + Run History (Facts and History)
          │
          ▼
Status / Attention Queue (Projection: Who should act now)
          │
          ▼
Quota should-run (whether to run, what to run, whether it consumes quota)
          │
          ▼
Turn Envelope + Transaction Plan (this round of contract)
          │
          ▼
Host (The model + tool performs a bounded task once)
          │
          ▼
Capability / Provider (domain rules, external calls, readback)
          │
          ▼
Validation → durable writeback → quota spend → scheduler
          │
          └──────── Recalculate the next round frontier
```

## Overview of the Seven Modules

| Component | Question to Answer | LoopX's Answer | Main Source Code |
| --- | --- | --- | --- |
| Loop | How does a goal progress across many rounds continuously? | `quota should-run` Select an action, Turn executes once, recalculate the frontier after settlement | `loopx/control_plane/quota/`, `turn_driver/` |
| Context | The model doesn't remember things, where to store long-term facts? | Registry, Goal State, Authority, Run History, Todo/Event; reproject each time | `loopx/registry.py`, `state_refresh.py`, `run_history.py` |
| Tools | Who actually operates the external world? | Host provides model and tools; Capability sets rules, Provider performs calls and readback | `loopx/capabilities/`, `loopx/extensions/` |
| Model Integration | How to avoid being tied to a single model? | Models reside in external Agent Host; LoopX only uses host-neutral contracts | `turn_driver/driver.py`, various goal-mode adapters |
| Extensions | How to integrate new features without changing the kernel? | Capability, Provider, Extension, Host adapter layered registration | `capability_registry`, `extensions/`, `*_goal_mode/` |
| Interface | How do humans, scripts, and Heartbeat use the same control surface? | CLI JSON projection; Dashboard/IM are only consumers of the model | `loopx/cli.py`, `status.py`, `presentation/` |
| Engineering | How to avoid duplicate side effects under crashes, retries, and concurrency? | Typed contracts, ordered stages, Turn journal, idempotent receipt, recovery audit | `turn_driver/transaction.py`, `executor.py`, `settlement.py` |

Three vertical principles run throughout:

1. **Fact Ownership**: Only the canonical state is factual; Status/Kanban/prompt are all projections.
2. **Permission Boundaries**: claim, lease, gate, quota, workspace/capability are hard boundaries; recommended actions are only steering.
3. **Side Effect Boundaries**: Observation does not equal progress; receiving external receipts does not equal kernel acceptance; verification must happen first before writing back, spending quota, and scheduling.

## Reading Order

| Order | Document | What You Will Get |
| --- | --- | --- |
| 0 | [Global Map](overview/) | Product positioning, seven modules, six-layer state, four types of runtime responsibilities, directory and terminology |
| 1 | [The Lifecycle of a Turn](turn-lifecycle/) | Complete main thread from `should-run` to Host, seven-stage settlement, and recovery |
| 2 | [Core Mechanisms](core-mechanisms/) | Goal/Todo/Claim/Gate/Quota/Evidence/Projection, context and extensions |
| 3 | [Engineering in Practice](engineering/) | Debug paths, source experiments, failure matrix, aligning and graduating exercises after kernel modification |

## Stage Lessons (Deep into Source Code)

After the overview, follow [Stage Guide](learning-path/) from Stage 0 to Stage 9. `00`–`03` build global and mechanism intuition; stage chapters decompose ownership, state transitions, failure recovery, and observable experiments from the real source code. Each chapter includes self-tests and exercises with reference answers.

## Recommended Reading Method

- **First pass, focus on a single thread**: `quota should-run → build_loopx_turn_plan → run_loopx_turn_once → execute_turn_driver_settlement → refresh-state`.
- **Second pass, question three types of ownership**: Who is the factual source of this field? Who has the authority to modify it? After failure, which journal/receipt proves what step has been completed?
- **Third pass, do minimal experiments**: Read a should-run JSON, draw the seven stages; deliberately construct a "written back but not spent" recovery scenario, and explain why the write-back cannot be repeated.

## Five Most Easily Confused Things

1. **LoopX is not an Agent framework**: It does not implement model loops, context windows, or tool protocols; these belong to the Host. What it implements is cross-turn goals and state governance.
2. **Todo is not a chat to-do**: Todo has stable identity, scope, dependencies, claim/lease, evidence, and continuation; checking it off as done cannot replace accepted writeback.
3. **Status is not a source of facts**: `collect_status()` and the attention queue are read models derived from Registry, State, History, and contract health.
4. **Quota is not just a "limitation on counts"**: It also represents health blocking, manual gating, focus wait, external wait, executability, rate limiting, and hard pause; `should_run=false` may imply a completely different recovery path.
5. **Receiving a receipt does not mean the transaction is complete**: Host only completes `host_execute` and `typed_result`; verification, writeback, spend, scheduler apply/ack still need to be advanced stage by stage.

## Learning Completion Criteria

After reading, you should be able to answer without looking at the document:

- Why can't long-term state be stored only in the transcript?
- What are the seven stages of a single Turn, and why must `quota_spend` come after `durable_writeback`?
- How do `validated_progress`, `validated_completion`, `wait`, and `host_failure` each affect the next round?
- When `terminal_closeout_failed` occurs, which effects have been submitted, and which must never be redone during recovery?
- What do Claim, Gate, Quota, Capability, and Workspace guard each restrict?
- Why can't "recommended actions" quietly narrow the Agent's legitimate choice space?

### Reference Answers for Learning Completion Criteria

1. **Because the transcript is only a working copy of the model, not a long-term source of truth.** It is subject to compression, truncation, model changes, session changes, and even summary rewriting; LoopX's Goal, Todo, claim/lease, gate, quota, authority, evidence, and run history must exist outside the model context in order to reconstruct the current frontier after a process crash, host switch, or long pause, and to determine which actions are legal and which effects have been committed.
2. **The seven stages are** `host_execute → typed_result → validation → durable_writeback → quota_spend → scheduler_apply → scheduler_ack`; completed Turn has a separate `terminal_closeout` provider effect. **Writeback before spend** is because only once the writeback is accepted does a provable delivery exist; deducting quota first and then failing to write back leaves "spent resources but no state change" bad debt, which cannot be safely refunded or re-deducted during recovery.
3. **`validated_progress`** indicates that there is evidence of progress but it is not complete; after entering material settlement, the next round continues to look for a new frontier; **`validated_completion`** must declare `successor`, `active_goal`, or `no_followup`, on the basis of which Todo is closed, successors are scheduled, or the final stage is reached; **`wait`** does not spend quota, saves a typed resume condition, and observes next round according to monitor/backoff; **`host_failure`** does not spend quota and cannot be recorded as successful, and the next round follows the policy to fix the Host, retry, or wait, and can only re-enter the Host when allowed by evidence.
4. **When `terminal_closeout_failed` occurs, the first five stages have already been committed**: Host execution, typed result, validation, durable writeback, and quota spend all have facts; the missing part is the final closeout; during recovery, first read the closeout receipt/completed stages, **only supplement the closeout; never rerun the Host, repeat writeback, or spend again.**
5. **Claim** defines "who is responsible for which Todo, in which scope and timeline," not ownership of Goal; **Gate** defines whether prerequisite facts, manual decisions, boundaries, or acceptance are met, only blocking the corresponding actions; **Quota** defines whether execution and spending are allowed currently, distinguishing health, operator, focus, waiting, throttle, paused; **Capability** defines domain success conditions, evidence, typed transitions, and error classification, and cannot directly write Kernel private state; **Workspace guard** restricts readable and writable repo/path/environment to prevent cross-project, destructive, or production side effects.
6. **Because recommended actions are steering, not a permissions whitelist.** If `next_cli_actions` quietly becomes "the only legal set," the Agent will lose current authoritative/eligible but un-recommended legal paths, and behavior will still depend on a projection; conversely, any recommended action must be re-checked for typed authority, preflight, receipt binding, validation, and settlement. Actions that must truly be rejected should be expressed as hard boundaries and return explicit typed errors, rather than hinting at prohibition via "not recommended." 

---

*Written based on LoopX v2.1.1 source code · 2026-10-31*
