---
title: "02 · Core Mechanism: State, Authority, Evidence, and Projection"
description: "Understand Goal, Todo, Claim, Gate, Quota, Evidence, and the projection mechanism."
---

> Baseline: LoopX `v2.1.1`. This chapter is not a manual, but explains "why these objects must be separated." 

## 1. Overall Model: The Control Plane is an Effect Interpreter

The official LoopX architecture documentation provides a very good unified perspective:

```text
model -> effect request -> harness interprets effect -> observation -> model
```

The model proposes "I want to do something"; Harness does not execute directly but first interprets:

- Is this a legitimate effect?
- Do the current Goal, Todo, claim, gate, and quota allow it?
- Which Capability/Provider is needed?
- How much does the returned observation prove?
- Has this change been written back, does it consume quota, and is the next round scheduled?

Therefore, LoopX is not simply a CRUD database, nor a "timer prompt." It projects the current state `A` into observation `F[B]`, and then determines the interpreter for the next effect based on quota/interaction/capability/scheduler rules.

This leads to a key design principle: **Legitimacy is written in typed contracts, not in prompts.**

---

## 2. Goal: Why it must be a "lifetime goal"

The core object of LoopX is not a single session but a Goal that may live for many days. `docs/architecture.md` The Lifetime Goal Invariant requires that a future person or Agent can restore:

- What the goal is;
- What is currently defining it;
- Who can modify it;
- What the next safe transition is.

Therefore, a Goal needs:

| Part | Function |
| --- | --- |
| identity | Stable goal id, repo/project boundaries |
| vision / acceptance | Final objective and acceptance criteria |
| boundary / non-goals | Clearly defined limits not to cross |
| authority sources | Which documents, states, or decisions are authoritative |
| priority / next action | Route under current belief |
| guard / capability | Conditions that must be met before execution |
| monitor / continuation | When to proceed and when to stop |

A Goal must not become an "infinite diary." Active states should store compact facts needed to make the correct decision in the next round; old reasoning can be discarded, and the external world must be re-probed.

### 2.1 Why Authority Source is Important

If all knowledge comes from model memory, after switching sessions the following can occur:

- Inconsistent goal versions;
- Two interpretations of the same requirement;
- Old discussions overriding new decisions;
- Private materials unintentionally exposed.

Authority sources turn "what to rely on" into verifiable references. They do not automatically guarantee content correctness, but at least provide a resolution point for conflicts: when chat, previous states, and authoritative documents collide, the system knows which to consult.

---

## 3. Todo: Not just tasks but executable work cards

### 3.1 There are only four native states

`loopx/control_plane/todos/contract.py` Definition:

```text
open
done
blocked
deferred
```

Do not invent `running`, `claimed`, `superseded` as stored status by yourself:

- `claimed_by` is ownership metadata, not a native state;
- 'In Progress' is usually a derived view of the current Turn of claim/lease;
- `superseded_by` is successor relationship metadata, not the fifth type of state;
- `done` and `deferred` are both terminal statuses, but their meanings are different.

### 3.2 What at least should a Todo answer

| Dimension | Typical Fields | Problems to Solve |
| --- | --- | --- |
| Identity | `todo_id` | Stable reference across sessions and agents |
| Goal | `goal_id` | Belongs to which long-term goal |
| Category | Task Class / Action Kind | Is it Delivery, Observation, Repair, or Replanning |
| Scope | repo, workspace, target key | Allowed to be written where |
| Dependency | predecessor / successor | What must be completed first |
| Ownership | `claimed_by`, lease | Who is currently responsible |
| Exclude | `excluded_agents` | Which agents should not be awakened |
| Continue | continuation policy | How to proceed to the next one after completion |
| Wait | resume condition / monitor | What facts need to arrive before resuming |

`selected_todo` is not the 'first item on the list.' The kernel selects the current frontier based on state, dependencies, claims, capabilities, workspace, gate, and quota.

### 3.3 Claim and Lease

Claim answers 'Who is responsible for this card,' Lease answers 'How long/which version this responsibility is valid for.'

The current source code contains both lightweight and stricter collaboration contracts:

- The `claimed_by` in todo metadata is a visible soft owner;
- Only identities registered in `coordination.registered_agents` are accepted;
- A more complete peer runtime uses claim/lease, scope, idempotency, and compare-and-swap to handle concurrency;
- A registered agent is a peer, and there is no permanent leader identity;
- The temporary coordinator only coordinates one bundle and does not obtain implicit review/merge/replanning rights from other peers.

Do not confuse having a claim with owning the entire Goal. A claim only covers the Todo that has been claimed and its scope.

### 3.4 Gate: Waiting is not failure

