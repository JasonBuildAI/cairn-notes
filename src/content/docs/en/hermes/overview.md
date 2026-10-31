---
title: "00 · Global Map: First Establish a Coordinate System That Won't Get Lost"
description: "Establish a global map for Hermes multi-frontends, resident hosts, Agent core, and SessionDB."
---

> Baseline: Release archive `hermes-agent-0.22.5` (`v0.22.5`, release date `2026.9.24`). The archive does not include `.git` and does not claim commit/tag.  
> This article does not go into details, only answers four things: what Hermes is, who owns its execution, where the code is located, and which layers a single input passes through.  

## 1. Start with a failure scenario

Suppose you only want to make "a CLI that can chat":

```text
User inputs →, calls model →, if there is a tool then execute →, then send the result back to the model →, print the answer
```

This model works fine under single-process, single-user, short-task conditions. But Hermes has to deal with a different reality:

- The same set of Agents must simultaneously serve classic CLI, TUI, Desktop, Telegram, Discord, Slack, and other entry points;
- Users might send a message on their phone and then continue the same conversation on their computer;
- A single turn could last for dozens of minutes, during which the process may restart, the network may disconnect, or the model may be rate-limited;
- Background tasks completing, scheduled tasks triggering, or sub-agents reporting will all generate "new inputs not sent by humans";
- Two processes might simultaneously want to operate on the same session;
- Tools might delete files, send messages, or modify remote repositories, and after failure, it must be known whether side effects occurred;
- Context might exceed the window, and compression will alter historical bytes, directly affecting prompt cache and costs.

If you try to stuff all of these into the "CLI main loop," the system will quickly become a bunch of memory states only valid for the current process. Hermes' choice is: **take execution out of the entry point and hand it over to a host that has session management and a ledger.**

## 2. Three operational modes, one topology

Hermes is not a single process, but three host forms that share the same Agent core:

```text
┌──────────────────────────── Entrance Level ────────────────────────────┐
│ Classic CLI            TUI / Desktop          Messaging Platform           Dashboard / API │
│ (prompt_toolkit)    (Ink / Electron)       (Telegram, ...)    (web / serve)   │
└──────┬───────────────────┬──────────────────────┬──────────────────┬─────────┘
       │ GatewayAgent      │ JSON-RPC / WS        │ adapter          │ PTY / RPC
       ▼                   ▼                      ▼                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Host Layer                                           │
│  Gateway process (gateway/run.py)          tui_gateway Python backend              │
│   ├─ SessionAuthority                   ├─ Build reality AIAgent                    │
│   ├─ durable FIFO                       ├─ session registry / event replay     │
│   ├─ TurnRunner                         ├─ slash worker / server requests      │
│   └─ adapter delivery                   └─ can bind canonical session authority   │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                               Agent floor                                        │
│  AIAgent(run_agent.py)                                                      │
│   ├─ TurnFacade:durable turn lease / relay / accounting scope                │
│   ├─ conversation_loop: Synchronous turn loop                                        │
│   ├─ turn_context: History, system prompt, compression, hooks                             │
│   ├─ turn_api_*: request, streaming, retry, fallback                                    │
│   ├─ turn_tool_round / tool_executor: Tool Rounds                                 │
│   └─ turn_finalizer: finishing, persistence, memory/skill review                         │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                               Persistence Layer                                          │
│  SessionDB(SQLite WAL)                                                      │
│   messages / sessions / system_prompts / admissions / leases / locks / ...    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Classic CLI: Agent, Not Executor

The classic REPL of `hermes` (`cli.py::HermesCLI`) calls `_init_agent()` the first time an Agent is needed, and what it imports is:

```python
from hermes_cli.gateway_agent import GatewayAgent as AIAgent
```

`GatewayAgent.run_conversation()` Only do three things:

1. Package user messages, history, author information, and persistent metadata into `prompt.submit`;
2. On the calling thread, consume the gateway's `event` stream, translating `message.delta`, tool progress, approval requests, etc., back to CLI callbacks;
3. Wait for `message.complete` of this admission, then assemble a result with the same shape as `AIAgent.run_conversation()`.

Therefore, the CLI process **does not build a real agent, execute tools, or write `state.db`**. It is a 'remote terminal', not an execution engine.

### 2.2 Messaging Platform: One Gateway Serves Multiple Platforms

`gateway/run.py` is a facade. Startup, adapter, inbound, turn, busy, goal, notifications, and shutdown are separately implemented in `run_*.py`. Under `gateway/platforms/` are adapters for each platform, described in the main document as about 20 built-in platforms.

The path of a platform message is:

```text
adapter received the message
  → Analysis of source, identity, chat/session key
  Check the pending queue of the active session
  → SessionAuthority.submit(...)
  Write to session_admissions (durable FIFO)
  → drain receive, TurnRunner organization turn
  → Real AIAgent.run_conversation(...)
  → Event/Stream Output → Adapter responds to the original channel
