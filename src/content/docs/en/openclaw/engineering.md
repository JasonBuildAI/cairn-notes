---
title: "OpenClaw 2026.10.9 Source Code Class · 03 Engineering Practice"
description: "Complete engineering practice using debug paths, source code experiments, failure matrices, and extended exercises."
---

> Baseline: `openclaw-2026.10.9`. Path relative to `$OPENCLAW_SRC`.
> This article applies the mechanisms from the first two articles to "how to run, how to check, how to modify, how to prove nothing is broken."

## Summary in one sentence

The engineering difficulty of OpenClaw is not "lots of code," but the simultaneous existence of **long lifecycle, multiple entry points, and recoverable execution**. Therefore, the focus of its engineering system is not coverage numbers, but:

- Whether the state contract is unique;
- Whether concurrency/takeover is provable;
- Whether protocol frames are covered;
- Whether the database schema is migratable;
- Whether cross-platform paths/processes are reliable;
- Whether changes maintain the architectural boundaries.

## 1. Baseline Confirmation

First, make sure you are reading the correct version:

```powershell
cd $OPENCLAW_SRC
node -e "const p=require('./package.json');console.log(p.version,p.packageManager,p.engines.node)"
```

It should be noted:

```text
2026.10.9 pnpm@12.15.0+sha512... >=24.22.1 <25 || >=26.12.1
```

Other baseline facts:

- bin: `openclaw` → `openclaw.mjs`;
- Gateway default port: `18789`;
- Gateway state schema: `20` (`src/state/openclaw-state-db-contract.ts:23`);
- Agent DB schema: `25` (`src/state/openclaw-agent-db-contract.ts:9`).

Note: This is a release archive and does not include `.git`. Do not fabricate commit/tag; when referencing versions, use `2026.10.9`.

## 2. Setting up the local runtime environment

### 2.1 Installing dependencies

```powershell
cd $OPENCLAW_SRC
pnpm install
```

If you only want to read the source code, it is also recommended to at least install it to the point where you can run type checks/unit tests, otherwise many path aliases and generated files cannot be fully seen.

### 2.2 Build

```powershell
pnpm build
```

Entry point: `scripts/build-all.mts`.

### 2.3 Starting the Gateway

Specific CLI subcommands are based on `openclaw --help`; the source code level entry points are:

- `src/gateway/server.ts:24 startGatewayServer()`
- `src/gateway/server-start.ts startGatewayServerCore()`

When starting, it will:

1. Initialize the SQLite runtime;
2. Validate/prepare the state/agent DB schema;
3. Acquire the gateway lock;
4. Open HTTP/WS listeners.

### 2.4 Three observation perspectives

| Perspective | What to look at |
| --- | --- |
| Gateway logs | Request acceptance, authentication, dispatch, errors |
| Event stream | `agent_start`, `turn_start`, tool events, `agent_end` |
| Persistent state | session rows, transcript, terminal outcome, schema version |

Do not focus only on logs. Many issues in OpenClaw can only be pinpointed by looking at "event + persistent state" together.

## 3. Debugging a message: start from the ID

### 3.1 First lock `runId`

`chat.send`'s `clientRunId` usually directly becomes `runId`.

First confirm:

- Whether the client reused the same `clientRunId`;
- Whether the server returned `in_flight`;
- Whether the `chat:${clientRunId}` deduplication was hit.

Relevant source code:

- `src/gateway/server-methods/chat-send-admission.ts:75`
- `:442` writes dedupe
- `:458` / `:489` returns `in_flight`

### 3.2 Then lock the session

Look at:

- `sessionKey`: routing identity;
- `sessionId`: persistent record identity;
- `activeWriterRunId`: current writer.

If "both runs think they should write," first check the writer claim:

```powershell
rg -n "claimAgentSessionWriter|activeWriterRunId|superseded" src/agents
```

### 3.3 Next, look at the model and harness

Find in logs/events: 

- Selected provider/model; 
- auth profile; 
- fallback step; 
- harness id(`openclaw` / `codex` / CLI backend).  

Source Code: 

- `src/agents/embedded-agent-runner/model.ts:84`
- `src/agents/model-fallback-candidates.ts:155`
- `src/agents/embedded-agent-runner/run/failover-policy.ts:115`
- `src/agents/harness/selection.ts:77`

### 3.4 Looking at the loop again

If the model has returned but the task is not finished: 

- Is there a tool call that hasn't been executed? 
- Are you waiting for approval? 
- Is there pending/follow-up? 
- Is `prepareNextTurn().stop` not triggered? 

Source Code: 

- `packages/agent-core/src/agent-loop.ts:215-457`
- `src/agents/agent-tools.before-tool-call.policy.ts`

