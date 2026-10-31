---
title: "00 · Global Map: What Problem Is LoopX Actually Solving"
description: "Establish a global map of the LoopX long-range control plane to clarify facts, projections, and implementation responsibilities."
---

> Baseline: LoopX `v2.1.1`(`87e5b4f8`). The source code root directory is recorded as `$LOOPX_SRC` in this note. 

## 1. Let's start with a failed scenario

Suppose an Agent maintains a project for several consecutive days: fixing PR, running CI, reviewing reviews, asking people when necessary, and generating follow-up tasks. 

If you rely only on chat records, these things will happen: 

- After the context is compressed, no one can guarantee whether the "acceptance criteria" still exist; 
- Two Agents simultaneously see the same pending item and repeatedly perform external write operations; 
- Before the CI result returns, the timer keeps waking up the model and consuming the quota; 
- The agent says "PR has been sent," but there is no external readback, so the facts have not been proven; 
- Write-back successfully, process crashes before quota deduction, and after reboot, no one knows which side effects have already occurred; 
- The person changed the priority, which was mentioned in chat, but the system status was not bound to the correct goal. 

LoopX's judgment is: **The model context is only working memory, not a long-term state.** Long-term tasks require a control plane independent of the model and a single session. 

This is not about "making the model remember more," but about externalizing the facts needed to make the right decision for the next round: 

| The problem of cross-round continuation | LoopX external form |
| --- | --- |
| What is the goal, and what counts as completion? | Goal, vision/acceptance, boundary |
| What jobs are available now? | Todo, frontier, continuation |
| Who is doing it, and who can do it? | identity, claim, lease, scope |
| What actions are allowed? | authority, gate, capability, workspace guard |
| What happened, can you believe it? | evidence, effect readback, receipt |
| When will it run again, and when will it stop? | monitor, scheduler hint, quota, terminal audit |
| Where to continue after a breakdown or a player change? | journal, run history, replay, recovery |

Therefore, LoopX's product challenge is not "making a stronger agent," but rather: **How to make the same long-term goal continuous, auditable, and recoverable even after multiple sessions, multiple agents, and multiple failures.** 

## 2. Set boundaries: what it does, and what it clearly does not do

| Layer | Who is responsible | Is LoopX responsible |
| --- | --- | --- |
| Model Inference and Tool Loops | Codex, Claude Code, etc. Host | No |
| Tool protocols, sandboxes, approvals | Host / Specific tool runtime | No |
| Domain Rules and External System Calls | Capability   Provider | Only the contract and access are defined |
| Long-term goals, Todo, claim, gate, quota, writeback, recovery | LoopX Kernel | Yes |
| Boards, status pages, chat displays | projection / UI | It's about reading the model, not the source of facts |

The source code breaks runtime responsibilities into four categories (the Runtime Responsibility Model for `docs/architecture.md`, corresponding to the registration boundaries of `CapabilityRegistry`): 

1. **Agent**: Plan, analyze, and invoke tools to complete a bounded execution; No long-term lifecycle. 
2. **Provider**: Invokes external systems, returns bounded observation, effect result, and readback; No domain transformation policy is found. 
3. **Capability**: Define caller-facing outcome, domain policy, observation normalization, validation, and typed transition proposal; Do not write the kernel lifecycle directly. 
4. **LoopX Kernel**: Includes Goal, Todo, Claim, Gate, Monitor, Quota, accepted writeback, Recovery, and Scheduling; No domain inference. 

Requests and results go in opposite directions:

```text
Agent → Capability → Provider → External System
External observation / effect readback → Provider → Capability
typed transition proposal → LoopX Kernel → next Todo / Gate / Monitor / Turn
```

The most important conclusion is: **Observation is not a state transition, and Provider acknowledgment is not accepted progress.** Only after Capability verification and Kernel submission does the state change.

## 3. Six-layer Persistent State: The Control Plane's "Ledger"

`docs/architecture.md` Clearly define the six layers:

| Layer | Function | What it is not |
| --- | --- | --- |
| Registry | Known Goal, repo, adapter, authority source, status, guard | Not a summary of each chat session |
| Goal state | Current active state file for a single Goal | Not a full diary |
| Run log | JSON/Markdown report left by each run | Not the mutable source of facts itself |
| Run history | Compact index for Agent, Heartbeat, UI consumption | Not the original full log |
| Status / attention queue | First-screen projection of who currently needs action | Not the canonical state |
| Compute quota | Local automatic calculation of budget and pause policies | Not a Linux scheduler |

