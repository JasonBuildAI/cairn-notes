---
title: "00 · Global Map: First Establish a Coordinate System That Won't Get Lost"
description: "Establish a global coordinate system for DeerFlow 2.1 from three perspectives: product, operation, and source code."
---

> Baseline: DeerFlow `v2.1.0`(`345f08be`). This article does not go into details, only answers four questions: what it is, who composes it, where the code is, and which layers a single request goes through. 

## 1. What problem it solves

Ordinary chatbots only have 'model ↔ conversation'. DeerFlow aims to solve more engineering-oriented problems:

- Tasks may last a long time and need **resumption**;
- Models need to read files, run commands, access the internet, call external services, requiring **isolation and permissions**;
- Context may exceed the window size, requiring **compression, budgeting, and long-term memory**;
- A task may require **multiple sub-Agents** running in parallel;
- The same execution needs to serve Web, API, IM, and TUI simultaneously, requiring unified **events and state**;
- After errors, it is necessary to know 'which step failed, whether it can be retried, and whether side effects have been produced'.

Therefore, the core object of DeerFlow is not a chat message, but a **Run**.

## 2. Three perspectives on the same system

### Product Perspective

It can conduct deep research as well as carry out "super agent" tasks: web search, file processing, code execution, report generation, scheduled tasks, IM robots.

### Operational Perspective

```text
Browser / IM / SDK
        │
        ▼
Nginx (2026) ──► Next.js frontend (3000)
        │
        └────────► FastAPI Gateway (8001)
                         │
                         ├── Auth / CSRF / Trace
                         ├── start_run()
                         ├── RunManager + worker
                         ├── StreamBridge (SSE)
                         └── Scheduler / Channels / MCP Tasks
                                      │
                                      ▼
                         LangGraph Lead Agent + Middleware
                           │        │         │
                         Model    Tools     Memory
                           │        │         │
                           └── Sandbox / MCP / Skills
                                      │
                                      ▼
                       Checkpoint / Event Store / PostgreSQL
                                      │
                                      ▼
                              outputs + SSE + reply
```

`sandbox provisioner` (default 8002) is the control service for the isolated execution environment; in Docker mode, it prepares/recycles resources for sandbox containers, and in Kubernetes mode, it creates sandbox Pods.

### Source Code Perspective

```text
backend/
├── packages/harness/deerflow/   # Releaseable cores: agent, tools, sandbox, models, memory...
├── packages/extension-api/      # Extended Contract
└── app/                         # Application layer that cannot be released
    ├── gateway/                 # FastAPI authentication, Run API, channel/scheduling assembly
    ├── channels/                # Feishu / Slack / Telegram / Discord / DingTalk...
    ├── scheduler/               # Scheduled tasks
    └── mcp_tasks/               # Persistent MCP task notification/write-back

frontend/                        # Next.js Product Interface
contracts/                       # Cross-component contracts
deploy/                          # Compose / Helm and other deployment assets
```

## 3. The Most Important Architectural Boundary: One-Way Dependency Between Harness and App

This is the first hard rule of reading the DeerFlow source code:

```text
app/*  ───────►  deerflow/*     allowed
deerflow/* ───►  app/*          forbidden
```

The reason is not that the "directory looks nice," but rather:

- `deerflow` must be reusable by Embedded Client, SDK, or other hosts;
- If the core has reverse dependencies on a Web route, IM channel, or database table, it is no longer a general harness;
- The boundaries are enforced in CI by `backend/tests/test_harness_boundary.py`.

How to judge when reading code:

- When you see `from deerflow...`: you are reading a reusable core;
- When you see `from app...`: you are reading the assembly layer deployed for a specific product;
- When you see `deerflow` importing `app`: this is a bug, not a new architecture.

## 4. Where the seven blocks fall

| Block | Core Responsibilities | Files to open first |
| --- | --- | --- |
| Loop | Building graphs, running graphs, consuming events, wrapping up | `agents/factory.py`, `runtime/runs/worker.py` |
| Context | Message state, compression, memory, checkpoint | `agents/thread_state.py`, `agents/middlewares/summarization_middleware.py`, `runtime/journal.py` |
| Tools | Tool registration, execution, result budgeting, approval/fence | `tools/tools.py`, `sandbox/tools.py`, `agents/middlewares/read_before_write_middleware.py` |
| Model | Model whitelist, provider, inference tiers, tracing | `models/factory.py`, `config/model_config.py` |
| Extensions | Skills, MCP, Python extension, IM | `skills/`, `mcp/`, `extensions/`, `app/channels/` |
| Interface | REST/SSE, Web, IM, TUI, Python Client | `app/gateway/routers/`, `frontend/src/`, `client.py` |
| Engineering | Authentication, lease, migrations, tests, observability | `app/gateway/`, `runtime/runs/manager.py`, `persistence/` |

