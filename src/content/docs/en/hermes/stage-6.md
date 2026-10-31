---
title: "Stage 6: SessionDB and Recovery"
description: "Stage 6: SessionDB and Recovery. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: Hermes Agent Source Code Course · Stage Paper
> Pre-preparation: Stages 1 and 4
> Corresponding overview: `turn-lifecycle.md` Section 10, `core-mechanisms.md` Section 5
> Objective of this stage: Understand how transcript, admission, lease, compression lock, and migration form a recoverable ledger. 

## 1. This stage addresses what to address

Hermes recovery is not about "picking up messages within processes," but rather separating facts from different lifecycles: 

- The long-term identity of the session and the current generation generation; 
- Each message and its call/result structure; 
- The queue and final state of each admission; 
- Who temporarily holds the turn lease; 
- Who holds the compression lock; 
- FTS search index and schema version. 

Some of these facts must be submitted atomically, while others can ultimately be consistent. The most important thing in recovery is **not to mistake uncertainty for certainty**. 

## 2. Remember one judgment first

**Rows in the database prove "what the system recorded," but do not automatically prove "how far external side effects have been completed."** 

For example: 

- `started` Admission indicates that an owner has taken over, but does not mean the tool is successful; 
- Tool call is persistent, does not indicate the corresponding command has ended; 
- The final text of the assistant has been deposited, which does not indicate that the message platform has successfully delivered it; 
- Expired lease means you can regain enforcement rights, but does not mean the old process is dead. 

Recovery must combine admission, transcript, tool results, external idempotent keys, and delivery receipt. 

## 3. Source code main storyline

1. `hermes_state.py::SessionDB` is the SQLite ledger, located by default in the state path of the profile; Supports WAL read/write, lock waiting, corruption isolation, and connection lifecycle management. 
2. `hermes_state_common.py` Defines `SCHEMA_VERSION = 32`, `FTS_STORAGE_VERSION = 3` as well as migration/index/lock assistance. 
3. `AsyncSessionDB` Expose synchronous DB operations to asynchronous hosts to avoid direct blocking in event loops. 
4. Message writing uses canonical append/flush semantics; `repair_alternation=True` When restored, the alternating structure of user/assistant/tool will be corrected. 
5. `_strip_stale_tool_call_markers()` Handle incomplete tool-call flags in old sessions to avoid provider rejection after resume. 
6. Admission-related line records such as request id, principal, session, payload summary, status, owner epoch, and outcome, which form the basis for FIFO and idempotents. 
7. Session turn lease line records the holder and `expires_at`; Expired rows can be retrieved when retrieving them; renewals must match the holder. 
8. Compression lock prevents simultaneous summarization/rotation of the same session; Failure cooling and lock are different concepts. 
9. Compression rotation creates a child session and keeps the parent/child source; When resuming resume, first resolve the current canonical session. 
10. The final state of admission and the transcript boundary should be submitted together as much as possible to avoid situations like "state completed but answer not closed" or "answer written but queue can still be rerun." 

## 4. Key Objects and Contracts

| Fact | Durable Carrier | Can Be Proven | Cannot Be Proven |
| --- | --- | --- | --- |
| Conversation Identity | session row | session exists, source, generation | Current turn succeeds |
| News | messages/transcript | What the model saw/produced | External side effects completed |
| admission | session admissions | Received, Queued, Claimed, Terminal | Tool Successful |
| turn lease | lease row | Current Ownership and Term of Enforcement Rights | Model Answer Correct |
| compression lock | lock row | Who is compressing | Compression is sure to succeed |
| FTS index | FTS tables | Searchable text | Business transaction submitted |
| delivery receipt | Host/Platform Status | Delivered to a Certain Channel | User Reads |

Versions and Compatibility: 

- schema `32` and FTS storage `3` are the persistent formats for current archives, not comments that can be changed at will; 
- Migration must be verified on isolated copies and cannot manually delete tables in front of live writers; 
- WAL allows concurrent reads and single writers, but does not mean multiple writers can write at will; 
- If database files are replaced, WAL generation is lost, or structures are damaged, you must follow the official quarantine/repair path to continue using it. 

## 5. An observable link

~~~text
turn start
  → session row / admission row
  → lease acquire
  → user message staged + flushed
  → assistant tool call committed
  → tool result committed
  → assistant final committed
  → finalize / terminal transition
  → delivery receipt

process crash / restart
  → open SessionDB
  → verify schema / integrity / generation
  → list queued + started + unknown admissions
  → resolve canonical session
  → inspect transcript tail and tool pairs
  → reclaim expired lease / resolve unknown
  → resume or settle
