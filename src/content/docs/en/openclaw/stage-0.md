---
title: "Stage 0: Environment and Source Code Map"
description: "Stage 0: Environment and source code map. Follow the main line of the source code to understand facts, contracts, observable evidence, and failure recovery."
---

> Course: OpenClaw Source Code Class · Stage Roll  
> Prerequisite: None  
> Corresponding Overview: `overview.md`  
> Stage Objective: Establish maps for versions, directories, processes, and identities to avoid confusing channels, Gateways, Agents with transcripts.  

## 1. What this phase solves  

The OpenClaw repository is large with many entry points. If you read files from `src/` one by one, it's easy to remember scattered modules but not know where a message turns. This phase only builds four maps:

- Runtime environment and version baseline;  
- Process/responsibility topology;  
- Source code directory responsibilities;  
- Six core identities for a single Run.  

## 2. First remember one distinction  

**Channel is not Session, Gateway is not Agent, ACK is not Reply, Transcript is not Prompt.**  

These four distinctions can explain most of the later "why wrap an extra layer here" questions.  

## 3. Main source code line  

1. `package.json` declares `2026.10.9`, Node version, and `pnpm@12.15.0`;  
2. `packages/agent-core/src/agent-loop.ts` is the shared core of model/tool loops;  
3. `src/gateway/` handles RPC, authentication, Session/Run admission, events, and control methods;  
4. `src/auto-reply/` normalizes inbound channels into dispatch and ReplyDispatcher processes;  
5. `src/agents/` contains embedded runner, session, tool, harness, subagent, and transcript;  
6. `src/plugins/`, `src/mcp/`, `src/skills/` provide extension points; `ui/src/` and `src/tui/` are frontend;  
7. `src/state/` stores SQLite schema, migrations, leases, snapshots, and runtime state.  

## 4. Key objects and contracts  

### Directory responsibilities  

| Path | Main Responsibility | Should Not Be Confused With |  
| --- | --- | --- |  
| `src/gateway/` | RPC, routing, admission, events, permissions | Do not perform model loops |  
| `src/auto-reply/` | Channel context, dispatch, reply distribution | Does not own transcript |  
| `packages/agent-core/` | Reusable loop/compaction core | Does not own Gateway routing |  
| `src/agents/` | Embedded runner, tools, harness, session, transcript | Not purely UI layer |  
| `src/plugins/` | Native capability, hook, provider/channel registration | Not external MCP server |  
| `src/mcp/` | External tool protocol and runtime | Tools still go through policy/approval |  
| `src/state/` | Database, migrations, snapshot, lease | Not model context |  
| `ui/`, `src/tui/` | Control UI/WebChat/TUI | Not a second set of Agents |  

### Six core identities  

| Identity | Answers What | Lifecycle |  
| --- | --- | --- |  
| `clientRunId` | What is the idempotency key for this client request | Can span retries |  
| `sessionKey` | Which segment of the conversation the message should land in | Long-term routing |  
| `sessionId` | Which segment is currently persisted | Can change due to overwrite/branching |  
| `runId` | Which execution this is | Single Run |  
| `writerRunId` | Who currently has transcript write permission | Changes when taken over |  
| `transcript entry` | Which one in the committed history | Persistent |  

These identities cannot replace each other. Especially `sessionKey` is not equal to `sessionId`, `runId` is not equal to `clientRunId`.  

## 5. An observable chain

```text
External entrance
  → Gateway or auto-reply normalize
  → sessionKey Routing
  → sessionId bind
  → admission + runId
  → lane / writer fence
  → embedded runner
  → agent loop
  → transcript
  → reply
```

## 6. Experiment

### Experiment A: Checking Version and Toolchain

```powershell
node --version
pnpm --version
rg -n '"version"|"engines"|"packageManager"' package.json
```

Reference Acceptance: Node satisfies `>=24.22.1 <25 || >=26.12.1`, pnpm is `12.15.0`, version is `2026.10.9`; do not guess the commit from the archive.

### Experiment B: Find Shared Loops

```powershell
rg -n "export async function runAgentLoop|function runLoop|executeToolCallGroups" packages\agent-core\src\agent-loop.ts
```

Reference Acceptance: Able to point out the shared loop entry, the inner and outer layer continuation conditions, and the tool batch execution points.

### Experiment C: Draw Identity Map

Find one identity binding each from `chat-send-handler.ts`, `chat-send-admission.ts`, and `embedded-agent-runner/run/session-bootstrap.ts`. Reference acceptance: Able to write out the different stages of `clientRunId → runId` and `sessionKey → sessionId`.

### Experiment Reference Answers

1. The version should be `2026.10.9`, with Node/pnpm meeting the toolchain constraints of `package.json`; if the archive has no Git identity, commits cannot be made.
2. Should locate `runAgentLoop`, the inner and outer layer continuation conditions, and `executeToolCallGroups`, and be able to explain that the shared loop does not replicate due to different channels.
3. `clientRunId` maps to `runId` during the admission/deduplication stage; `sessionKey` is parsed as `sessionId` during the bootstrap/run stage. The two layers of identity cannot be mixed.

## 7. Failures and Recovery

| Misconception | Consequence | Fix |
| --- | --- | --- |
| Treating channel as session | The same conversation breaks across channels | Use Gateway to route identity |
| Treating Gateway as Agent | Model loops at wrong layer | Go into `src/agents` and agent-core |
| Treating ACK as completion | Line-breaking retries duplicate execution | Use run events/terminal state recovery |
| Treating transcript as prompt | Think pruning changes history | Distinguish canonical from projection |
| Guessing git version from archive | Version conclusions are not reproducible | Only reference released package version |

## 8. Self-Test for Clearance

1. What are the responsibility boundaries of Gateway and Agent Harness?
2. What problems do `sessionKey`, `sessionId`, `runId`, `clientRunId` each solve?
3. Why is `packages/agent-core` suitable as a shared loop?
4. Is `src/state` the same as if transcript were two sets of facts?
5. Why can't archived courses fabricate commits?

### Reference Answers

1. Gateway is responsible for entry, authentication, routing, admission, events, and lifecycle; Agent Harness is responsible for models, tools, context, and loops. Gateway does not 'think' directly, and Harness does not have global routing.
2. `sessionKey` locates logical conversations, `sessionId` identifies persistent records, `runId` identifies a single execution, `clientRunId` supports client retry idempotency. The four have different lifecycles and uses.
3. It decouples and makes the model flow, tool batches, steering, follow-up, and compaction reusable cores with the entry. Both built-in and plugin harnesses can share the same execution semantics.
4. No. `src/state` stores running facts like databases, snapshots, leases, and migrations; transcript is part of session history facts, and the prompt is the projection generated from transcript and context rules for the current round.
5. The archive does not have `.git`, so commits/tags cannot be verified. Trusted conclusions can only come from released package `package.json`, source symbols, and directories; fabricated versions destroy reproducibility.

## 9. Source Coordinates

- `package.json`
- `packages/agent-core/src/agent-loop.ts`
- `src/gateway/server-methods/chat-send-handler.ts`
- `src/gateway/server-methods/chat-send-admission.ts`
- `src/auto-reply/dispatch.ts`
- `src/agents/embedded-agent-runner/run/session-bootstrap.ts`
- `src/agents/embedded-agent-runner/runs.ts`
- `src/state/`

## 10. Next Steps

Enter Stage 1: How a `chat.send` is accepted, bound to a session, executed serially, and obtains transcript write permissions.
