---
title: "00 · Global Map"
description: "Establish a global map of OpenClaw 2026.10.9 from the perspectives of processes, sessions, and source code."
---

> Goal: First answer "What exactly is OpenClaw, what permanent components does it consist of, where do messages enter, and who owns the state?" 
> Baseline: `openclaw-2026.10.9`. In the following text, when the terms "Gateway / Agent / Session / Run / Channel / Harness" are used, their meanings are as defined here.

## 1. One-sentence Understanding

**OpenClaw is not "a model client," but a long-term online personal Agent gateway: it continuously maintains multiple message channels, multiple devices, and multiple frontend connections, routes each input to a particular Session of a certain Agent, then accepts it as a bounded Run and hands it to a replaceable Agent Harness for execution.**

Its key design choice is "**centralized ownership, edge adaptation**":

- Central: the Gateway owns connections, sessions, routing, idempotency, events, approvals, and lifecycle.
- Edge: Channel, Provider, Sandbox, CLI backend, MCP server, and Skill all connect as contract-based capabilities.
- Execution: the built-in `openclaw` harness is the default Agent Loop; plugin harnesses (e.g., `codex`) or CLI backends can also be chosen.

## 2. System Topology

```text
┌────────────────────── External World ──────────────────────┐
│ Telegram  Slack  Discord  WhatsApp  Signal  iMessage │
│ WebChat TUI mobile CLI Node device Cron/Webhook │
└──────────────────────────┬───────────────────────────┘
                           │ Channel Adaptation / WS RPC / CLI
┌──────────────────────────▼───────────────────────────┐
│                     Gateway Process                     │
│ Authentication · Device Pairing · Routing · Session/Run admission      │
│  HTTP/WS · Control UI Static Resources · Events · Approvals · Cron   │
└──────────────────────────┬───────────────────────────┘
                           Unified ingress
┌──────────────────────────▼───────────────────────────┐
│                 Agent Executive Level                         │
│  agentCommand → embedded runner → harness selection  │
│  session writer · lanes · fallback · abort/recovery   │
└───────────────┬──────────────────────┬───────────────┘
                │                      │
       ┌────────▼────────┐    ┌────────▼────────┐
       │  Agent Loop     │    │  Tool runtime   │
       │ model ↔ tools   │    │ policy/approval │
       │ steering/stop   │    │ sandbox/MCP     │
       └────────┬────────┘    └────────┬────────┘
                │                      │
       ┌────────▼──────────────────────▼────────┐
       │ transcript / session store / events    │
       │ SQLite state · workspace bootstrap     │
       └────────────────┬───────────────────────┘
                        │
                 ReplyDispatcher
                        │
              Original Channel / WebChat / TUI
```

The most important point in this diagram is: **Gateway and Agent Loop are two different levels**. Gateways can accept, queue, cancel, and forward events, but they are not responsible for "whether the model wants to deploy tools next"; Agent Loops handle loops but do not have channel connections. 

## 3. Core Audience

| Object | What does it have | Don't get confused |
| --- | --- | --- |
| Gateway | Process lifecycle, connection, authentication, session routing, RPC, events, approval transmission | Not Agent Loop |
| Channel | Account on a certain messaging platform, send/receive adaptation, group/thread semantics | Not Session |
| Agent | Configure identity, workspace, model/tool policies, personality, and bootstrap | Not a one-time execution |
| Session | Long-term session identity and transcript ownership | Not a single run |
| Run | An accepted execution with runId, abort, final state, and event | Not a Session |
| Transcript | Session fact ledger; writer can add/rewrite | Not a prompt projection |
| Harness | Runtime contract for executing a model-tool loop | Not a Provider |
| Node | Remote capability devices managed by Gateway also use the same WS protocol | Not ordinary web clients |
| Plugin | Registrars with in-process capabilities can have channel/provider/tool/hook | Not MCP Server |
| MCP Server | External tools/resources/prompts protocol side | Do not bypass tool policies |

### 3.1 Session and Run

- **Session is "which conversation"**. It is determined by the source routing: DM, group, room, Cron, and Webhook have different default policies; `chat.send` will explicitly include `sessionKey`. 
- **Run means "execute this time"**. The same session can have many runs; The same session is serial by default, preventing two writers from changing history at the same time. 
- **Run termination does not mean session ends**. Subagent is also a model where "child run ends, but session can be retained." 

