---
title: "Stage 0: Environment and Source Code Map"
description: "Stage 0: Environment and source code mapping. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: LoopX Source Code Class · Stage Test  
> Prerequisite: Finish `overview.md`  
> Corresponding Overview: `overview.md`, `turn-lifecycle.md`  
> Goal of this Stage: Obtain the version baseline and establish the source code map of "six layers of facts, one main chain."

## 1. What this stage addresses

First, avoid three common misunderstandings:

- Treating LoopX as just another model loop framework;  
- Treating Status or prompt as the source of facts;  
- Treating the Host returning a JSON as the work being completed.

The map to be established in this stage is:

```text
Entrance and Projection
  CLI / Dashboard / Goal Mode adapter
        │
        ▼
Control plane facts
  Registry / Goal State / Todo / Claim / Gate / Authority / History
        │
        ▼
Decision Making and Contracts
  Status projection / Quota should-run / Turn Envelope / Transaction
        │
        ▼
Host and domain capabilities
  Host adapter / Capability / Provider / readback
        │
        ▼
Settlement and Recovery
  Validation / Writeback / Spend / Scheduler / Journal
```

## 2. First, remember a principle

**The core asset of LoopX is 'recoverable long-term state,' not a single model output.**

So when reading the source code, the priority should be: state ownership > contracts and invariants > failure recovery > model prompts. Prompts are important, but they are just one type of consumer of the current projection.

## 3. Source Code Main Line

1. `loopx/cli.py` and `loopx/cli_commands/` are the entry points for humans and scripts, responsible for parsing commands and printing public payloads.
2. `loopx/registry.py` maintains registered Goals, paths, and global health information.
3. `loopx/control_plane/goals/` is responsible for the Goal lifecycle, state parsing, frontier, acceptance, and direction baseline.
4. `loopx/control_plane/todos/` is responsible for Todo contracts, state, completed transactions, gates, and projections.
5. `loopx/control_plane/quota/` is responsible for should-run decisions, route selection, budgets, consumption, and envelope.
6. `loopx/control_plane/turn_driver/` is responsible for host requests, typed results, validation, settlement, journal, and recovery.
7. `loopx/capabilities/` and `loopx/extensions/` are responsible for domain capabilities, Provider, and Host adaptation.
8. `loopx/presentation/`, Dashboard, and IM are just model consumers.

## 4. Key Objects and Contracts

| Object | Source of Truth | Cannot Be Replaced By |
| --- | --- | --- |
| Goal | Registry Goal State | Saying in chat 'The goal is completed' |
| Todo | Todo contract and persistent state | A single summary line in Status |
| Claim/Lease | Claim record and term | The model claiming 'I'm responsible' |
| Gate | Preconditions, human decisions, acceptance criteria | Recommended action order |
| Quota | Quota and should-run decisions | Whether this call reported an error |
| Evidence | Optional evidence and validation receipt | Host's natural language summary |
| Run History | run/turn journal and receipt | Whether SSE events were received |

## 5. An Observable Chain

```text
Command/Automation Input
  Found Goal in registry →
  → status/refresh Generate current frontier
  → quota should-run gives access and recommendation actions
  → turn plan fixed identity, envelope, phases
  → host execute
  → typed result verification field and turn_key
  → validation / writeback / spend / scheduler
  → journal leave completed prefix
  Recalculate frontier on the next refresh
```

## 6. Experiment

### Experiment A: Confirming Version and Directory

```powershell
cd $LOOPX_SRC
git describe --tags --always
git rev-parse HEAD
rg --files loopx\control_plane | Measure-Object
```

Reference Acceptance: tag is `v2.1.1`, commit starts with `87e5b4f8`; can see `goals/`, `todos/`, `quota/`, `turn_driver/`, `scheduler/`.

### Experiment B: Reverse Lookup from Entry

```powershell
rg -n "def register_turn_commands|def register_status_commands" loopx
rg -n "build_quota_should_run|build_loopx_turn_transaction_plan" loopx
```

Reference Observation: The command registration function only handles parameters and presentation; the actual decisions and contracts are in `control_plane`.

### Experiment C: Tagging Files with Layers

Select any 10 files from `loopx/control_plane` and label each file as "Fact / Decision / Contract / Execution / Settlement / Projection." If it cannot be labeled, it indicates that its inputs and outputs have not yet been understood.

### Reference Answers for the Experiment

1. It should be verified against `v2.1.1` and the commit prefix should match the repository; under `control_plane` you can see directories such as goals, todos, quota, turn_driver, scheduler.
2. The command registration layer only parses parameters and displays them; decisions and contracts for should-run/Turn Plan are constructed by `control_plane`.
3. Each file should be classifiable as fact, decision, contract, execution, settlement, or projection based on its inputs and outputs; if it cannot be classified, it usually means its ownership has not yet been found.

## 7. Failures and Recovery

| Phenomenon | Common Misjudgment | Correct Entry Point |
| --- | --- | --- |
| `should_run=false` | Believing the system is broken | Check reason, state, waiting_on, health/gate |
| Host outputs exist but status does not change | Believing writeback occurs automatically | Check validation, receipt, completed_phases |
| Status inconsistent with DB | Directly modify Status | First check the source of facts, then refresh projection |
| Duplicate execution after reboot | Only look at "whether the previous run had errors" | Read the completed phases and effect id from the journal |
| Recommended action missing | Believing the action is illegal | Re-run authority/preflight; recommendations are not whitelist only |

## 8. Self-Test for Completion

1. What are the responsibility boundaries between LoopX and Host?
2. Why can't Registry, Goal State, and Run History be merged into a single chat record?
3. When seeing a file, how can you quickly determine if it belongs to the fact layer or the projection layer?
4. Why does "Host output exists" not prove that the Turn has been submitted?
5. Why must the version baseline be recorded along with source coordinates?

### Reference Answers

1. Host provides models, tools, and a single bounded execution; LoopX is responsible for selection, authorization, contracts, verification, writeback, consumption, scheduling, and recovery. LoopX does not own the model loop, and Host does not own long-term facts.
2. Chat records are compressed and session-switched; they cannot stably represent Todo identity, claim deadlines, gate prerequisites, quota consumption, and effect idempotent keys; merging the three would make recovery depend only on natural language inference.
3. Check whether it stores a state "that can be independently read by subsequent processes and used to reject actions." If it is just calculated elsewhere for display, it is usually a projection; if it is written out and used as a recovery basis, it is usually a fact.
4. Host output is only a candidate fact; it must pass turn_key, field, and evidence verification, be written back after validation, and then complete consumption and scheduling; any step could be interrupted halfway.
5. The fields, phase order, and default policies vary across versions. Without version and commit, source coordinates cannot be verified, and conclusions may mistakenly treat old behavior as current fact.

## 9. Source Coordinates

- `README.md`
- `pyproject.toml`
- `loopx/cli.py`
- `loopx/registry.py`
- `loopx/status.py`
- `loopx/control_plane/goals/`
- `loopx/control_plane/todos/`
- `loopx/control_plane/quota/`
- `loopx/control_plane/turn_driver/`
- `loopx/capabilities/`

## 10. Next Steps

Move to Stage 1: First sort out the object relationships of Goal, Todo, Claim, Gate, Run, and projection, then see how they are selected by quota.