```

Gateway has two "busy-time message guards":

- `_pending_messages` at the adapter layer;
- inline interception in the runner layer for `/stop`, `/new`, `/queue`, `/status`, `/approve`, `/deny`.

New commands that must arrive while the Agent is blocked (for example, approvals) must bypass both of these guards simultaneously and cannot go through the background message handling path.

### 2.3 TUI / Desktop: shared Python backend

The process model of `hermes --tui` is:

```text
Node (Ink)  ──stdio JSON-RPC──  Python (tui_gateway)
   │                                  └─ AIAgent + tools + sessions
   └─ Only responsible for rendering transcript / composer / interaction
```

TypeScript only has the screen; Python has session, tools, model invocation, and slash logic. Desktop connects to the same backend (WebSocket) through `apps/shared`'s `JsonRpcGatewayClient`, instead of rewriting the Agent in React.

`tui_gateway/agent_factory.py` will directly `from run_agent import AIAgent` and build instances. So on the TUI/Desktop path, AIAgent resides in the Python backend process (or its compute-host subprocess) and does not need to go through Gateway's `GatewayAgent` proxy.

Dashboard is another type: `web/`'s `/chat` embeds the real `hermes --tui` through PTY, not a second chat UI. The difference between Desktop and Dashboard is: Desktop is a standalone native chat interface, while Dashboard is a real TUI container in the browser.

### 2.4 Why the three paths are still one system

Because they eventually converge to the same set of contracts:

- The same `AIAgent.run_conversation()` structure;
- The same `agent/turn_*.py` phase divisions;
- The same `SessionDB` transcript and schema;
- The same set of `toolsets` / `model_tools` / `providers`;
- The same set of durable lease, compression, approval, and event semantics.

The entry points can differ, but **execution invariants must be the same**. This is why Hermes can maintain consistency across multiple endpoints.

## 3. Four-layer responsibilities

| Layer | Owns | Doesn't Own | Typical Source Code |
| --- | --- | --- | --- |
| Client | Input, rendering, local interactive state, slash completion | Agent construction, tool execution, transcript authority | `cli.py`, `ui-tui/`, `apps/desktop/`, `gateway/platforms/` |
| Host | Session lifecycle, admission/FIFO, turn scheduling, events, approval round-trip, delivery | Specific model protocol details, tool implementation | `gateway/`, `tui_gateway/` |
| Agent | Context of a single turn, model requests, tool rounds, compression, finalization | Cross-process queuing, platform delivery, UI rendering | `run_agent.py`, `agent/` |
| Persistence Layer | Transcript, system prompt, admission, lease, locks, usage, recovery metadata | Business decisions, model selection strategy | `hermes_state*.py` |

An important corollary: **"Who owns the state" is more important than "where the state is stored."** The client can have its own cache, but for state that can also be changed by other endpoints, the authority must reside in the host or `SessionDB`.

## 4. Directory Map

| Path | Responsibility | Look at first |
| --- | --- | --- |
| `run_agent.py` | Facade and mixin assembly | Class definitions, `__init__` parameters, mixin list |
| `agent/` | turn loop, context, compression, tool execution, model transfer, persistent facade | `AGENTS.md`, `conversation_loop.py`, `turn_*.py` |
| `cli.py` / `hermes_cli/` | Classic CLI, configuration, authentication, commands, GatewayAgent | `hermes_cli/AGENTS.md`, `cli_agent_setup_mixin.py` |
| `gateway/` | Message gateway, adapter, session authority, turn runner, delivery | `gateway/AGENTS.md`, `run.py`, `session_authority.py` |
| `tui_gateway/` | Python JSON-RPC backend for TUI/Desktop | `tui_gateway/AGENTS.md`, `server.py`, `agent_factory.py` |
| `hermes_state*.py` | SQLite session ledger, FTS, compressed lock, admission, repair | `hermes_state_common.py` schema, `hermes_state.py` docstring |
| `tools/` | Tool implementation, approval, connectors, delegation, browser, terminal | `tools/AGENTS.md` |
| `toolsets.py` / `model_tools.py` | Toolset parsing, schema generation, tool routing | `_HERMES_CORE_TOOLS`, `resolve_toolset()`, `handle_function_call()` |
| `providers/` | Provider profile registration and discovery | `providers/base.py`, `providers/__init__.py` |
| `plugins/` | Plugin loader and built-in plugin types | `plugins/AGENTS.md`, `plugin_loader.py` |
| `skills/` | Built-in skills and skill specifications | `skills/AGENTS.md` |
| `cron/` | Scheduled tasks and kanban multi-Agent queues | `cron/AGENTS.md` |
| `web/` / `apps/desktop/` / `ui-tui/` | Dashboard, Desktop, Ink TUI | Their respective `AGENTS.md` |
| `pm/` / `pyproject.toml` / `uv.lock` | Dependencies, toolchain, hash locking | `pm/AGENTS.md` |

## 5. Seven-Block Framework

### Loop

The core is synchronous `run_conversation()` of `agent/conversation_loop.py:1785`. Each iteration advances in fixed stages:

```text
begin_iteration → prepare_iteration → assemble_api_request
→ run_preflight_gate → announce_api_call → API retry loop
→ apply_retry_restarts → normalize_model_response
→ tool round or finish_text_response
→ finalize_turn
```

The stopping condition for a loop is not as simple as 'the model said stop': it also includes iteration budget, runtime budget, user interruption, compression blockage, tool guarding, persistence failure, streaming timeout, and empty response recovery. 

### Context

`build_turn_context()` is responsible for preparing a round of inputs; `build_api_messages()` is responsible for generating the actual copy sent to the provider. Historical message replay `api_content` sidecar, system prompt is assembled according to `stable → context → volatile` three layers, each session is built only once and then replayed as-is. Compression is the only place allowed to change this segment of bytes.

### Tools

`toolsets.py` defines the static toolset and core tools; `model_tools.py` parses the toolset into a schema and routes each call; `agent/tool_executor.py` is responsible for concurrent/serial/segmented execution, approvals, heartbeat, result persistence, and interruption compensation.

### Model Integration

`ProviderProfile` is declarative: auth type, base URL, models URL, streaming support, vision capabilities, request quirks, error classification, and model aliases are all written in the profile. The actual client construction, credential rotation, and streaming processing still occur at the `AIAgent`/transport layer.

### Extensions

The core of Hermes is a 'narrow waist': each model tool is sent with every API call, so the threshold for adding new core tools is high. New capabilities are preferentially added to CLI skill, service-gated tools, plugins, MCP, or independent repositories.

### Interface

Classic CLI is an agent; TUI/Desktop shares a Python backend; the Dashboard embeds a true TUI; messaging platforms go through an adapter. All interfaces share slash semantics, approval/clarification requests, and event shapes.

### Engineering

The prompt cache invariants, profile scope, exact pin, behavioral contract tests, code health ratchet, and `scripts/check` together form a defense against changes silently breaking the system.

## 6. Four Vertical Lines

### 6.1 Fact Line: transcript and projection

```text
SessionDB.messages(canonical transcript)
   ├─ Read model: CLI/TUI/Desktop's history
   ├─ Write model: AIAgent._flush_messages_to_session_db
   ├─ Compress: parent_session_id Rotate / active/compacted Mark
   Search: (optional external content layout)
