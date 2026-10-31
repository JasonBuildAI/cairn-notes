---
title: "LoopX 2.1.1 Source Code Course · Introduction"
description: "The reading order, stage map, recommended pace, and completion standards for the ten source code stages."
---

> Baseline: `loopx-2.1.1`, Git tag `v2.1.1`, commit `87e5b4f88d207adf062eea57002cda6fe04fd535`
> Path relative to `$LOOPX_SRC`
> `00`~`03` is an overview; this set of documents goes from stage 0 to stage 9, breaking down the main thread according to the source code.

## Understanding LoopX in One Sentence

**LoopX is the control plane for long-running agents: it does not run models for the Host, but decides "whether to run this round, what task to run, whether the results can be trusted, what can be written back, how to safely settle after writing back, and where to continue in the next round."**

Think of the Host as a worker, and LoopX as the work order, access control, ledger, and quality inspection station:

```text
Registry / Goal State / Todo / History      Factual level
                 │
                 ▼
Status / Frontier / Attention Queue          Projection Layer
                 │
                 ▼
Quota should-run                             Access Layer
                 │
                 ▼
Turn Envelope + Transaction Plan             Contract Layer
                 │
                 ▼
Host (Model + tool, performs a bounded task once)        Execution layer
                 │
                 ▼
Typed Result → Validation                    Evidence layer
                 │
                 ▼
Writeback → Spend → Apply/Ack → Closeout     Settlement Layer
                 │
                 └────────► refresh frontier
```

## The Four Acts of the Entire Course

| Curtain | Stage | Questions to be answered | Mental products |
| --- | --- | --- | --- |
| Act One: Seeing the Facts | 0~1 | Who is the source of fact? What is a turn in the system? | Six-layer map and object ownership |
| Act Two: Deciding This Round | 2~3 | Why run now, which Todo to run, what is written in the contract? | should-run and Turn Plan |
| Act Three: Execution and Acceptance | 4~5 | What did the host do, and how did you prove the result could be written back? | Capability, typed result, seven stages |
| Act Four: Long-term Operation | 6~9 | Where does context come from, how to continue after a crash, how to expand? | Projection, Recovery, Engineering, and Capstone Project |

These four acts are not four separate modules. They always revolve around one question: **How can long-term facts outside the model context be safely compiled into an executable, verifiable, and recoverable Turn.** 

## Ten stages

| Stage | Documentation | What you will get |
| --- | --- | --- |
| 0 | [Environment and Source Code Map](../stage-0/) | Version, Table of Contents, Six-Level State, and Minimum Reading Experiment |
| 1 | [Object Model and Control Plane](../stage-1/) | What do Goal, Todo, Claim, Gate, Run, and Projection each possess?
| 2 | [ShouldRun and Quota](../stage-2/) | Why can or cannot run now, false different recovery paths |
| 3 | [Turn Planning and Transactions](../stage-3/) | Turn Envelope, turn_key with a seven-stage contract |
| 4 | [Capability, Provider, and Host](../stage-4/) | domain capabilities, Provider lifecycle, Host requests/results |
| 5 | [Verification, writeback, quota, and scheduling](../stage-5/) | Result classification, write-back order, spend, apply/ack, closeout |
| 6 | [Contextual Projection and Long-Term State](../stage-6/) | How facts become the limited context visible to the model |
| 7 | [CLI, Dashboard, and Extensions](../stage-7/) | CLI, Dashboard, Goal Mode, Capability: How to reuse the kernel |
| 8 | [Engineering, Testing, and Restoration](../stage-8/) | Testing, importing boundaries, journals, failure recovery, and troubleshooting |
| 9 | [Capstone Project](../stage-9/) | Design a verifiable new capability and complete the recovery drill |

## Three Judgments Throughout the Lesson

### 1. Facts and projections must be separated

Goal State, Todo, claim/lease, quota, authority, evidence, run history are facts; Status, Kanban, prompt, and next action are views derived from facts. Projections can be recalculated; facts cannot be fixed by "having the model say it again." 

