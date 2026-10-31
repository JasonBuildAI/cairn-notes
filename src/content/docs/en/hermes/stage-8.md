---
title: "Stage 8: Engineering Testing and Troubleshooting"
description: "Stage 8: Engineering testing and troubleshooting. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: Hermes Agent Source Code Course · Stage Paper
> Pre-set: Stage 0~7
> Overview of Matches: `engineering.md`
> Goal of this stage: Use minimal reproduction and evidence chains to locate the problem, avoiding mistaking "local runs" for "contracts are intact." 

## 1. This stage addresses what to address

Hermes failures often lie not within a single function but between two boundaries: 

- Admission has been submitted, but the worker has not claimed it; 
- The tool is running, but the result is not canonical; 
- Fallback is activated, but no rebuild request has been made; 
- Compression successful, but session reads incorrectly; 
- UI is displayed, but transcript is not closed; 
- Two profiles share one process, and the backend ticker is mistakenly set to home. 

The goal of engineering is not to "write more tests," but to ensure that each type of fact has observable evidence and independent verification points. 

## 2. Remember one judgment first

**First determine whether it has already occurred/submitted, then determine why it did not appear as expected.** 

The same sentence "the tool didn't respond" could be: 

- Never started at all: admission still queued; 
- Started but not executed: lease or approval stuck; 
- Executed but not seen by the model: result not canonical; 
- Written but UI not shown: event/delivery issue; 
- Submitted but deduplicated by the platform: receipt/idempotent issues. 

The fixes for the five types of problems are completely different. 

## 3. Source code main storyline

1. First, find the process: The logs and states of classic CLI, Gateway, TUI Python backend, Desktop, and cron worker are not aligned. 
2. Then look for turns: `prompt.submit`, `SessionAuthority.submit()`, admission id, generation, `TurnRunner`. 
3. Find enforcement rights: lease holder, `expires_at`, refresh log, liveness watchdog. 
4. Find the context: system prompt source, `build_api_messages()`, number of preflights, compression lock. 
5. Then find the call: request id, provider, model, retry, credential rotation, fallback. 
6. Then find tools: call flush, executor, result commit, guardrail, timeout. 
7. Finally, find the finishing touch: finalizer, assistant row, transcript tail, delivery receipt, event replay. 
8. The test directory is organized by layer: `tests/gateway`, `tests/agent`, `tests/tools`, `tests/hermes_cli`, `tests/cron`, `tests/tui_gateway`, `tests/acp_adapter`, etc. 
9. Minimal reproduction should use temporary `HERMES_HOME`, fake provider, fake adapter, and temporary SessionDB; Do not conduct destructive experiments on real state.db. 
10. When modifying persistence/protocols, first find contracts from existing tests, then add five types of use cases: "success, boundary, failure, recovery, replay." 

## 4. Key evidence and contracts

| Symptoms | First Evidence | Cannot be directly assumed |
| --- | --- | --- |
| turn Stuck | admission status + lease holder | Models are slow |
| No results for tools | call row + executor log + result row | The tool did not execute |
| Repeated answers | request id + delivery receipt + event seq | Model Repeated Generation |
| No Context Lowered | pressure + threshold + lock/cooldown | The compressor is broken |
| Fallback Failure | retry trace + fallback route + preflight | New provider not available |
| Multiple profile serial | Thread/task profile scope | Session ID is incorrect |
| DB Lock | writer, busy timeout, lock holder | Directly delete WAL |
| schema incompatible | Binary version + DB version | Manually modify table structure |

Recommended Layered Testing: 

- **Pure contract testing**: verdict, payload normalization, state transitions, error classification; 
- **Component Testing**: SessionAuthority, lease, compressor, tool round; 
- **Integration Test**: Gateway/TUI submitted to finalize; 
- **Recovery Test**: Process interrupt, `unknown`, stale lease, orphan tool pair; 
- **Compatibility Testing**:p rovider adapter, schema migration, RPC wire contract; 
- **End-to-End Smoking**: Only verifies the main chain to reach it, does not replace the top five categories. 

## 5. An observable link

~~~text
Reproduction command
  → Record process / profile / HERMES_HOME / session id
  → Check admission
  → Check lease and generation
  → Check request id / provider / preflight
  → Check tool call / result
  → Check finalizer / transcript tail
  → Check delivery receipt / event sequence
  Form a 'occurred/not occurred' conclusion
  Write the minimal failing test
  Run the adjacent layer test again after fixing