```

`SessionDB` is not just a simple chat log. It also preserves `session_admissions` (queued inputs), `session_turn_leases` (cross-process turn leases), `compression_locks` (compressed mutexes), `worker_executions` / `worker_receipts` (background work receipts), `conversation_generations` (session generations), and `gateway_heartbeats` (backend liveness).

### 6.2 Event Timeline: Live Stream and Durable Transcript

The event stream is responsible for "what is happening now": `message.delta`, tool start/end, approval requests, status updates, `message.complete`. The transcript is responsible for "what has already happened." The two should not be confused:

- Reconnection relies on transcript and event replay;
- Real-time UI relies on the event stream;
- Approvals/clarifications are server→client requests, requiring explicit client acknowledgment;
- Completion of background tasks goes through `admit_internal_event` into the same durable FIFO, rather than secretly inserting a message.

### 6.3 Permission Timeline: Who can submit, who can execute, who can modify

```text
Principal / capability
   → SessionAuthority.authorize(submit)
   → admission row
   → turn lease
   → approval / guardrail
   → tool effect
```

Every layer is not decorative: the client cannot forge the owner; the lease prevents two processes from writing to the same session simultaneously; approval prevents dangerous commands; guardrail prevents tools from going out of bounds; profile scope prevents settings from one profile from leaking to another profile.

### 6.4 Cost Vertical: Context, Cache, Auxiliary Models

The cost of a single turn is determined by at least five things:

1. Whether the system prompt is byte-stable (prompt cache hit rate);
2. Whether the history has been unnecessarily rewritten (cache prefix break);
3. Whether compression is triggered, and which auxiliary model is used for compression;
4. Whether tool results are truncated/written to disk;
5. Whether provider fallback, credential rotation, and reasoning parameters cause additional calls.

Hermes writes "prompt cache is sacred" as a hard invariant because in multi-turn Agents, cache failures are often more expensive than calling a tool one extra time.

## 7. Key Terms

| Term | Meaning | Key Source Code |
| --- | --- | --- |
| Session | Cross-turn session ledger, with source, model, system_prompt, parent_session_id | `sessions` Table |
| Turn | One `run_conversation()`, with admission, lease, start/end | `turn_facade.py` |
| Admission | An input persistently accepted, queued according to `seq` | `session_admissions` |
| Lease | Cross-process "session key card," only one turn can hold the same session at a time | `session_turn_leases` |
| Transcript | Canonical message history, `messages` table | `hermes_state.py` |
| `api_content` | The actual byte copy of a message sent to the provider, used for cache-stable replay | `messages.api_content` |
| Compression | Lossy compression of history, can rotate child session | `context_compressor.py` |
| Toolset | Logical grouping of tools, can include other toolsets | `toolsets.py` |
| Profile | A set of independent `HERMES_HOME`, configurations, credentials, and plugins | `hermes_cli`/`pm` |
| GatewayAgent | Classic CLI-side AI Agent proxy, does not execute turns | `hermes_cli/gateway_agent.py` |

## 8. The Three-Pass Method for Reading Source Code

### First Pass: Only Follow One Line

```text
CLI/Message/TUI
  → prompt.submit
  → SessionAuthority
  → TurnRunner
  → AIAgent.run_conversation
  → TurnFacade lease
  → build_turn_context
  → conversation_loop
  → finalize_turn
  → SessionDB / Event / Reply
```

Do not open `chat_completion_helpers.py` on the first pass. It is large, but it is 'transmission details,' not the main storyline.

### Second Pass: Ask Three Ownership Questions

- Who is the factual source of this field? Memory, transcript, admission, or UI cache?
- Who is authorized to modify it? Client, host, agent, or some tool?
- After a failure, which record can prove 'how far it has progressed'?

### Third Pass: Conduct Minimal Experiments

- Print the admission receipt of `prompt.submit` once;
- Compare `api_content` before and after `build_api_messages()`;
- Manually trigger a compression and observe `parent_session_id` and `compression_locks`;
- Kill the process before the tool executes, restart, and see if the transcript retains the tool-call block;
- Make the provider return 429, observe retry, fallback, and preflight re-calculation.

## 9. One-Sentence Mental Model

> **Session is the ledger, Turn is the transaction, Admission is the queue number, Lease is the room key, Transcript is what has happened, Event is what is happening.**
>
> When reading Hermes, first ask 'who owns this matter,' then ask 'who can prove it happened after a failure.' Once these two questions are answered, the code structure becomes very clear.