### 3.5 Finally, check the settlement

If the agent is closed but the user does not see the reply: 

- Is the terminal outcome recorded? 
- Is the reply dispatcher settled? 
- Did channel sending fail? 

Source Code: 

- `src/auto-reply/reply/agent-runner-execution-outcome.ts:96`
- `src/auto-reply/dispatch.ts:273`

## 4. Source code experiments

All these experiments can be conducted locally, and it is recommended to record each "expected / actual/conclusion." 

### 4.1 Concurrent Session

Objective: Observe the writer's fence. 

Method: 

1. Use the same sessionKey twice to send `chat.send` but use different `clientRunId`; 
2. Observe whether the second pipe is taken over; 
3. Check `activeWriterRunId` and `superseded`. 

Expectations: 

- Serial in the same session lane; 
- New writer claim successful; 
- Old run terminates with `superseded`; 
- Transcript does not interleave. 

### 4.2 Repeating the same clientRunId

Method: Send the same `clientRunId` twice in a row. 

Expectations: 

- No new runs are generated the second time; 
- Returns `in_flight` or an existing result; 
- Only one transcript. 

### 4.3 Triggering Steering

Method: 

1. Have the agent execute a time-consuming tool; 
2. Sending steering before the tool finishes; 
3. Observe which checkpoint it takes effect. 

Expectations: 

- Started tools to continue completion; 
- The tool was not started due to skipped/synthetic error; 
- The next prompt includes steering; 
- Tool call/result is still paired. 

### 4.4 Failed to construct provider

Approach: Configure an unavailable fallback chain, or let the main model return an error. 

Observation: 

- `rotate_profile` or `fallback_model`; 
- Whether the failed candidate leaves half a transcript; 
- Whether the final session is advanced only once. 

Source Code: 

- `src/agents/embedded-agent-runner/run-entry.ts:161`
- `src/agents/embedded-agent-runner/run/failover-policy.ts:115`

### 4.5 Four Modes of Tool Approval

Method: Configure each plugin tool that needs approval: 

- `request`
- `defer`
- `report`
- `deny`

Observation: 

- Whether it is blocked; 
- Who receives the approval request; 
- Whether non-interactive surfaces are directly deny; 
- After refusal, the model sees what text it sees. 

Source Code: 

- `src/agents/agent-tools.before-tool-call.approval.ts:470`

### 4.6 compaction vs pruning

Method: 

1. Manufacture long transcripts; 
2. Trigger compaction, record the summary and keep the tail; 
3. Wait for the tool result to exceed TTL and observe pruning. 

Expectations: 

- compaction: Rewrite transcript; 
- Pruning: Only change the next prompt projection; 
- After rebooting, the pruning projection can be reconstructed from the original. 

Source Code: 

- `packages/agent-core/src/harness/compaction/compaction.ts`
- `src/agents/embedded-agent-runner/tool-result-truncation.ts:172`

### 4.7 MCP server is unreachable

Method: 

1. Configure a stdio MCP server; 
2. First, successfully list the tools; 
3. Stop the server; 
4. Send another round. 

Expectations:

- The tool directory may still be retained;  
- Execution reports as unavailable;  
- Recovery backs off from 30s → 10min;  
- Successful connection or explicit reload clears the backoff.  

Reference: `docs/tools/mcp.md`.

### 4.8 Sub-agent Lifecycle

Procedure:

1. Have the main agent spawn a sub-agent;  
2. Observe the child session key;  
3. End the parent run;  
4. Check whether the child session still exists.  

Expectation:

- The child is an independent session/run;  
- By default, no session/message management tools;  
- Has depth policy;  
- Supports announce and recovery.  

Source code: `src/agents/subagents/`.

## 5. Engineering Levels

### 5.1 Main Checks

```powershell
pnpm check
```

Entry: `scripts/check.mts`.

It aggregates a large number of preflights and checks, including (depending on the actual content of the script):

- conflict markers;
- script erasability;
- line-cap / max-lines ratchet;
- SQLite worker ratchet;
- assertion safety;
- test timeout race;
- mock export ratchet;
- changelog attribution;
- database-first legacy guard;
- doctor deprecation registry;
- wildcard re-export guards;
- media download helper;
- runtime sidecar loader;
- tool display;
- native catalog;
- opengrep metadata;
- duplicate scan coverage;
- npm lock/package patch.

### 5.2 Architecture Checks

```powershell
pnpm check:architecture
```

Includes:

- import cycles;
- madge cycles;
- deprecated API usage;
- wrapper shadowing;
- deprecated JSDoc;
- Kysely checks;
- database-first legacy stores.