### 3.2 Gateway is the owner of the session facts

`docs/concepts/session.md` The source code is consistent with the documentation: the UI client queries Gateway session data. Control UI, TUI, and mobile do not each maintain a separate "main session," but instead read and write the same session view through the Gateway RPC. 

This leads to two outcomes: 

1. Channel switching does not naturally lose context, as long as the router is routed to the same session. 
2. Multiple clients see the same chain of facts, but their UI caches, drafts, and unsent states may still differ. 

## IV. Catalog Responsibilities

| Table of Contents | Main Responsibilities | Typical Entry |
| --- | --- | --- |
| `src/gateway/` | HTTP/WS Services, Handshakes, RPC, Session/Run admission, Events, Approvals, Control UI Hosting | `server.ts`, `server/connection.ts`, `server-methods/chat*.ts` |
| `src/auto-reply/` | Final context after channel inbound, group/thread offloading, replying to dispatcher | `dispatch.ts` |
| `src/agents/` | Agent command, embedded runner, tools, model, harness, session, subagent, sandbox | `agent-command.ts`, `embedded-agent-runner/` |
| `packages/agent-core/` | Agent Loop, Messages, Compaction, and Harness Contracts Decoupled from Products | `agent-loop.ts`, `agent.ts` |
| `src/plugins/` | Native plugin loading, capability registration, hook, runtime | `runtime/`, `loader-*.ts` |
| `src/mcp/` | OpenClaw provides MCP and some MCP runtime entry points externally | `tools-stdio-server.ts`, `channel-server.ts` |
| `src/skills/` | Skill Discovery, Loading, Prompt Directory, Resources, and Lifecycle | `loading/`, `runtime/` |
| `src/tui/`, `ui/src/` | Terminal UI and Browser Control UI | `tui.ts`, `main.ts`, `app-routes.ts` |
| `src/state/` | SQLite State Library Contracts, Startup, Migration, and Schema Versions | `openclaw-state-db-contract.ts` |
| `src/config/` | Configuring schema, session store, types, and runtime configuration | `sessions/`, `zod-schema.*` |
| `scripts/` | Check, build, release, and test orchestration | `check.mts`, `build-all.mts` |

## 5. Where exactly is the state of being?

OpenClaw doesn't cram everything into one JSON file. It has at least three types of states:

| Status | Function | Key Points |
| --- | --- | --- |
| Gateway global state | Connections, devices, configuration publishing, plugin/skill snapshots, etc. | `src/state/openclaw-state-db-contract.ts` defines schema version `20` |
| Agent/Session state | Session metadata, transcript, run-related facts | `src/state/openclaw-agent-db-contract.ts` defines schema version `25` |
| Workspace files | `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, etc., bootstrap and skills | Read per round according to budget, not inserted into prompt without limit |

In addition, there is the **running memory state**: abort controller, session lanes, dedupe cache, WebSocket connections, event subscriptions. These are not caches that are "okay if they can be rebuilt": dedupe and writer fence directly determine concurrency correctness.

## 6. High-level path of a single input

```text
Channel/Client
  Authentication and Routing
  → SessionKey
  → Run admission (plagiarism check, queuing, cancellation/takeover)
  → Agent command / embedded runner
  → system prompt + transcript + tools
  → Agent Loop (Model/Tool Turn)
  → transcript commit + terminal outcome
  → ReplyDispatcher
  → Original Channel or UI Event
