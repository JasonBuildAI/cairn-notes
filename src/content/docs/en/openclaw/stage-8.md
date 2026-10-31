---
title: "Stage 8: Engineering, Testing, and Operations"
description: "Stage 8: Engineering, testing, and operations. Understand facts, contracts, observable evidence, and failure recovery along the main line of the source code."
---

> Course: OpenClaw Source Code Course · Stage Test  
> Prerequisite: Stages 1–7  
> Corresponding Overview: `engineering.md`  
> Goal of This Stage: Establish check chains, test hierarchy, schema migration, and troubleshooting order.  

## 1. What This Stage Solves

OpenClaw runs Gateway, models, tools, SQLite, plugins, channels, and sandbox simultaneously. Common issues are not single-point syntax errors, but rather:

- Concurrent writes in the same session;  
- Old snapshots unreadable after schema upgrades;  
- Provider/harness rollback causing transcripts to be written twice;  
- MCP being disconnected while the UI still shows the tool;  
- Unsafe sandbox configuration;  
- Old processes still holding the writer after cancellation;  
- Differences in path, encoding, and process cleanup across platforms.  

Engineering should catch these problems before submission or startup, rather than relying on online guessing.

## 2. Remember This Guideline

**Tests should cover 'ownership and failure boundaries,' not just happy path outputs.**

Truly valuable tests ask: Who writes, who cannot write, are retries repeated, is migration readable, do failures fail closed.

## 3. Source Code Mainline

1. `scripts/check.mts` connects with repository scripts for type checks, architecture boundaries, formatting, and test entry points.  
2. `tsconfig*.json`, lint/format configurations enforce import boundaries and code quality.  
3. `src/state/`'s schema, migration, snapshot, and lease tests cover database upgrades and concurrency.  
4. `src/gateway/server-methods/`'s admission/writer/abort/cancellation tests cover idempotency, takeover, and cancellation.  
5. `packages/agent-core` and `src/agents/`'s session/loop/compaction tests cover tool pairing, steering, follow-up, and history rewriting.  
6. `src/agents/sandbox/`'s boundary tests cover mount, paths, env, backend, and lifecycle.  
7. `src/agents/subagents/`'s tests cover child sessions, recovery, timeouts, and parent/child ownership.  

## 4. Key Objects and Contracts

| Test Layer | What to Prove | Typical Failures |  
| --- | --- | --- |  
| contract/unit | Types, decisions, pure functions | Semantic drift |  
| loop/session | Tool pairing, steering, follow-up | Isolated calls/repeated replies |  
| gateway | Idempotency, ACK, writer fence, abort | Duplicate runs/old writer writing |  
| state/migration | Schema upgrades, snapshots, leases | Old DB unreadable/concurrent overwrite |  
| sandbox | Paths, mounts, env, lifecycle | Out-of-bounds/residue |  
| plugin/MCP | Registration, connection, backoff, permissions | Capability bypass/visible but unusable |  
| cross-platform | Paths, encoding, process cleanup | Windows/Linux differences |  

### Troubleshooting Order

```text
1. First look at the admission/run final state to confirm whether the request has been accepted
2. Then look at sessionKey/sessionId/writer to confirm ownership and write permissions
3. Check harness/model candidates and confirm execution at runtime
4. Check tool policy/approval/sandbox to confirm the side effect boundaries
5. Look at transcript cursor/branch and confirm the historical submission
6. Check reply/event seq to confirm whether the user has received it
7. Only look at the model text itself last
```

Checking from back to front can easily misjudge 'reply not received' as a model problem.

## 5. An observable chain

```text
source change
  → type/lint/architecture check
  → focused unit/contract tests
  → loop/gateway/state integration
  → migration/recovery tests
  → cross-platform smoke
  → release archive
```

## 6. Experiment

### Experiment A: writer takes over testing

Read `chat-send`/session-bootstrap related tests. Reference acceptance: can list four assertions: idempotent, CAS failure, supersede, and old writer refusal to write to four assertions. 

### Experiment B: schema migration

Find a set of session migration tests to observe how the old version fixture is upgraded. Reference acceptance: After migration, the old session/transcript is readable and will not silently downgrade to empty data if it fails. 

### Experiment C: Sandbox boundary test

Read mount/path/env tests. Reference acceptance: Out-of-bounds paths, read-only mounts, secret environment variables are validated before startup, not discovered after the tool is executed. 

### Experiment D: Disconnection Recovery

Simulate missing events using Gateway events/snapshots to test. Reference acceptance: Resynchronize by seq; old stateVersion snapshots do not overwrite new states. 

### Experimental Reference Answers

1. It should be able to list four assertions: idempotent hit, CAS failure, supersede, and old writer refusal to write in the four assertions. 
2. Migration should make old sessions/transcripts readable; If failure, clearly report errors; if not silent, become empty data. 
3. Out-of-bounds paths, mounting permissions, and secret environments should be verified before startup; do not wait until the tool is executed before checking. 
4. After missing an event, press `seq` to resynchronize; Old stateVersion snapshots must not overwrite new states. 

## 7. Failure and recovery

| Fault | Check first | Recovery principle |
| --- | --- | --- |
| Request Repeated Execution | clientRunId/idempotency | Reuse the original run |
| Intertwined History | writer fence/lane | Revoked the old writing rights |
| Reply Lost | ReplyDispatcher/event seq | Replay/repost, do not rerun the model |
| Old Warehouse Can't Open | schema/migration | After backup, migrate, fail closed |
| MCP tool unavailable | Connect/Retreat | Retain the directory, execute returns unavailable |
| Sandbox Boundaries | mount/env/authority | Reject before starting, do not execute |
| Sub-agent out of control | child run/timeout | Explicit cancellation and recall |

## 8. Pass through customs and self-test

1. Why should troubleshooting first look at admission/final status instead of model responses? 
2. What assertions must a writer takeover test at least cover? 
3. Why can't schema migration fail and not be rolled back to an empty database? 
4. What is the correct user semantic when MCP is out of contact? 
5. Why do sandbox boundaries need to be verified before launch? 
6. How to handle "Reply not yet but model completed"? 

### Reference answers

1. Model replies are only part of execution. If the request is not accepted or run is mistaken by supersede or writer, continuing to follow the model text will cause misjudgments. First, confirm the upstream of the fact chain. 
2. Impotent hits, CAS success/failure, old writer supersede, old writer cannot be appended, and the final terminal outcome can be audited. 
3. An empty repository can make users think history is lost, and may cause new runs to overwrite old records. The correct approach is to back up, block startup, repair migration, or explicitly recover. 
4. The tool directory can be kept, but calls return unavailable; In the background, click undo and reconnect. You cannot treat the directory as executable, nor silently delete user configurations. 
5. Once a container/process starts, out-of-bounds mounting, secret exposure, or path escape may already have an impact. Fail closed must be performed before startup. 
6. Check the ReplyDispatcher, event seq, and run final state; If the reply is unsettled, replay/resend the reply, and the model or tool cannot be re-executed. 

## 9. Source code coordinates

- `scripts/check.mts`
- `package.json`
- `src/state/openclaw-agent-db-session-migrations.ts`
- `src/state/openclaw-agent-session-snapshots-schema.ts`
- `src/gateway/server-methods/chat-send-admission.ts`
- `src/agents/embedded-agent-runner/run/session-bootstrap.ts`
- `packages/agent-core/src/agent-loop.ts`
- `src/agents/sandbox/validate-sandbox-security.ts`
- `src/agents/subagents/registry/`

## 10. Next

Entering Stage 9: Combine ingress, loop, context, approval, fallback, transcript, and testing into a deliverable extended design.