These checks are not meant to prevent "syntax errors," but rather **architectural degradation**: for example, bypassing database ownership, reintroducing old stores, forming circular dependencies.

### 5.3 Protocol Override

```powershell
pnpm check:protocol-coverage
```

Entry: `scripts/check-protocol-event-coverage.mjs`.

It ensures that newly added/modified Gateway events are covered at the protocol level, preventing situations where "the server sends it, but the client schema doesn't know about it."

### 5.4 Documentation/Configuration schema

```powershell
pnpm check:docs
pnpm check:base-config-schema
```

Document inspection includes MDX, links, i18n glossary, configuration examples, etc.

### 5.5 Types and Testing

```powershell
pnpm check:test-types
pnpm test:unit:fast
pnpm test:changed
```

`test:changed` Using `origin/main` as the baseline, suitable for local iteration; CI will run a more complete project matrix.

### 5.6 Windows

```powershell
pnpm test:windows:ci
```

OpenClaw has specialized tests for Windows paths, processes, schtasks, and file locks. Do not assume 'passing on Linux is enough.'

### 5.7 Build

```powershell
pnpm build
pnpm build:strict-smoke
```

Build is not just about packaging; It also verifies CLI startup, plugin SDK, runtime postbuild, and more. 

## 6. Failure matrix

| Symptoms | First, check | Common root causes |
| --- | --- | --- |
| Request Repeated Execution | `clientRunId` / dedupe | Each time, the client generates a new ID |
| Old run is still being written | `activeWriterRunId` | writer fence not activated / bypassed |
| New run keeps lining up | session lane | The previous run did not release lane |
| Model not switching | Candidate chain/authentication | Fallback not configured or all profiles invalid |
| Tool Calls Suspended | `completeUnstartedToolCall` | The steering/abort path did not generate result |
| Approvals never return | Surface capability | Non-interactive channels cannot request approval |
| Context suddenly shortened | compaction | Abstract cut point prematurely |
| Tool Results "Disappear" | pruning | Only changed the projector, not the disk loss |
| Gateway Startup Failure | lock/schema | Another instance holds lock or migration fails |
| Event disorder/missing | `seq` | The client did not process the gap |
| UI Reconnection Status Error | `stateVersion` | Snapshot and increment misaligned |
| Windows-specific failures | Path/process testing | Case differences, locks, schtasks, spawn differences |

## 7. Modify exercises

### Exercise A: Add a read-only tool

Goal: Understand tool assembly and contextual cost. 

Requirements: 

1. Add a read-only tool outside of Core Tools; 
2. Let it go through the tool profile; 
3. Write a schema for it; 
4. Confirm that it appears in the system prompt and request schema; 
5. Explain how much context cost it adds. 

### Exercise B: Add a new channel capability

Goal: Unified understanding into the entry point. 

Requirements: 

1. Use `api.registerChannel()` to register a minimal channel; 
2. Translate inbound messages into a unified context; 
3. Reuse `dispatchInboundMessage()`; 
4. Do not modify the core routing branch of the Gateway. 

### Exercise C: Taking over and adding diagnostics to the writer

Goal: Understand ownership. 

Requirements: 

1. Add structured logs to writer claim success/failure; 
2. Record the old `activeWriterRunId`, new runId, and sessionKey; 
3. Do not change behavior, only increase observability; 
4. Write a test covering "old writer supersede". 

### Exercise D: Verify pruning without changing transcript

Goal: Understand projection and history. 

Requirements: 

1. Construct an expired tool result; 
2. Trigger cache-TTL pruning; 
3. Compare prompt projection with disk transcript; 
4. After restarting, verify that the projection can be rebuilt. 

### Practice E:MCP Failure Recovery

Goal: To understand the external capability lifecycle. 

Requirements: 

1. Causing the MCP server to fail to start; 
2. Observe and withdraw; 
3. Restore the server; 
4. Confirm the tool directory and restore execution capability; 
5. Explain why "Catalog Retention" is not the same as "Execute Release." 

### Modify the reference answers and acceptance points for the exercises

**Exercise A (Read-Only Tool)** 

Reference practice: place it at the edge of the plugin/tool profile, not core tools; declare strict input schema and read-only permissions; confirm after assembly that it is controlled by profile/authorization; estimate the additional token/character cost of entering system prompt text and request JSON schema; cover successful tests, rejections, parameter violations, oversized outputs, and profiles not enabled. The acceptance point is that core prompts do not permanently inflate due to optional capabilities; tools still follow unified policy/approval. 

**Exercise B (Channel Capability)** 