Project-level entry is usually placed at:

```text
<project>/.loopx/registry.json
```

The Registry then points each Goal to `state_file`, while the run history, journal, events, etc. are located under the parsed runtime root; the specific paths are determined by `loopx/runtime.py` and each command parsing, and should not be hard-coded in documents or adapters. Project-private materials usually require `.loopx/` to be ignored by Git.

An easy-to-remember chain:

```text
Registry / Goal State / Run History
        └── Derive ──► Status + Attention Queue
                              │
                              ▼
                         Quota decision
                              │
                              ▼
                         Turn packet
                              │
                              ▼
                   Host / Provider / Capability
                              │
                              ▼
                 validated writeback + receipt
                              │
                              └── Re-derive the next round
```

**Six layers are not six truths.** Goal, Todo/Event, and submitted receipts are facts; Status, Kanban, prompt, and `next_cli_actions` are projections organized for the reader.

## 4. Seven Mental Models

### 4.1 Loop

The main loop of LoopX is not 'while true call the model,' but:

```text
Read current status
  → quota should-run determines whether the next action is allowed
  → Generate TurnEnvelope / transaction plan
  → Host Execute a bounded work once
  Verification Results
  Write-back status
  Flower quota
  → scheduler apply / ack
  → Recalculate the next round
```

Of course, there are model and tool loops within the Host; But LoopX only has **control loops across turns**. Completing a Turn does not mean the goal is complete; Whether the goal is completed is determined by acceptance, monitor, follow-up, and terminal audit. 

### 4.2 Context

LoopX divides context into two categories: 

- **Long-term Facts**: Goal, constraints, Todo, decision, evidence, runtime. Exists across sessions on disk/authority storage. 
- **Context for this round**: Consists of the current TurnEnvelope, selected Todo, capability gate, recommended actions, and sessions provided by the Host. 

Source code supports `iteration_context_policy = fresh | resume`. `fresh` Clearly states that the new round does not assume the old chat remains valid; `resume` Reuses the Host session. Both require rebinding to the current Goal/Todo identity, and the old session cannot replace the current fact. 

### 4.3 Tools

The tool belongs to the Host. LoopX does not allow the model to directly "write the Goal file" to succeed: 

- Agents perform bounded tasks; 
- Capability: Turns domain observation into a typed proposal; 
- Kernel validates proposals and receipts; 
- Only settlement can submit durable state / quota. 

Therefore, successful tool calls are only candidate facts; Without readback and validation, it cannot be considered accepted progress. 

### 4.4 Model Integration

LoopX itself does not implement a provider SDK nor a unified model abstraction. It connects the same control face to Codex, Claude Code, DSH, or generic CLI via the Host adapter. Model selection, credentials, and streaming protocols belong to the Host. 

This brings provider-neutrality, but also comes at a cost: LoopX must define "what to the host, what the host must repay what" as a very strict typographic contract. 

### 4.5 Extension

Main expansion shafts: 

- **Capability**: Product-level capability contracts, such as issue fix, PR review, benchmark; 
- **Provider**: Adapter for true access to external systems; 
- **Extension**: Independent delivery/lifecycle unit, can install providers; 
- **Host adapter / goal mode**: Connect LoopX to a certain runtime; 
- **Projection / UI**: Read-only display, does not grant kernel permissions. 

`CapabilityRegistry` Separate registration of provider, capability contract, and implementation to avoid "installing extensions equals lifecycle write privileges." 

### 4.6 Interface

Multiple consumers on the same control surface: 

- CLI: `loopx status`, `quota should-run`, `turn plan`, `turn run-once`, `todo`, `history`, etc.; 
- JSON: Stable projection for Agent, Heartbeat, and script reads; 
- Host adapter: maps read/write operations to CLI-equivalent operations; 
- Dashboard / Lark / Kanban: Consume public-safe projection; 
- `loopx commands --format json`: Machine-readable entry point for the command face. 

A core principle is **CLI fallbacks always exist**. Services, daemon, or UI are not the only control channels. 

### 4.7 Engineering

