---
title: "DeerFlow 2.1 Source Code Course · Introduction"
description: "DeerFlow 2.1 Source Code Course Introduction: Seven main tables, reading order, key boundaries, and learning completion standards."
---

:::note[Independent Study Notes]
These are independent study notes organized based on the source code and public documentation of [DeerFlow](https://github.com/bytedance/deer-flow) version v2.1.0 (commit 345f08be), and are not official documentation. This site does not include the upstream source code; below, $DEERFLOW_SRC refers to your own local source code directory.
:::

> Baseline: `deer-flow-2.1`, Git tag `v2.1.0`, commit `345f08be00c8a9495079b732a39b46aa9af1584e` (2026-09-24).
> All paths in this article are relative to `$DEERFLOW_SRC`.
> Old lecture notes are not in this repository; this course is based solely on the v2.1.0 source code, and conclusions from older versions are no longer considered valid.

## Understanding DeerFlow in One Sentence

**DeerFlow is a 'super Agent Harness' with LangGraph as its execution core: the Gateway reliably creates Runs, the RunManager/worker ensures Runs complete reliably, the Lead Agent and its middleware/tools handle rounds of model and tool calls, and the checkpoint, event store, and sandbox ensure results are recoverable, auditable, and deliverable.**

Think of it as a factory:

```text
User/Channel
   │ request
   ▼
Gateway (Gatekeeper + order receiving desk) ──► RunManager (Work order system) ──► worker (Workshop supervisor)
                                                       │
                                                       ▼
                                           Lead Agent / LangGraph (production line)
                                             │        │        │
                                           Model    Tools   Middleware
                                             │        │        │
                                             └──► Sandbox / MCP / Skills
                                                       │
                                                       ▼
                                   Checkpoint + Event Store + Outputs (Ledger and Warehouse)
                                                       │
                                                       ▼
                                                SSE / IM / Frontend
```

## Seven Comprehensive Tables

| Component | Question to answer | Answer from DeerFlow | Main source code |
| --- | --- | --- | --- |
| Cycle | How does one round progress, and when does it stop? | LangGraph graph + middleware chain, worker consumption `astream` | `packages/harness/deerflow/agents/`, `runtime/runs/worker.py` |
| Context | What to show the model, and how to compress and recover? | `ThreadState.messages` + checkpoint + summarization + memory | `agents/thread_state.py`, `middlewares/summarization_middleware.py` |
| Tools | What can models do, and where can they be executed? | built-in tools, sandbox tools, MCP, skills, tool search | `tools/`, `sandbox/`, `mcp/` |
| Model Integration | How to unify multi-vendor and multi-inference settings? | `create_chat_model()` + Configuration whitelist + Provider adapters | `models/factory.py` |
| Expansion | How to build capabilities beyond the core? | skills, MCP, extension API, plugins, IM channels | `skills/`, `extensions/`, `app/channels/` |
| Interface | How do people, programs, and IMs use the same engine? | Web UI, REST/SSE, IM, TUI, Embedded Python Client | `frontend/`, `app/gateway/`, `client.py` |
| Engineering | Why don't changes break the system? | harness/app boundaries, testing, migration, leases, authentication, tracking | `backend/tests/`, `gateway/`, `persistence/` |

Three vertical lines run through each section: 

1. **Event Flow**: HTTP/IM inputs → Run events → SSE/database → frontend/channel. 
2. **Trust Boundaries**: What can client inputs, server RunContext, sandbox, model, and external MCP each trust. 
3. **Token/Cost**: Context budget, summarization, tool output budget, token usage, model selection. 

## Reading Order

| Order | Documentation | What will you get |
| --- | --- | --- |
| 0 | [Global Map](overview/) | Product positioning, service topology, catalog responsibilities, terminology |
| 1 | [A Life of a Run](run-lifecycle/) | The complete source code mainline from HTTP request to end-state |
| 2 | [Core Mechanism](core-mechanisms/) | Context, tools, sandboxes, multiple agents, models, platforms, and reliability |
| 3 | [Engineering Practice](engineering/) | Debugging paths, source code experiments, design trade-offs, self-testing and migration exercises |

## Stage Course (Source Code In-Depth)

After the overview, follow the [Stage Guide](learning-path/) to progress from Stage 0 to Stage 9. `00`~`03` Responsible for establishing global and mechanism intuition; The stage papers are broken down along the real source code for ownership, state migration, failure recovery, and observable experiments. Each self-assessment and exercise includes reference answers. 

## Recommended pronunciation

- **Don't chase every middleware the first time**. Catch `start_run → worker → make_lead_agent → astream → terminal state` first. 
- **Read the second time with three questions**: Who owns this state? Where do you recover after failure? Which fields must never be forged by the client? 
- **Third Experiment**: Change a run field, add a middleware, read an SSE event, then use the test to deduce the contract. 

## The four most easily confused things

1. **Thread is not Run**: Thread is a long-term session ledger; A run is an execution with a start, state, and end. 
2. **Checkpoint is not a business database**: Checkpoint stores the recoverable state of LangGraph; Business data such as users, projects, and scheduled tasks go through the app's persistence layer. 
3. **Memory is not the current context**: The current context is in `messages`; Long-term memory is another path for cross-session retrieval/injection. 
4. **Subagent is not a separate product**: It remains a controlled execution unit under the same Run system, with independent event namespaces, budgets, and capacity constraints. 

## Learning Completion Standards

After reading, you should be able to answer without looking at the document: 

- What objects does `POST /api/threads/{id}/runs` pass through, and at what point does Run change from `pending` to `running`? 
- Why is `start_run` the only choke point for licensing and RunContext? 
- What do SSE events, Run journal, checkpoint, and long-term memory each store? 
- Why must tool execution go through sandbox leases and middleware, rather than directly calling the host shell? 
- Why do multiple agents, scheduled tasks, and IM channels all reuse `start_run`, instead of writing their own own loops? 

### Reference Answers for Learning Completion Standards

1. **Request object chain**: Route `create_run` → [`gateway.services.start_run()` for permissions, model whitelisting, thread attribution, and context cleaning → `RunManager.create_or_reject()` Atom write `pending` → synchronize backend connection Worker → Worker performs conditional state migration in `RunManager.try_start()` and acquires lease → before becoming `running` → `make_lead_agent()` Assemble LangGraph → `astream` Execute → `RunJournal`/`StreamBridge` Output event → Delivery validation and receipt → final state. **HTTP returns usually only pending; pending→running occurs after `try_start()` accepts work, records remain pending, and lease/owner is established.** 
2. **Because Run creates multiple entry points, but only one set of admission rules.** `start_run()` Uniformly performs permission revocation, model whitelisting, thread owner checks, secret cleaning, client-side context whitelist merging, authenticated user injection, and atomic access; If these rules are placed on a router, scheduled tasks, IM, or internal calls can be bypassed. It also constructs a trusted server-side RunContext to ensure the client can only express preferences and cannot forge identities, project ownership, leases, or final states. 
3. **SSE** is the transmission/subscription view of the event stream, with the default owner worker bound; `RunJournal` Records runtime events, tokens, tools, and delivery facts, which can be persisted and replayed by the event store; **checkpoint** stores the LangGraph graph state and recovery points; **long-term memory** stores preferences and facts for cross-session retrieval. SSE is not a source of fact, checkpoint is not an audit log, and memory is not the current context. 
4. **Sandbox Lease** Responsible for isolated execution, mapping virtual paths to the real environment, resource usage, and concurrent usage; **middleware** Responsible for tool visibility, authorization/approval, output budgeting, result matching, misclassification, and unfinishing. Directly calling the host shell turns model parameters into host machine privileges, bypassing path out-of-bounds checks, user authorization, resource recovery, and auditing, and cannot prove who is executing under multiple workers. Tools are "controlled capabilities," not thin packages for arbitrary process calls. 
5. **All new Run creations reuse `start_run()`, while child agents reuse the controlled runtime of the same run.** Scheduled tasks, IM channels, batches, and internal notifications are only responsible for translating input into `RunCreateRequest`, then sharing admission, idempotent, cancel, lease, SSE, delivery, and audit semantics; Sub-agents allocate budget, event namespace, and capacity within the same run, rather than creating a separate model loop. Otherwise, policies for different entry points will drift, and the boundaries between security and recovery cannot be unified. 

> **In short: The core of DeerFlow is not to "make the model adjust tools multiple times," but to turn a single Agent execution into a run—admitted, isolatable, recoverable, auditable, and deliverable.**