Reference method: Register the platform using `api.registerChannel()`. The adapter only translates inbound messages into a unified `MsgContext` (identity, sessionKey, reply target, attachment), then reuses `dispatchInboundMessage()`. Do not change the Gateway core routing, Agent Loop, session ownership, or tool policies. The acceptance point is that the semantics, powers, approvals, and reply delivery of the same session are consistent with other channels. 

**Exercise C (writer Takeover Diagnosis)** 

Reference method: Record structured fields at claim success/failure: `sessionKey`, old `activeWriterRunId`, new `runId`, CAS result, generation/sessionId, failure reason; Only add logs without changing behavior. Tests must override the old writer received `superseded` after supersede, and transcripts cannot be written again. The acceptance point is to restore "who gained ownership and when" from the logs. 

**Exercise D (Pruning Transcript)**

Reference approach: Construct a tool result that exceeds the TTL to trigger cache-TTL pruning; save the prompt projection of this request while reading the original transcript from disk; restart the runtime and then construct the request again to confirm that the projection can still be reconstructed from the original. The acceptance criteria are that the transcript bytes remain unchanged, only the projection shows a placeholder, and the tool result has not been deleted from storage.

**Practice E (MCP Failure Recovery)**

Reference approach: Let the server fail to start, observe whether the directory metadata is retained, whether execution is unavailable, and whether the backoff grows from about 30 seconds to 10 minutes; after recovering the server, verify that the directory and execution are restored simultaneously. The acceptance point is that 'directory retention' only indicates discoverability, not execution clearance; each call still needs to pass policy/approval and live connection checks.

## 8. Graduation Self-Assessment

Answer without looking at the documentation:

1. What are `pnpm check` and `pnpm check:architecture` each defending against?
2. Why do protocol events require a separate coverage check?
3. Why can't Windows tests be replaced by Linux CI?
4. If a change involves Gateway methods, session schema, and UI at the same time, in what order should it be verified?
5. What are the failure modes of the writer fence? How can each be observed?
6. What should the tests for compaction and pruning respectively assert?
7. Why can't plugin changes be tested with only unit tests?
8. If you want to add a new model provider, what layers need to be involved?
9. If you were to add a new channel, which code should not be changed?
10. How do you prove that "this modification did not compromise the stability of the prompt prefix"?

---

### Graduation Self-Test Reference Answers

1. `pnpm check` is a broad preflight/quality gate, preventing regressions such as conflict markers, line count limits, assertion/test race conditions, legacy mocks, lock files, etc.; `pnpm check:architecture` prevents architectural degradation, such as import cycles, old APIs, old stores, and bypassing database ownership.
2. Just because the server can send events doesn't mean the client protocol knows how to parse them. Protocol coverage checks ensure that newly added or modified events come with the schema, client handling, and testing, preventing situations where "events are sent online but silently discarded by the UI."
3. Windows has independent case-sensitive path semantics, file locks, process/spawn, schtasks, and shell differences; Linux CI cannot verify these platform behaviors and cannot replace Windows-specific tests.
4. Recommended order: First modify the contract/schema and database migration (database-first), then change the Gateway method and protocol coverage, followed by session/run states and writer behavior, and finally connect the UI/client to run protocol, integration, Windows, and build checks. At each step, first ensure compatibility with old data/old clients.
5. Writer fence failure modes: CAS conflicts, old writer not superseded, sessionId has changed, generation expired, duplicate claim after recovery, crash leaving a stale owner. Observe `activeWriterRunId`, CAS results, `superseded` events, lane queueing, and generation/session versions.
6. Compaction tests assert that the transcript structure changes, summary/cut points, recent messages are retained, and the tail is retained upon failure; pruning tests assert that the prompt projection is replaced, the transcript remains unchanged, TTL/pressure thresholds are correct, and it can be rebuilt upon restart.
7. Plugins will change registration, authentication, provider/channel/tool/hook, and in-process trust boundaries; unit tests do not cover plugin loading, schema, protocol bridging, security approval, and actual startup, so integration and protocol testing must be added.
8. Adding a new provider requires going through: provider capability/catalog metadata → authentication and credentials → API adapter/protocol → model parsing and alias → candidate chain/failover → request/response schema → integration testing. You cannot just add if/else in the core loop.
9. New channels should not change the Gateway's core routing, Agent Loop, Session/Writer ownership, or tool policy/approval. They should only add channel capability, inbound translation, sessionKey mapping, and ReplyDispatcher adaptation.
10. Prove prefix stability: Record the stable prefix bytes and `stablePrefixCacheKey` before and after modification, perform diff/hash assertions; place dynamic fields after the cache boundary; then run provider request construction tests and cache hit observations. Only if the stable segment hash remains unchanged can it be considered that prefix reuse has not been broken.

*OpenClaw 2026.10.9 · Engineering Practice*