LoopX's reliability mainly relies not on "model more care," but on deterministic contracts: 

- Ordered seven-stage affairs; 
- Bind turn key / effect id / receipt; 
- Journal persistence has been completed; 
- Submitted effects are not executed repeatedly; 
- The failure phase must be clearly stated; 
- Restore only unsubmitted steps; 
- Architecture testing restricts control plane out-of-bounds import. 

## 5. How to read the source code directory

| Table of Contents | Responsibilities | First Glance |
| --- | --- | --- |
| `loopx/entrypoint.py`, `loopx/cli.py` | CLI Entry and Command Registration | `main()`, `build_parser()` |
| `loopx/control_plane/` | The Real Kernel Contract and State Transition | `quota/`, `todos/`, `turn_driver/`, `scheduler/`, `goals/` |
| `loopx/capabilities/` | Domain Capability Pack | Specific capability `catalog_entry.py`, `cli.py`, tests |
| `loopx/extensions/` | Optional: provider/integration | `extension.toml`, provider entry |
| `loopx/*_goal_mode/` | Access from different hosts | How to navigate prompts/hooks to CLI |
| `loopx/presentation/`, `web/` | Projection and Display | Is it read-only, or is it overstepping permission? |
| `tests/`, `tests/architecture/` | Behavior and Boundary Proof | turn recovery, import boundary, public/private |

The source code includes both Python and TypeScript. Don't simply interpret it as "Moving the Python control plane to TS": 

- Python still has a large number of CLI, provider bridges, files, and host adaptations; 
- TypeScript handles stricter contracts such as Turn Settlement and quota/scheduler; 
- Python adapters often hand over the provider's results and readback to TS for final determination. 

When reading a path, first confirm the **current implementation owner** before checking the compatibility layer; otherwise, it's easy to get lost between two runtimes. 

## 6. Terminology cards

| Terminology | One-sentence explanation |
| --- | --- |
| Goal | Long-term goals for stable identity, boundaries, and acceptance |
| Todo | A bounded work card under Goal, with id, scope, dependencies, and continuation |
| Frontier | The truly advancable boundary in the current state is not a list of all unfinished items |
| Claim / Lease | Who is responsible/holding a certain period of work; Identity and authority, not permanent leader |
| Gate | Gates that require a user, controller, or pre-factual to pass through |
| Quota | Automatically calculates the budget and its status; Decides whether to spend a slot |
| Evidence | Facts that can support judgments must be fresh, locateable, and verifiable |
| Receipt | A binding receipt for an effect or turn does not equal the accepted result |
| Monitor | Timing/conditional observation work when external conditions are not met |
| Projection | Read the model compressed by humans or agents
| Turn | A governed state transition includes host execution and settlement |
| Settlement | Turns the validated results into durable state, quota spend, and scheduler status |

## 7. Self-Test: First, Determine "Who Has the Facts" 

For each statement below, state whether it is fact, projection, or execution: 

1. "The dashboard shows 3 Todos to do." 
2. "Todo `t-42` has been collected by agent A within the lease." 
3. "Host returns `terminal_closeout_failed`." 
4. "The quota status is `operator_gate`, only blocking gated delivery." 
5. "The model believes PR has merged." 

### Reference answers

1 **Projection**:D Ashboard counts come from state/historical projections, can be reconstructed, and do not own facts. 
2 **Canonical Status**: `t-42` The claim/lease is the control surface fact, determining who currently qualifies to proceed. 
3 **Typed execution result**: `terminal_closeout_failed` This is the typed result returned by the Host/execution path, indicating which failure stage has reached. 
4 **Projection Decision Output**: `operator_gate` is the quota decision state; It only blocks the corresponding scope (e.g., gated delivery) and does not equal a global Goal freeze. 
5 **Model Judgment, Default Is Not Fact**: Requires Provider readback, Capability validation, and Kernel writeback to become durable evidence/state. 

Diagnosis mnemonic: **UI lists, recommended actions, and summaries are all projections; claim/lease, quota spend, writeback, and receipt are the facts that need to bind and persist identities.** 

## 8. Next

Enter `turn-lifecycle.md`. Always ask while reading: 

- Is this step a read-only projection, or will it produce an effect? 
- If a process crashes here, what can journal prove? 
- Why must the next stage be placed after it?