~~~

Observation: The first thing to do after a restart is not to "rerun the last round," but to first assess how far admission and transcription have progressed. 

## 6. Experiment

### Experiment A: schema and indexes

Create a DB in temporary `HERMES_HOME`, read `PRAGMA user_version`, table list, and FTS status, and compare `SCHEMA_VERSION=32` with `FTS_STORAGE_VERSION=3`. 

### Experiment B: Tool crashes midway

Terminate the process when the test tool has persisted the call but the result has not yet been submitted. After restarting, check transcript and recovery policies. 

### Experiment C: Compression Rotation

Trigger compression and rotation of the child session, comparing parent/child ids, resume results, and messages. 

### Experimental Reference Answers

1. **Experiment A**: You should see that the current schema/version matches the source code constants, and the FTS table exists and can be queried; This is only format validation and does not mean the business data is complete. 
2. **Experiment B**: After restarting, you can see persisted tool calls, but there may be no result. You cannot rerun destructive tools out of thin air; You need to combine the result, external powers keys, and recovery strategies to complete or terminate the call. 
3. **Experiment C**: resume should be parsed to the canonical child; The parent session still retains the source and historical boundaries, and the messages on the child continue from the compressed context. 

## 7. Failure and recovery

| Failure | Risk | Recovery Principles |
| --- | --- | --- |
| DB locked | Write timeout, lease may not be renewed | Distinguishing between temporary locks and inability to refresh before expiration |
| DB file replaced | Old connection wrote the wrong new file | Detect generation, stop old writer |
| WAL missing | Submitted view uncertain | Official recovery/isolation, don't manually assemble databases |
| Structural Damage | Silence Error or Crash | Quarantine + Restore from Backup |
| orphan tool call | provider rejection or incomplete history | Fix the pairing according to the call ID, do not delete call | out of thin air
| stale lease | Successors cannot execute in time | After confirming owner death / expiration | Official recall |
| admission unknown | May be repeated | After readback/reconcile, submit a clear terminal state |
| compression lock stuck | Context cannot continue compression | Confirm the holder is dead before releasing |
| Transcript too large | Resume failure | Use explicit limits and export/crop strategies |

## 8. Pass through customs and self-test

1. What are `SCHEMA_VERSION` and `FTS_STORAGE_VERSION` respectively? 
2. Why is there still only one writer under WAL? 
3. What do the admission line and transcript line each prove? 
4. Why is compression required for child sessions instead of just overwriting the original messages? 
5. How should you determine after restarting when a tool call has been placed in the database but the result has not? 
6. What is the difference between handling stale lease and `unknown` admission? 
7. Why can't compression lock files or table rows be manually deleted? 

### Reference answers

1. The current baselines are schema `32` and FTS storage `3`. They describe persistent formats, and migration must follow a controlled path. 
2. WAL improves read-write concurrency, but SQLite's write transactions are still single writers; Multiple writers can compete for locks, timeouts, and even cause lease/finality commits to lose predictability. 
3. Admission proves the system receives, queues, claims, and ends; transcript proves message content and call/result structure. The two cannot replace each other. 
4. Overwriting original messages disguises the summary as the original history and damages the audit and recovery boundaries. The child session retains the new context while maintaining the old ledger with the parent/child relationship. 
5. First, use the call ID to check the result and the external system to determine whether the execution is complete; Then complete the result or settle the turn as failed/unknown. Do not rerun destructive tools just because the result is missing. 
6. Stale lease refers to the issue of expiration of execution rights; after confirming the owner no longer holds the property, it can be reclaimed; `unknown` This is an uncertain execution boundary for admission, which must be readback and reconciled before committing to the final state. 
7. The lock may still be held by the surviving writer. Forced deletion can cause concurrent compression, double writes, or child session forks; You must first confirm that the holder is dead and go through the official release/repair process. 

## 9. Source code coordinates

- `hermes_state.py::SessionDB`
- `hermes_state.py::AsyncSessionDB`
- `hermes_state.py::_strip_stale_tool_call_markers`
- `hermes_state_common.py::SCHEMA_VERSION`
- `hermes_state_common.py::FTS_STORAGE_VERSION`
- `agent/session_persistence.py`
- `gateway/session_settlement_recovery.py`
- `agent/conversation_compression.py`
- `tests/gateway/test_managed_turn_contract.py`
- `tests/gateway/test_compression_failure_session_sync.py`

## 10. Next Steps

Enter Stage 7: After the ledger and core loop are stable, how plugins, cron, delegates, message channels, and the UI can extend the system without duplicating the core semantics.