### 2. Recommended actions are not permission whitelists

`next_cli_actions`, recommended action, and attention queue are steering. Truly valid actions must re-pass through typed authority, preflight, receipt binding, validation, and settlement. Actions that must be prohibited should return explicit errors, not suggestions of "no recommendation." 

### 3. Side effects must be submitted in stages

Host execution and typed result only indicate "what happened in the attempt"; validation determines "whether the evidence is sufficient"; writeback determines "whether the long-term state accepts"; spend determines "whether the cost is accounted for." If any step fails, you must continue from the journal's submitted prefix, not restart the entire cycle. 

## A main chain you can memorize

```text
should-run
  → turn plan
  → host request
  → typed result
  → validation
  → durable writeback
  → quota spend
  → scheduler apply/ack
  → terminal closeout (only completion and no_followup)
  → refresh-state
```

When reading each stage, ask three questions: **Whose facts are at this step? Where does it stop on failure? Which side effects must never be repeated on retry?**

## Recommended Reading Method

- On the first pass, only look at the main chain; do not follow internal business within Capability.
- On the second pass, open the source coordinates listed for each stage, and confirm function names, inputs and outputs, and failure returns.
- On the third pass, experiment: construct a `should_run=false`, a `wait`, and a 'crash after writeback' scenario, and write out the recovery actions.

## Learning Completion Criteria

1. Why does LoopX not keep the target, Todo, and quota only in the transcript?
2. Why is `should_run=true` not equal to Host being able to do anything?
3. Why must stage seven have `quota_spend` occur after `durable_writeback`?
4. What do `validated_progress`, `validated_completion`, `wait`, `host_failure` respectively mean for the next round?
5. When `terminal_closeout_failed` occurs, which effects have already been committed, and which cannot be repeated during recovery?
6. What are the boundary responsibilities of Capability and Provider?
7. Why can Status and next action only be projections and not sources of truth?

### Reference Answers

1. The transcript can be compressed, truncated, switched with models, or switched sessions; it is only the working copy for the current round. Target, Todo, claim/lease, gate, quota, authority, evidence, and run history must be independently persisted to rebuild the current frontier after a crash, Host switch, or long-term pause.
2. `should_run` only answers 'candidate allowed to enter one Turn currently'; specific items are still subject to Todo scope, claim, user gate, capability gate, workspace guard, and typed action authority restrictions. Recommended actions are just steering.
3. Only if writeback is accepted does a provable delivery exist. Deducting quota first and then failing to writeback leaves 'consumed but no state change' bad debt; during recovery, it is hard to safely refund or know whether to deduct again. Writing back first ensures spend has a clear precondition with a receipt.
4. `validated_progress` is proven but incomplete advancement, with frontier recomputed after settlement; `validated_completion` must declare successors, active goals, or `no_followup`, which may trigger terminal closeout; `wait` is a non-consuming pause, saving a resume condition; `host_failure` does not consume or count as success, next round either repairs Host, retries, or waits according to policy.
5. The first five stages have usually already been committed: Host execution, typed result, validation, durable writeback, and quota spend all have facts; what is missing is the terminal closeout. During recovery, only closeout is supplemented; Host re-execution, writeback repetition, or spend repetition should not occur.
6. Capability defines domain semantics: success conditions, evidence, typed transitions, error classification; Provider provides lifecycle and execution implementation and complies with declared/installed/enabled/ready states. Capability cannot directly modify Kernel private state, and Provider cannot bypass validation and settlement.
7. Projections can be recomputed according to rules, versions, and filtering criteria and can temporarily be missing; if facts are overwritten by projections, there is no reliable recovery point after a crash. Status is suitable to show humans and Agents 'where we are now,' but not to prove 'this has happened.'

## Next Steps

Start from `stage-0.md`. Do not rush to read all Capabilities; first confirm six layers of facts, one main chain, and four recovery questions.
