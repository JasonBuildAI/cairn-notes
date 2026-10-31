---
title: "Stage 0: Environment and Source Code Map"
description: "Stage 0: Environment and source code mapping. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: Hermes Agent Source Code Class · Stage Exercise
> Prerequisite: None
> Corresponding Overview: `overview.md`
> Goal of this Stage: Before seeing any details, be able to determine whether a piece of code belongs to the entry, host, agent, or persistent ledger.

## 1. What this stage addresses

The most common mistake when reading Hermes source code is treating "objects that can call `run_conversation()`" as the same executor. In reality, there are four types of roles:

~~~text
Entry/Rendering Layer   Classic CLI, TUI, Desktop, Message Platform
     │ Submit/Replay, does not own turn
Host layer Gateway, tui_gateway, process where the message adapter is located
     │ admission, FIFO, lease, delivery
Agent layer      AIAgent / turn_facade / conversation_loop
     Synchronous Execution of Models and Tools
Ledger Layer SessionDB, transcript, admission, lease, locks
~~~

First, establish this coordinate system. Later, when you see `GatewayAgent`, `AIAgent`, `TurnRunner`, `SessionAuthority`, you won't get confused.

## 2. First, remember a judgment

**Execution belongs to the host, not the rendering layer; session facts belong to the durable ledger, not to an object within a process.**

So:

- The classic CLI `GatewayAgent` may look like an Agent, but it is just a submit-and-event-replay proxy;
- `TurnRunner` sets up callbacks, approvals, and deliveries in the Gateway host, without replacing the core loop;
- `AIAgent.run_conversation()` is the synchronous turn core, but you first need to obtain a durable lease;
- After the state lines are recorded in the database, the process can still read them back after a restart, instead of relying on "I remember it just ran."

## 3. Mainline Source Code

1. `hermes_cli/gateway_agent.py`: Classic CLI-side proxy. It submits `prompt.submit`, consumes gateway events, and finally constructs results in the same shape as the local Agent.
2. `gateway/run.py::GatewayRunner`: Gateway host, managing adapters, session runtime, background maintenance, and turn execution entry.
3. `gateway/run_turn_runner.py::TurnRunner`: Host collaborator for a single turn, connecting streaming output, tool progress, approvals, notifications, and delivery.
4. `gateway/session_authority.py::SessionAuthority`: Session authority, owning live sessions, durable FIFO, admission, and execution generation.
5. `agent/turn_facade.py::TurnFacadeMixin.run_conversation`: Agent-side facade, first takes the lease, then enters `agent/conversation_loop.py`.
6. `agent/conversation_loop.py::run_conversation`: The actual synchronous model/tool loop.
7. `hermes_state.py::SessionDB` and `hermes_state_common.py`: SQLite ledger, schema, locks, messages, and recovery helpers.
8. `tui_gateway/`: Shared Python backend for TUI/Desktop, also builds `AIAgent` itself, not another chat product.
9. `plugins/`, `cron/`, `tools/`, `providers/`: Extension capabilities, scheduling, tool interface, and model adaptation.

## 4. Key Objects and Contracts

| Object | Facts it owns | Cannot replace |
| --- | --- | --- |
| `GatewayAgent` | Submissions and event replays on a CLI connection | Real model loop |
| `TurnRunner` | Single turn host callbacks and delivery orchestration | `AIAgent`'s context/tool semantics |
| `SessionAuthority` | FIFO order, admission claims, generation | Message-by-message content of transcript |
| `DurableTurnLease` | Whether the current process has the right to continue writing this session | User intent or model success |
| `AIAgent` | Memory state and local loop variables of the current turn | Cross-process durable facts |
| `SessionDB` | Recoverable sessions, messages, state lines | Proof that "the model will definitely respond successfully" |

Boundary rules:

- Clients can provide session id, text, and attachments, but cannot forge principal, operator provenance, or kanban producer marker;
- Entry points can display state, but cannot change `unknown` to `queued` themselves;
- Agents can produce tool calls, but cannot bypass call/result pairing to write transcripts directly;
- The database can prove that a row exists, but cannot automatically prove that external side effects happened only once.