```

Two common entry points:

- **Channel Entry**: `dispatchInboundMessage()` first `finalizeInboundContext()`, then go through `dispatchReplyFromConfig()`.
- **Web/Application Entry**: Gateway RPC `chat.send`, with `src/gateway/server-methods/chat-send-*.ts` responsible for parameter validation, idempotency, session admission, and agent dispatch.

They ultimately all fall to `agentCommandFromIngress()` / `runEmbeddedAgent()` side; the main differences lie in "who provides the input context" and "who consumes the response".

## 7. Trust Boundaries

OpenClaw's default security model is not "do whatever the model says", but rather multi-layered boundaries:

1. **Transport Boundary**: Gateway WS first frame must `connect`; device signature, nonce, scope, and pairing approval are required.
2. **Caller Boundary**: Operator and ordinary channel sender permissions differ; some tools are only open to the owner.
3. **Tool Boundary**: Tool assembly first goes through capability/profile, workspace/sandbox policy, and final authorization.
4. **Execution Boundary**: The loop admission, trusted policy, approval, hook, final owner approval sequence of `before_tool_call` is fixed.
5. **Write Boundary**: Only one active writer per session; a new writer taking over will cause the old run to terminate with `superseded`.
6. **Extension Boundary**: Native plugins are equivalent to in-process code; MCP is an external process/service but still follows tool policy.

## 8. Three Design Principles

The project root `AGENTS.md` writes priorities very directly; these three are more worth remembering than the directory structure:

### 8.1 One owner per responsibility

A responsibility can only have one owner who "makes decisions/changes authoritative state". Adapters only translate contracts; caches/projections are derived only from the owner. Therefore:

- Session routing belongs to Gateway;
- Transcript writing belongs to the current writer;
- Provider semantics belong to provider capability;
- Tool pass-through belongs to the policy/approval chain.

### 8.2 Small core, capable plugins

Adding a new "model-visible tool" to the core increases long-term context costs. Optional capabilities should be placed on the edge; the core provides general contracts. New integration itself does not justify adding another core tool/manager.

### 8.3 Stable conversation context

Reconstructing past context breaks prompt-prefix reuse. Generated prompt/tool/context additions must be **bounded, deterministic, and stable**; only compaction can rewrite history. The refresh of skills/tools/memory must follow a clear invalidation contract.

## 9. Global Map Self-Test

Answer without looking at documentation:

1. What do Gateway, Agent, Session, Run, and Harness each own?
2. Why can Control UI and Telegram share a session but not share "connection identity"?
3. Which two types of persistent state are managed by schema 20 and schema 25 respectively?
4. Why is "handing channel messages directly to the model" a misconception?
5. What degradations do the three design priorities of `AGENTS.md` prevent?

Exercise: Draw a diagram with only five boxes, place `chat.send`, `dispatchInboundMessage`, `runEmbeddedAgent`, `runAgentLoop`, `ReplyDispatcher` in the correct layers, and indicate "who owns Session".

---

### Self-Test Reference Answers

1. **Gateway** has process lifecycle, connection/authentication, routing from channels to sessions, RPC, events, approval transmission, and recovery entry; **Agent** has configuration for identity, workspace, model/tool policies, and persona; **Session** has long-term session identity and ownership of the transcript; **Run** is an accepted execution, having runId, abort, terminal state, and events; **Harness** is a runtime contract/adapter that executes the model–tool loop, not the model provider itself.
2. Both can land in the same Session through the same `sessionKey` because Session represents "which conversation segment"; but connection identity includes transport, device, role/scope, pairing, and approval capability. Telegram connections cannot prove identity to Control UI devices, nor can they share its operator scope.
3. **Schema 20** manages Gateway global state: connections, devices, configuration publishing, plugin/skill snapshots, etc.; **Schema 25** manages Agent/Session state: session metadata, transcript, run-related facts, and indexes.
4. Channel messages must first `finalizeInboundContext`, determine group/thread, establish session/run admission, select writer, assemble prompt/tools, and go through policy/approval. Sending directly to the model bypasses identity, deduplication, lane, writer fence, approval, and reply routing.
5. **One owner per responsibility** prevents "double-writers/second factual sources"; **Small core, capable plugins** prevents unlimited bloating of core tools and context; **Stable conversation context** prevents the invalidation of prefix cache and context misinterpretation caused by prompt reshuffling in each turn.

### Exercise Reference Diagram

```text
Channel: dispatchInboundMessage → finalize → group/thread branch → agent command ┐
                                                                       ├→ runEmbeddedAgent → runAgentLoop
Gateway:chat.send → admission/ACK → detached dispatch → agent command ┘

Session Owner: Gateway/session store (writer only has the right to append transcripts)
Output owner: ReplyDispatcher (channel) / Gateway event stream (UI)
```

Acceptance points: Two entrances converge at the unified agent command/embedded runner; Session still belongs to Gateway; `ReplyDispatcher` is on the output side, not inside the loop; `chat.send` return only indicates it has been accepted.

*OpenClaw 2026.10.9 · Global Map*