Gate indicates that a certain prerequisite fact or judgment by a person has not yet been satisfied. Common types:

- operator/user gate;
- capability readiness gate;
- workspace / boundary gate;
- external evidence gate;
- terminal acceptance gate. 

The key detail of `operator_gate` is **blocked_action_scope**: it may only block gated delivery, while allowing safe read-only steering, analysis, or priorities unrelated to access control. You cannot freeze the entire Goal because of one gate, nor treat it as a global pass.

### 3.5 Monitor: Observation Work When External Conditions Are Not Met

Monitor is not busy-waiting. It requires:

- Observe targets (PR, CI, experiments, external systems);
- Freshness requirements;
- Next observation time/backoff;
- Continuous unchanged count;
- Recovery conditions;
- When to upgrade to manual actions or replan.

`consecutive_no_change` belongs to the monitor target, not the entire Goal. When multiple monitors are polled alternately, you cannot rashly judge stagnation based on 'adjacent run texts being similar'.

### 3.6 Continuation: Completion Does Not Equal the End

Must declare continuation:

- `successor`: Generate subsequent Todo;
- `active_goal`: Goal is still active, review frontier again;
- `no_followup`: No successors, entering terminal audit.

If a card is completed but no successor is defined, the system cannot automatically say 'Goal completed.' It needs to check monitor, handoff, acceptance gap, replan obligation, sink retry, blocker/resume route, etc.

---

## 4. Quota: Budget is also a permission

Doing two things at the same time:

1. Determine the automatic operation status;
2. Calculate the slots used/available for this window.

The `QUOTA_STATE_ORDER` in the source code is:

```text
blocked_health → operator_gate → focus_wait → eligible → waiting → throttled → paused
```

Order implies priority. For example, health block comes before manual access control, and manual access control comes before ordinary eligibility.

### 4.1 Quota is not just 'rich/poor'

| Status | What you can learn |
| --- | --- |
| `blocked_health` | Prerequisite system first, not waiting for budget |
| `operator_gate` | People can give direction, but cannot bypass gated actions |
| `focus_wait` | Current focus not met, continue waiting for specific conditions |
| `eligible` | Can generate the next Turn |
| `waiting` | External observation / no ready work |
| `throttled` | Budget window exhausted |
| `paused` | Owner stopped or compute=0 |

### 4.2 Slot accounting should be responsible for net effects

Quota cannot only increase without decrease. The source code supports spend and void:

- spend records a real delivery once;
- void corrects accounting errors under non-destructive conditions;
- Records are verified by goal instance and window to avoid charging the cost of an old Goal instance to a new instance;
- Duplicate events should not add slots repeatedly.

This again reflects the control plane principle: the budget is not a UI counter, but a ledger with identity and event source.

### 4.3 Do not 'spend quota to prove you're alive' when there is no progress

`should-run` may require self-repair, replan, or stop after two rounds without substantive progress. Continuing hot polling only consumes the budget and disguises 'activity' as 'progress'.

Progress should be judged by:

- Whether deliverables have changed;
- Whether evidence is new and fresh;
- Whether blockers have been removed;
- Whether there are new typed successors;
- Whether there is coverage proof from `no_followup`.

Not by run count, token count, or number of chat bubbles.

---

## 5. Evidence: Why 'I did it' is not enough

A credible piece of evidence should at least have:

- **Identity**: Which Goal / Todo / Turn / effect it belongs to;
- **Source**: Command, file, CI, Provider readback, or human decision;
- **Time/Freshness**: When it was generated, and whether it is expired;
- **Scope**: Proving all or part;
- **Verifiability**: Whether others can replay or check it;
- **Public safety**: Whether it can enter the public projection.

### 5.1 Observation vs Transformation

```text
External observation → Provider normalization → Capability verification → typed proposal → Kernel commit
```

None of these steps can be skipped. The PR page shows "merged" just as an observation; the Provider needs to bring back the facts, Capability needs to determine whether it satisfies the acceptance criteria of this Todo, and then the Kernel writes it back.

### 5.2 Boundaries of Receipts

A receipt proves that "a certain effect was requested/executed," but does not automatically prove that "the domain goal was achieved."

- Host receipt proves a round of Host results;
- Writeback receipt proves that the state was written;
- Quota receipt proves slot deduction;
- Terminal closeout receipt proves final closure.

Each type of receipt can only close its corresponding phase. A writeback receipt cannot replace validation, nor can a Host "success" replace an external readback.

### 5.3 Run History Is Not a Full Log

Run history is a compact evidence trail for rebuilding judgment in the next round. It preserves:

- Identity;
- Result kind;
- Key evidence;
- Recommended actions/decisions;
- Quota contribution;
- Relationship to Goal/Todo.