## 5. An Observable Trace

~~~text
hermes CLI
  → GatewayAgent.run_conversation()
  → prompt.submit
  → GatewayRunner / TurnRunner
  → SessionAuthority.submit()
  → session_admissions: queued
  → drain claim: started
  → AIAgent.run_conversation()
  → turn lease
  → conversation loop
  → finalize + transcript
  → delivery event
  → CLI replay the event and print
~~~

Note that the final step still belongs to the entry point: the model and tools are already completed in the host, and the CLI merely converts events into terminal output.

## 6. Experiments

### Experiment A: Locating the execution boundary of a classic CLI

Use `rg -n "prompt\.submit|class GatewayAgent" hermes_cli/gateway_agent.py`, then check whether `AIAgent` is constructed in that file.

### Experiment B: Locating the four layers of a single turn

Use `rg -n "class SessionAuthority|class TurnRunner|class TurnFacadeMixin|def run_conversation" gateway agent`, and assign the hit paths separately to the host and Agent layers.

### Experiment C: Confirming version semantics

Read `version` of `pyproject.toml`, then check whether `.git` exists in the archive root directory. Do not overwrite the course baseline `v0.22.5` with `0.0.0`.

### Reference Answers for Experiments

1. **Experiment A**: `GatewayAgent` is responsible for connecting and submitting, but does not construct the actual `AIAgent`; the real turn is executed within the Gateway/TUI host.
2. **Experiment B**: `SessionAuthority`, `TurnRunner` belong to the host; `TurnFacadeMixin`, `AIAgent`, and `conversation_loop` belong to the Agent; `SessionDB` belongs to the ledger.
3. **Experiment C**: `0.0.0` is a build placeholder; the release baseline is the archive name and `v0.22.5`. Without `.git`, you cannot fabricate a commit.

## 7. Failures and Recovery

| Misjudgment | Consequence | Correct Approach |
| --- | --- | --- |
| Treating CLI as executor | Checking model/tool logs in the wrong process | First check `prompt.submit` and host logs |
| Treating in-memory Agent as ledger | Re-execution after restart | Check `SessionDB` and admission line |
| Treating adapter as Agent | Each channel independently creating state | Inbound unified construction into admission |
| Treating database persistence as business success | Re-sending external side effects | Check tool results and delivery receipt simultaneously |

## 8. Self-Test for Clearance

1. What is the key difference between `GatewayAgent` and `AIAgent`?
2. What do `SessionAuthority` and `SessionDB` each hold?
3. Why don't TUI/Desktop need to follow exactly the same process path as classic CLI?
4. When a turn gets stuck, what is the first thing you should check?

### Reference Answers

1. `GatewayAgent` is the entry-side agent, submits requests and replays events; `AIAgent` holds turn context, model calls, tool rounds, and finalize steps, and is the actual execution core.
2. `SessionAuthority` manages real-time sessions and durable FIFO, claim, generation; `SessionDB` is a recoverable SQLite ledger, storing persistent facts like session, messages, admission, lease, etc.
3. Because the principle is "execution belongs to the host, not the rendering layer." TUI/Desktop's shared Python backend can construct `AIAgent` independently; classic CLI submits through the Gateway. Although the entry points are different, the core semantics are the same.
4. First determine which process it is in, whether it has admission, and whether it obtained a lease; do not immediately suspect the model or modify the context.

## 9. Source Code Coordinates

- `hermes_cli/gateway_agent.py`
- `gateway/run.py`
- `gateway/run_turn_runner.py`
- `gateway/session_authority.py`
- `agent/turn_facade.py`
- `agent/conversation_loop.py`
- `hermes_state.py`
- `hermes_state_common.py`
- `tui_gateway/`

## 10. Next Step

Enter Stage 1: How an input becomes a persistent admission from the entry, and then is ensured by a durable lease so that only one writer exists per session.