~~~

## 6. Experiment

### Experiment A: Run a turn in a temporary environment

~~~powershell
$env:HERMES_HOME = Join-Path $env:TEMP ("hermes-test-" + [guid]::NewGuid())
python -m pytest tests/gateway/test_managed_turn_contract.py -q
~~~

Record the DB and logs in the temporary directory before and after the test, confirming that no real home is written. 

### Experiment B: Write the minimum test for tool timeout

Using a fake tool to block the timeout, asserting the existence of the corresponding tool result, and that subsequent models can see the termination fact. 

### Experiment C: Writing a contract test for fallback

Let the fake provider return a fallback error, asserting that after the fallback, the preflight will rerun, rather than reusing the old request. 

### Experimental Reference Answers

1. **Experiment A**: All states should be temporary `HERMES_HOME`; can be safely deleted after testing. The real profile should not have a new session. 
2. **Experiment B**: Assert that the tool call is persistent, the timeout result is canonical, and the turn is not pending; Do not only assert "has been called" in the fake tool. 
3. **Experiment C**: Asserts that the new provider's requests are generated by reassemble/preflight, and the old messages/headers have not been mindlessly reused. 

## 7. Failure and recovery

| Symptoms | Common Root Causes | Proper Management |
| --- | --- | --- |
| turn always queued | No drain/ticker, previous claim not settled | Check owner, lease, event; do not forcibly change the final state |
| turn never outputs | provider stream, tool approval, clarify, lock | query request id, tool status, watchdog |
| Tool result missing | result persist failed or interrupted without filling skipped | Keep pairing, first check side effects |
| Page has answers, database does not | finalize/transcript tail not closed | Check finalizer and delivery order |
| Compression repeatedly fails | lock, cooldown, summary provider, insufficient window | Etc./release/repair provider, cannot retry indefinitely |
| After fallback: 400/overflow | Wire copy not rebuilt: | Re-preflight |
| Repeat tool after restart | `unknown` is treated as queued | readback/reconcile + idempotent |
| Multi-profile threading | Background threads/RPC not bound scope | Explicitly bound home/profile |
| state.db locked | Long transaction, error lock, another writer | Holder query, backup, official repair |
| Prompt cache hit drop | Uncompressed path reconstruction prompt | Compare stable bytes with reconstruction call stack |

## 8. Pass through customs and self-test

1. Why is it important to distinguish the process before troubleshooting? 
2. How to distinguish between "the tool did not run" and "it ran but the result did not reach the model"? 
3. Why is the temporary `HERMES_HOME` the test bottom line? 
4. What facts must a recovery test at least cover? 
5. Why can't schema migration be changed directly in live DB? 
6. After fixing a fallback bug, why run preflight and Provider Adapter tests? 

### Reference answers

1. Because the entry, host, agent, cron, and UI may be different processes; Searching for logs in error processes will yield a false conclusion of "no execution." 
2. Check the canonical call, executor log, result row, and `_incremental_persistence_failed`. If only the call log has no result, it may indicate execution failure or persistence failure; If the result is not in the model, check the commit and loop backfill. 
3. It isolates real sessions, leases, admissions, skills, and credentials, preventing tests from corrupting user ledgers or triggering real external side effects; and also makes failures repeatable. 
4. At least cover: Submitted calls, unknown/missing results, admission status, lease attribution, canonical session, final transcript, and external side effect verification. 
5. There may be concurrent reader/writer on the live DB; manual modification will damage transactions, indexes, generation, and FTS; You must first stop writing and back up, then migrate the replica to the official site and verify that old data is readable. 
6. Because fallback changes the provider, it can easily affect request fields, context windows, tool schemas, and preflight; Only testing "final success" will miss protocol incompatibilities and duplicate compression. 

## 9. Source code coordinates

- `gateway/session_authority.py::SessionAuthority`
- `gateway/run_turn_runner.py::TurnRunner`
- `agent/turn_facade_lease.py::DurableTurnLease`
- `agent/turn_tool_round.py::run_tool_round`
- `agent/turn_api_error.py::handle_api_error`
- `agent/context_compressor.py::ContextCompressor`
- `hermes_state.py::SessionDB`
- `tests/gateway/`
- `tests/tools/`
- `tests/agent/`
- `tests/cron/`
- `tests/tui_gateway/`

## 10. Next

Enter Stage 9: Combine the boundaries of the first eight stages into a graduate transformation that can be implemented, restored, and tested.