Original transcripts, private logs, and large files should not be the default context for the control plane. Read them when needed via typed evidence reference; don't let "fits in the context" dictate "should be included."

---

## 6. Projection: Why Dashboards and Status Pages Cannot Have Facts

`loopx/status.py::collect_status()` Build the state from Registry, run history, contract health, attention, etc. `build_attention_queue()` Then derive the queue of "who needs to act."

The goals of Projection are:

- Allow Agent/Heartbeat/UI to understand the current situation with limited context;
- Sort and compress;
- Hide private or irrelevant details;
- Indicate the next executable actions.

Projection cannot:

- Become the sole source of truth;
- Turn list positions into permissions;
- Replace the original receipt with a summarized field;
- Treat suggested actions as a true whitelist;
- Write private original logs into public JSON.

Dashboards and Kanban boards are both projections. Moving cards must be translated into canonical transitions, not directly change the UI or Markdown table.

---

## 7. Context Engineering: How LoopX "Lets the Model See the Correct World"

LoopX does not manage the model's context window, but it decides **which control facts should be visible this round**.

### 7.1 Each Round's Context Is Composed of These Layers

```text
Current Goal identity / vision / acceptance / boundary
Currently selected Todo + claim/lease +  capability gate
Current quota / gate / monitor decision
This round TurnEnvelope +  transaction plan
Recent run history / evidence refs
Own system prompt, conversation and tool description
```

### 7.2 fresh and resume

- `fresh`: Explicitly assume the old session is unreliable, reconstructing the context using current control facts; 
- `resume`: Reuses the Host session but still rebinds the current Goal/Todo identity. 

Neither allows old dialogues to overwrite the current canonical state. After switching models, agent handovers, or long session compression, `fresh` is often safer but sacrifices dialogue coherence. 

### 7.3 Why Projection Before Execution?

If you directly give the entire Goal state, all history, and all logs to the model, it will: 

- Beyond the window; 
- Mixing in expired facts; 
- Increased costs and attack surface; 
- Causing the model to mistakenly bring private data externally. 

So first, state/history/quota/turn plan performs bounded projections, then the host adds its own prompts and tool context on top. This is the contextual division between LoopX and Host. 

--- 

## 8. Capability, Provider, Extension: three orthogonal axes

### 8.1 Capability

Capability is a product contract. Answer: 

- What counts as success in this field? 
- What observations and validations are needed? 
- Which typed transitions are allowed? 
- How is failure classified? 

It should not directly have the kernel's claim, gate, quota, or lifecycle write rights. 

### 8.2 Provider

Provider is an external connection. Answer: 

- How to call the API/CLI/system; 
- How to normalize observation; 
- How to perform readbacks and idempotents; 
- How to expose errors and unavailability states. 

The Provider does not make product strategies. It should not decide whether the Todo is completed on its own. 

### 8.3 Extension

An extension is a delivery and lifecycle unit that can install one or more Providers but does not grant kernel privileges. `CapabilityRegistry` Registering providers, capability contracts, and implementations separately is precisely to prevent "install and authorize." 

### 8.4 Host adapter

The Host adapter maps Codex/Claude/DSH hooks, MCPs, or local interfaces to the same CLI-equivalent contract. It should: 

- Route to the current state; 
- Exposed reading and legal writing; 
- Maintain CLI fallback; 
- Do not embed a second set of schedulers or old project strategies. 

--- 

## 9. Hard boundaries vs. steering: the most common design mistakes

The LoopX documentation calls it **Guided Autonomy, Not Recommendation Lock-In**. 

### Hard boundaries

- claim/lease and scope; 
- capability readiness; 
- operator/user gate; 
- quota and pause; 
- workspace/repo writes boundaries; 
- Destructive/production-effect rules; 
- Public/private boundary. 

These must be executed by typed authority or transition, not by prompts. 

### Steering

- Priority recommendations; 
- Recommended movements; 
- bounded `next_cli_actions`; 
- Work-lane prompt; 
- Reminds you of recent failures. 

These help Agents make efficient choices, but they should not quietly shrink the legitimate set. Agents can choose actions that are not displayed but are currently authoritative/eligible as long as they still follow the same preflight and settlement steps. 

### Judgment Rules

Ask yourself: If the Agent doesn't follow this suggestion, should the system **reject**, or just **not recommend**? 

- Refusal→ written as a hard boundary; 
- It is not recommended to keep the advisory → and clearly mark it in the schema. 

--- 

## 10. Failure, stagnation, and self-repair

### 10.1 Failures should be categorized, not all called error

