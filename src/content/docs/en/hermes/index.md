---
title: "Hermes Agent 0.22.5 Source Code Course · Introduction"
description: "Hermes Agent 0.22.5 source code course introduction: multiple frontends, hosts, a single Agent core, and a persistent session ledger."
---

:::note[Independent Study Notes]
These are independent study notes based on the [Hermes Agent](https://github.com/NousResearch/Hermes-Agent) version v0.22.5 release archive source code and publicly available documentation; this is not official documentation. This site does not include the upstream source code or archives; below, $HERMES_SRC refers to your own local source code directory.
:::

> Baseline: release archive `hermes-agent-0.22.5` (release version `v0.22.5`; `hermes_cli/__init__.py` records release date `2026.9.24`).
> The archive does not contain `.git`, therefore this article does not claim commits or git tags; all conclusions are based on the source code symbols, default configuration values, and directory structure of this release package.
> All paths in this article are relative to `$HERMES_SRC`.
> Older lecture notes are not included in this repository; this lesson only considers the v0.22.5 release archive, and conclusions from older versions are no longer used as a reference.
> Note: `version = "0.0.0"` in `pyproject.toml` is a build placeholder, not a release version.

## Understanding Hermes in One Sentence

**Hermes is a personal Agent platform with "multiple frontends, resident host, single Agent core, persistent session ledger": the client is only responsible for input and presentation, the Gateway/TUI backend handles sessions and execution, `AIAgent` completes a single Turn using a synchronous loop, and `SessionDB` stores the transcript, queued inputs, turn leases, compression locks, and cross-process recovery state uniformly in SQLite.**

Think of it as a 24-hour operational office:

```text
Classic CLI ──GatewayAgent──┐
Telegram / Discord / ... ─┤
TUI / Desktop ────────────┼──► host (Gateway or tui_gateway)
Dashboard / API ──────────┘        │
                                   ├─ SessionAuthority: Who can submit, queue, and receive
                                   ├─ TurnRunner: Organize a turn's context and callback
                                   ▼
                             AIAgent (the same core set)
                               TurnFacade → durable lease
                               conversation loop
                               provider / tools / compressor
                                   │
                                   ▼
                             SessionDB(WAL)
                               messages / admissions / leases / locks
                                   │
                                   ▼
                             Event Stream / Streaming Output / Channel Reply
```

The most important thing about this diagram is not 'how many entrances there are,' but that **entrances do not own execution**. An entrance merely converts a single input into an identified submission; the actual host executing a turn must hold the session, lease, and persistence responsibilities.

## Seven Major Tables

| Component | Question to Answer | Hermes' Answer | Key Source Code |
| --- | --- | --- | --- |
| Loop | How is a round progressed, and when does it stop? | Synchronous `conversation_loop`, each round goes through six stages: context, request, retry, response, tools, and wrap-up | `agent/conversation_loop.py`, `agent/turn_*.py` |
| Context | What does the model see this time, and what about window overflow? | Three layers of system prompts `api_content`; byte-stable replay; compress/rotate session | `agent/turn_context.py`, `agent/system_prompt.py`, `agent/context_compressor.py` |
| Tools | What can the model do, and how are results fed back? | Toolset filtering → schema generation → approval/guardrails → concurrent or serial execution → persistent results | `toolsets.py`, `model_tools.py`, `agent/tool_executor.py` |
| Model Access | How to unify multiple vendors, protocols, credentials? | Declarative `ProviderProfile`; transport branches; credential pool; fallback | `providers/base.py`, `agent/chat_completion_helpers.py`, `agent/credential_pool.py` |
| Extensions | How to grow capabilities beyond the core? | Plugin, skill, MCP, subagent, cron, kanban; core maintains narrow waist | `plugins/`, `skills/`, `cron/`, `tools/delegate_tool*` |
| Interface | How can humans, programs, and IMs use the same engine? | Classic CLI proxies to Gateway; TUI/Desktop share Python backend; Dashboard embeds real TUI | `hermes_cli/gateway_agent.py`, `tui_gateway/`, `apps/desktop/`, `web/` |
| Engineering | Why don't changes break the system? | Prompt cache invariants, profile scope, exact pin, behavior contract tests, health ratchet | `AGENTS.md`, `pyproject.toml`, `scripts/check`, `tests/AGENTS.md` |

Three vertical lines run through each block:

1. **Fact Ownership**: The transcript and admission reside in `SessionDB`; what's in memory `messages` is only the working copy for this round.
2. **Permission Boundaries**: What the client can submit, what the host can accept, and what the tools can modify are constrained by admission, lease, and approval/guardrails, respectively.
3. **Cost Boundaries**: Prompt cache, context compression, auxiliary models, credential pool, and fallback together determine the real cost of one turn.

## First, Remember Four Boundaries

### 1. Clients Do Not Own Agents

Classic CLI `_init_agent()` clearly treats `GatewayAgent` as a stand-in for `AIAgent`:

```python
from hermes_cli.gateway_agent import GatewayAgent as AIAgent  # the gateway runs the turn
```

The module comments for `GatewayAgent` are written more directly: **The CLI process does not build a real agent, does not run tools, and does not write `state.db`**. It only commits `prompt.submit`, then plays the Gateway's event stream on the calling thread, and finally concatenates a result dict in the same shape as `AIAgent.run_conversation()`. 

But this statement cannot be generalized to all frontends: 

- **Message Platform**: The Gateway process holds the real `AIAgent`, and the adapter delivers the message to the session authority. 
- **TUI / Desktop**: The shared Python `tui_gateway` backend can be built by itself `AIAgent`, or bind to session authority via canonical gateway transport. 
- **Dashboard**: Embed the real `hermes --tui` via PTY, not a separate chat UI. 

So the correct way to put it is: **"Execution belongs to the host, not to the rendering layer"**, not "all frontends run through the same Gateway process". 

### 2. Gateway is a session authority, not just a message forwarder

The module comment for `gateway/session_authority.py` makes it clear: it has "live sessions and canonical durable FIFO scheduling"; Only a runtime bootstrap with profile ownership can initialize it. A commit goes through principal authentication, session commit permissions, payload normalization, then writes to `session_admissions`, and drain retrieves it by pressing `seq`. 

This addresses multi-process reality: CLI, Desktop, Gateway, and background notifications may all want to operate on the same session at the same time. Relying solely on memory locks is not enough; a persistent cross-process queue is necessary. 

### 3. An agent is a synchronous turn, not a resident coroutine

`AIAgent` consists of a dozen mixins, `run_conversation()` first goes through `TurnFacadeMixin` to get durable leases, then enters `agent/conversation_loop.py` synchronous loops. There is no "background thinking thread" in the loop; Model calls, tool execution, compression, and persistence all advance along the same turn thread. Asynchronous only appears at the host layer (Gateway's asyncio, TUI's JSON-RPC, utility thread pool). 

### 4. The only way to change the context midway is compression

Root `AGENTS.md` lists **per-conversation prompt caching** as the highest invariant: no changing historical messages, no changing toolsets midway, no overloading of memory, no rebuilding of system prompts. The only exception is context compression. 

So you'll see many seemingly "looped" designs: sidecar, three-layer prompts, frozen workspace snapshots, and session rotation after compression. They all serve the same thing: **Keep the same history stable in every API call, unless the system explicitly decides to compress.** 

## Reading Order

| Order | Documentation | What will you get |
| --- | --- | --- |
| 0 | [Global Map](overview/) | Product positioning, process topology, four-layer responsibilities, table of contents, and terminology |
| 1 | [A Life of a Turn](turn-lifecycle/) | From input submission to lease, context, API, tools, finishing, and delivery—the complete main thread |
| 2 | [Core Mechanism](core-mechanisms/) | Loops, context, tools, models, persistence layers, extensions, and interfaces—seven key areas—dig deep |
| 3 | [Engineering Practice](engineering/) | Debugging path, source code experiments, failure matrix, extended recipes, and graduation exercises |

## Stage Course (Source Code In-Depth)

After the overview, proceed from stage 0 to stage 9 according to the [Stage Guide](learning-path/). `00`~`03` Responsible for establishing a global and mechanical intuition; The stage papers are broken down along the real source code for ownership, state migration, failure recovery, and observable experiments. Each self-test and exercise includes reference answers. 

## The Five Most Confusing Things

1. **`GatewayAgent` is not `AIAgent`**: The former is the CLI-side proxy responsible for committing and replaying events; the latter is the core of the actual turn run. 
2. **Session is not Turn**: A Session is a cross-round ledger; A Turn is an execution with admission, lease, start, and end. 
3. **Compression is not "message deletion"**: It preserves protected heads and tails, summarizes middle segments, handles orphan tool pairs, and can rotate new child sessions. 
4. **Memory / Skill is not the current context**: They affect the volatile layer of the next prompt; What you see in this round is the already assembled API copy. 
5. **Queue is not Steer**: `queue` is queued for the next round; `steer` is the tool boundary of the current turn injecting a user message, which differs in admission intent and delivery timing. 

## Learning Completion Standards

After reading, you should be able to answer without looking at the document:

- Why doesn't a classic CLI input run in the CLI process? Where does it ultimately become `AIAgent.run_conversation()`? 
- What do `queued / started / unknown / terminal` in `session_admissions` each mean? 
- What are the TTL, refresh intervals, and behavior after loss of durable turn lease? 
- What are the three layers of System Prompt, and why does the Workspace Snapshot freeze? 
- How do compression trigger thresholds, protected heads and tails, session rotations, and `compression_locks` work together? 
- Why must tool calls be persisted before execution? Why can't you "run first" when persistence fails? 
- Why must API fallback go back to preflight to recalculate the context instead of directly switching providers to continue? 
- Which layer do plugin, skill, MCP, subagent, cron, and kanban each extend on? 

### Reference Answers for Learning Completion Standards

1. **Because the classic CLI is only a rendering/committing agent.** Input is passed to `GatewayAgent.run_conversation()` via `HermesCLI.chat()`, which is then submitted to the Gateway via `connection.call("prompt.submit", ...)`; True admission, `TurnRunner`, durable lease, `AIAgent.run_conversation()`, models, and tools are all executed in the Gateway process. TUI/Desktop can be executed by its own host backend, but the principle remains "execution belongs to the host, not to the rendering layer." 
2. **`queued`** means persisted and not yet started; **`started`** means the worker has taken over execution; **`unknown`** means the commit/start boundary is uncertain and must readback/reconcile; **`terminal`** means there is a clear terminal state. Treat unknown as queued and execute repeatedly; when terminal abandons work or erroneously announces completion. 
3. durable lease: default TTL 300 seconds, wait limit 1800 seconds, normal refresh time about 60 seconds. **After the lease is lost, the current turn must be interrupted and transcript/final state writes stopped**, and the new owner takes over after the lease expires and reconciles; watchdog also needs to detect situations where "processes are alive but event loops, refresh coroutines, or DB blocks"; otherwise, the old owner may still be mistaken for valid within these 300 seconds. 
4. **Stable** Places identity, guidance, coding brief, and fixed skills guidance; **context** Places caller system message, project context file, and workspace snapshot; **volatile** Stores skills index, memory, profile, timestamp, and runtime hints. Workspace snapshot freezes by session so that multiple API calls in the same round won't rewrite prefixes due to CWD or file changes, which would damage prompt cache and dialogue byte stability. 
5. Default compression threshold is 0.50, protecting the first 3 entries and the last 20 entries, with a digest target of about 0.20 and tail mode set to lean; The small window may raise the threshold to about 0.75. Compression is done by `compression_locks` to ensure there is only one compressor per session; failure has a cooldown; When rewriting history, rotate out the child session and use `parent_session_id` to retain the original transcript to avoid overwriting the compression results in the old ledger. 
6. **Persist tool-call first, then execute side effects.** This way, after a crash, at least it can prove "what the turn intends to call this time." If the canonical append fails, Hermes will end the turn with `session_persistence_failed`, rather than running first and then replenishing: because when the ledger has no call records, it cannot prove whether side effects have occurred or return memory results as credible facts back to the model; This is especially dangerous for irreversible operations like deleting files. 
7. **Because the context window, token estimation, API mode, message shape, tool schema, and compression state after fallback may all differ.** Switching providers directly to continue sending will result in overflow windows, sending unsupported fields, leaving orphaned tool pairs, or corrupting cache prefixes; The correct approach is `restart_with_rebuilt_messages`, return to preflight to rebuild system prompt/wire copy, recalculate budget, and compile. 
8. **plugin** Extends in-process capability registration (provider/channel/tool/hook); **skill** Expands knowledge, processes, and resource packages; **MCP** Expands external tool protocols; **subagent** Expands controlled subtasks and concurrency; **cron** Extends durable scheduled scheduling; **kanban** Extends durable multi-agent queues. They differ by layer and cannot be replaced by "adding one more tool." 

> **In short: Hermes' core is not "making the model call tools multiple times," but turning a single Agent execution into an identity, lease, ledger, recoverable, and auditable Turn.**