Three vertical lines:

- **Event flow**: `Run journal → event store → StreamBridge → SSE/IM`, for "seeing the process."
- **Trust boundary**: `HTTP input → allowlisted RunContext → middleware/tool → sandbox`, for "who can influence what."
- **Token/Cost**: `context measurement → summarization → tool output budget → token budget → usage aggregation`, for "how much to spend and when to stop."

## 5. Six objects that are most easily confused

| Object | What it is | What it is not |
| --- | --- | --- |
| `Thread` | Long-term conversation container, multi-turn Run sharing history | A single execution |
| `Run` | A single stateful execution with an endpoint | One message |
| `RunRecord` | Run control records in memory/persistence layer | Complete chat history |
| `Checkpoint` | Recoverable snapshot of LangGraph state | Business database |
| `Journal/Event Store` | Process event ledger for audit, replay, SSE | The model context itself |
| `Memory` | Long-term facts/preferences across sessions | Messages in the current window |

Two more additions:

- **Sandbox** is the execution environment for tools; it is not the "tool itself." The tool is the interface, the sandbox is the boundary where actions are carried out.
- **Subagent** is an execution unit within the same Run constrained by capacity/budget/permissions; it is not another Gateway.

## 6. Configuration and run entry

The main configuration is `config.yaml` at the repository root, and extended configuration is `extensions_config.json`. Configurations handle model whitelists, sandbox providers, summarization, memory, MCP, channels, scheduling, authentication, and more.

Common startup methods:

```powershell
# Local full-stack development (specifically based on Makefile / current environment scripts)
make dev

# Docker Production entry, default aggregated into one entry
make up
```

Source Code Entry Points:

- Gateway ASGI: `backend/app/gateway/app.py`'s `app`
- LangGraph Factory: `backend/packages/harness/deerflow/agents/__init__.py`'s `make_lead_agent(config)`
- Embedded Client: `backend/packages/harness/deerflow/client.py`
- Frontend: `frontend/src/`

## 7. A "Source Code Reading Roadmap"

```text
① Find the request entry
   app/gateway/app.py
   app/gateway/routers/*

② Find a unified admission port
   app/gateway/services.py::start_run

③ Find Run lifecycle
   runtime/runs/manager.py
   runtime/runs/worker.py

④ Find Agent assembly
   agents/__init__.py::make_lead_agent
   agents/lead_agent/agent.py
   agents/factory.py::create_deerflow_agent

⑤ Find middleware/tools/models
   agents/middlewares/
   tools/
   models/factory.py

⑥ Find persistence and output
   runtime/journal.py
   runtime/checkpointer/
   runtime/stream_bridge/
   app/gateway/services.py's terminal/delivery logic
```

## 8. Self-Test of This Article

1. Why can't `deerflow` import `app`? If broken, what kind of reuse capability would be lost?
2. What questions do `Thread`, `Run`, `Checkpoint`, and `Memory` each answer?
3. What roles correspond to the ports 8001/8002/3000/2026 respectively?
4. Through which layers does an event of a single Run go to the browser?
5. If only `messages` is considered, what type of system facts will be missed?

### Reference Answers

1. **Because `deerflow` is a reusable kernel, and `app` is the assembly layer of a particular host.** Once the kernel depends backward on Web routes, IM channels, or some database table, the Embedded Client, SDK, test host, and other products can no longer reuse independently; `backend/tests/test_harness_boundary.py` would turn this degradation into a CI failure.
2. **Thread** answers "What is this long-term conversation, and whose history is it?"; **Run** answers "Which execution is happening and what state is it in?"; **Checkpoint** answers "Where has LangGraph executed to, and what graph state is needed for recovery?"; **Memory** answers "What preferences/facts should still be remembered across sessions?" Their lifecycles and consistency goals differ and cannot be merged.
3. `2026` is the Nginx entry; `3000` is the Next.js frontend; `8001` is the FastAPI Gateway; `8002` is the sandbox provisioner control service.
4. The main path is: worker generates `RunJournal` event → `StreamBridge` (memory or Redis) → Gateway's SSE consumer/router → browser. During offline replay, it also goes through the persistent events in the event store and `Last-Event-ID` semantics.
5. Only looking at `messages` will miss control-plane facts: Run state, lease/owner, idempotent keys, cancellation, tool failure classification, token/usage, event order, delivery receipt, workspace artifacts, and audit information. `messages` is a model context projection, not a system ledger.

The next article will only follow a single main line: `POST /api/threads/{id}/runs` how to turn it into a recoverable, observable, and deliverable Run.