- `host_failure`: Runtime environment/host issues; 
- `validation_failed`: Results fail evidence or field checks; 
- `writeback_failed`: Status submission failed; 
- `quota_spend_failed`: Budget submission failed; 
- `terminal_closeout_failed`: Written back/spent quota, but failed to finish the game; 
- `repair_required`: Needs to modify the control plane/execution environment; 
- `replan_required`: The original route is no longer valid. 

Classification determines the recovery action. Retrying the same command after all failures is one of the most dangerous mistakes on the control plane. 

### 10.2 Checking Delays to See "Changes" 

Self-repair should not just be "think again." The recommended checklist sequence for the source code course includes: 

1. Reread the current quota interaction contract; 
2. Read scoped evidence; 
3. Compare the latest run and selected Todo; 
4. Check projection, claim, lease, capability, workspace, gate; 
5. Determine whether the issue is execution, state, or Host; 
6. Write machine-visible repair delta; 
7. Perform focused validation; 
8. Only material progress is refresh/spend. 

Self-repair does not allow:

- Lowering the security gate; 
- Guess missing payload; 
- Submit private logs to public repo; 
- Use destructive git to clean up unknown changes; 
- Rename no-progress to success. 

--- 

## 11. Engineering Boundaries: Why Architecture Testing Matters

`tests/architecture/test_control_plane_import_boundaries.py` Check if the control plane is out of bounds depending on presentation, CLI, capability, or benchmark adapters. This is not formalism: 

- If the kernel import CLI, the state rules will be corrupted by command parameters; 
- If kernel import capability is achieved, the general control plane will bind to a specific business; 
- If the provider writes the lifecycle directly, verification and auditing are bypassed; 
- If projection obtains write rights, the UI becomes a secondary source of fact. 

When reading a new module, first determine whether it belongs to an Agent, Provider, Capability, or Kernel, then discuss the code structure. If the boundaries are wrong, no matter how many tests you do, it will only cause a fixed error. 

--- 

## 12. Self-testing

1. Why should `claimed` not be considered the native status of Todo? 
2. What are the differences in the recovery paths of `operator_gate` and `waiting`? 
3. Why can't Provider Receipt directly close Todo? 
4. What scenarios are `fresh` and `resume` suitable for? 
5. Does a "recommended action" not appear in `next_cli_actions` mean it is illegal? How to judge? 
6. Why can't `terminal_closeout_failed` be classified as `NO_SPEND_RESULT_KINDS`? 
7. Why can't Capability and Extension replace each other? 

--- 

### Reference answers

1. Because `claimed` is **ownership metadata**, not the work lifecycle. Native status only expresses the fact that the Todo itself is pending/in_progress/blocked/done/deferred; "Who is in claim, lease to when" should be derived from `claimed_by`, lease, and current turn. Writing claim as the fifth status causes expired claims to disguise as working states and undermines the reconstruction of the state machine and projection. 
2. `operator_gate` Requires user/operator decision; recovery path is to obtain explicit authorization or modify the gated scope; It does not necessarily freeze the entire goal. `waiting` is external condition/no ready work; recovery path is monitor, resume condition, or backoff and then re-observing. The former is "granted permission by person," the latter is "waiting for the fact to arrive". 
3. The Provider receipt only proves that a certain effect has been requested/executed, or that an external observation has been read; It does not prove that the acceptance of the Todo has been satisfied. The Provider receipt must be verified by Capability and the kernel writeback accepting the conversion before Todo can be closed. The receipt can only close the corresponding phase and cannot overstep its authority to close domain targets. 
4. `fresh` Suitable for scenarios where Host/model switching, long sessions, unreliable old sessions, or compression that needs to be rebuilt from canonical state; `resume` Suitable for scenarios where continuity of the same Host is valuable and old sessions remain trustworthy. Both must be rebound to the current Goal/Todo/claim; old conversations cannot override the current authority state. 
5. No. `next_cli_actions` It is steering, not whitelist; Validity depends on typed authority, current transition/eligibility, preflight, and receipt binding. As long as an action is authorized and verifiable under the current canonical state, even if not recommended, it can follow the same settlement path; Conversely, actions in the recommended list must also be revalidated. 
6. Because it happens after writeback and spend ****, it means the quota has been submitted and only the endgame fails. If it is classified under `NO_SPEND_RESULT_KINDS`, the caller will mistakenly think the fee has not been deducted and will retry, resulting in duplicate spend and incorrect budgeting; Correct recovery only closeouts are completed. 
7. Capability defines domain contracts: what counts as success, how to observe/verify, which typed transitions are allowed; Extension is the installation and delivery unit, which can carry Provider/Capability implementations, but "installation" does not automatically grant kernel permissions. The former is semantics and validation, the latter is distribution and combination, and the two are orthogonal. 

*Next chapter: `engineering.md`, apply these mechanisms to debugging, experimentation, modification, and acceptance. *
