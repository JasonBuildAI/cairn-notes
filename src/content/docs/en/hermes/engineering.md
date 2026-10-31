---
title: "Hermes Agent 0.22.5 Engineering Practice"
description: "Complete engineering practice using debug paths, source code experiments, failure matrices, and extended recipes."
---

> Baseline: `hermes-agent-0.22.5` release archive. The release archive does not include `.git`, so this article does not write fictional tags/commits; the version is based on the archive name and `hermes_cli/__init__.py`'s `__release_date__ = "2026.9.24"`.
> Source code root directory: `$HERMES_SRC`.
> The goal is not to "be able to start," but to be able to use evidence to pinpoint why a turn got stuck, why it repeated, why profiles were mixed, and how to modify without breaking persistence and prompt cache.

## 0. First, remember the four troubleshooting principles

1. **Distinguish processes first**: classic CLI, Gateway, TUI Python backend, Desktop, cron worker are not the same process.
2. **Read facts first, don't guess the code**: admission, lease, transcript, receipt, event, logs each have their own owner.
3. **Determine if it has been committed first**: the same error may either "not have occurred" or "occurred but was not recorded"; the latter must not be rerun directly.
4. **Look at boundaries first, then functions**: input entry, ownership, provider, tool, compression, UI—problems usually span two boundaries.

```text
Client
  → admission (whether to accept orders, queue, deduplicate)
  → lease (who has the right to enforce)
  → context (what the model sees)
  → provider (how to call)
  → tool (what it does)
  → SessionDB (Which facts have been persisted)
  → finalization (how to conclude, deliver, release)
  → event/UI (what the user sees)
```

---

## 1. Environment and Baseline

### 1.1 Version and Path

First, make sure you are reading the current archive, not an old directory:

```powershell
cd $HERMES_SRC
rg -n "__release_date__|__version__" hermes_cli/__init__.py
rg -n "requires-python|version =" pyproject.toml
```

Key points:

- `pyproject.toml`'s `version = "0.0.0"` is a placeholder, not a product version;
- `hermes_cli/__init__.py`'s `__release_date__` is a release clue;
- Release archives do not have `.git`, do not fabricate commits/tags;
- Old `hermes-0.22.2` handouts can only be used for historical reference (this site only retains v0.22.5).

### 1.2 Windows Installation Chain

The order of `setup-hermes.ps1` is worth remembering:

```text
uv fixed in the middle
  Verify sha256
  → uv install bootstrap Python
  → python -m pm.cli install
  → hash-verified install dependencies
  → activate.ps1
  → .env template
  → tools/skills_sync.py Synchronized bundled skills
```

Several engineering implications:

- **uv itself also has pins**, it's not just 'having uv is enough';
- **Dependencies are checked by `uv.lock`**, do not bypass this by manually installing with pip and then pretending the environment is consistent;
- `HERMES_HOME` can change the location of skills/state; testing must use a temporary directory;
- Do not hardcode `~/.hermes`, code should go through `get_hermes_home()` / `display_hermes_home()`.

### 1.3 Python and Dependencies

- `requires-python = ">=3.11,<3.15"`;
- The actual main target is 3.14, 3.11 mainly serves the old updater bridge;
- Almost all direct dependencies are exact pinned;
- Dependencies have release-age checks to avoid newly released supply chain versions entering immediately;
- `ruff.toml` target-version is `py311`, line length 88.

Do not assume compatibility just because it can be imported on the local machine; you need to check `pyproject.toml`, lock, and the CI/Coding rules.

---

## 2. The Shortest Route to Reading Source Code

### 2.1 First Time: Only track one turn

```text
hermes_cli/main.py:1682 cmd_chat
  → cli.py:880 HermesCLI
  → hermes_cli/cli_chat_turn_mixin.py:49 chat()
  → hermes_cli/cli_agent_setup_mixin.py:645 _init_agent()
  → GatewayAgent.run_conversation()
  → gateway_agent.py:769 connection.call("prompt.submit")
  → gateway/session_authority.py:636 submit()
  → gateway/run_turn_runner.py:998 agent.run_conversation()
  → agent/turn_facade.py:22
  → agent/conversation_loop.py:1785
```

### 2.2 Second Time: Only Pursue Four Types of Facts

```text
Who takes the order: session_admissions
Who has the room card: session_turn_leases
Who is working: worker_executions / worker_receipts
What has already happened: messages / system_prompts / event stream
```

### 2.3 Third Time: Only Look at Failure Paths

- Lease lost;
- Tool result persistence failed;
- Compression timeout / lock / cooldown;
- Provider error → retry/rotate/fallback;
- Rebuild preflight after fallback;
- Cancel / abort / history broken;
- SessionDB lock, WAL, schema mismatch.

If a failure path cannot be traced back to a table or an event, it means you haven't found its owner yet.

---

## 3. Engineering Checks: Don't Mistake "Runs" for "Not Broken"

### 3.1 Common Checks

```powershell
cd $HERMES_SRC
ruff check ./
```

Also:

- `justfile`: `ruff check` plus ESLint for all JS/TS workspaces;
- `lefthook.yml`: pre-commit lint;
- `scripts/check`: main entry for blocking lint;
- `scripts/run_tests.sh`: test entry, should not bypass it to directly run pytest.

During testing, first set up isolated `HERMES_HOME` / `HERMES_RUNTIME_DIR`, do not use real `~/.hermes/`.

### 3.2 Testing Layers

| Layer | What it proves | Typical approach |
| --- | --- | --- |
| Unit | Pure functions/classifiers/serialization | Directly test project/checkpoint/schema logic |
| Behavior Contract | Behavior is unchanged under a given event sequence | Fake provider/tool/DB, assert state and events |
| Integration | Modules actually imported, real SQLite/files | Temporary `HERMES_HOME`, real `state.db` |
| Multi-process | lease/admission/recovery | Two workers/processes contend for the same session |
| E2E | CLI/TUI/Gateway/platform real workflows | Minimal real processes, no dependency on manual environment |

Do not write change-detectors that check "function was called"; assert user-observable behavior and durable facts.

---

## 4. Debugging a Turn: Locate Step by Step

### 4.1 Which process is it in?

| Entry | Check first |
| --- | --- |
| Classic CLI | Whether `GatewayAgent` is connected to Gateway; whether `prompt.submit` succeeded |
| TUI | Whether Node/Ink is connected to `tui_gateway`; whether RPC method returns |
| Desktop | Whether WebSocket is connected; whether the correct profile is bound |
| Messaging platform | Whether adapter converts messages into admission; whether target session is correct |
| Cron | Whether it is gateway ticker, whether claim/heartbeat succeeded |

If there is no real Agent in the CLI process, do not look for tool execution logs there.

### 4.2 Has it been accepted?

Check `session_admissions`:

- `queued`: queued, not yet started;
- `started`: already has an owner started;
- `unknown`: boundary unclear, reconcile first;
- `terminal`: already in final state.

Also check `UNIQUE(principal_id, target_session_id, request_id)`: duplicate submission of the same request should not generate a second task.

### 4.3 Why is it waiting?

In order:

1. Whether admission `queued`;
2. Whether there is another turn holding the lease;
3. Whether the lease expired but heartbeat still shows backend alive;
4. Whether stuck in session lane;
5. Whether provider streaming does not return;
6. Whether tool timeout/approval/sudo/clarify;
7. Whether compression lock or cooldown;
8. Whether liveness watchdog has been interrupted but UI did not receive events.

Do not immediately kill the process; first confirm the difference between "occurred but not notified" and "has not started at all".

### 4.4 Tool executed, why didn't the model see the result?

Check according to the order in `run_tool_round`:

```text
Did the tool-call turn persist successfully?
  Does the tool really execute?
  → result Is it canonical persist?
  → Did it trigger a guardrail halt?
  Whether to enter post-tool compression?
  → Was it interrupted and a skipped result filled in?
```

If `session_persistence_failed`, the result cannot be sent back to the model; if it's just that the UI didn't display, you need to distinguish between transcript and event stream.

### 4.5 Why does the context keep growing?

Check:

- Whether `compression_enabled` is true;
- The threshold of `should_compress()` and the current pressure;
- Whether it is in compression failure cooldown;
- Whether `compression_locks` is held by another process;
- Whether the summary provider failed;
- Whether `tail_mode` has protected too much tail;
- Whether the context file itself is too large, not the historical messages.

### 4.6 Why didn't fallback work?

- Whether the error was classified as retryable/rotatable/fallback;
- Whether there are non-DEAD entries in the credential pool;
- Whether the cooldown for 429 is still in effect;
- Whether fallback is set to `restart_with_rebuilt_messages`;
- Whether the new provider supports the current tool/schema/api_mode;
- Whether it timed out during re-compression in preflight.

### 4.7 Why did multiple profiles get mixed up?

Focus on code that is "outside of the turn":

- Boot probe;
- Ticker;
- Deferred callback;
- RPC method;
- Thread hop;
- Child spawn;
- Module-global or import-time values of `os.environ`.

When one process serves multiple profiles, these locations must be explicitly bound to the owning profile scope; otherwise, they will silently default to the launch profile.

---

## 5. Failure Matrix

| Symptom | First Site | Common Cause | Correct Handling |
| --- | --- | --- | --- |
| Turn always queued | admission/lane | No ticker/worker, previous turn not released | Check owner, lease, event |
| Turn keeps running with no output | provider stream/tool | Provider stuck, tool timeout, approval not returned | Check API request id, tool status, watchdog |
| No result after tool error | `run_tool_round` | Result persist failed, interruption didn't patch skipped | Cannot send in-memory result to the model |
| Page has final answer but transcript does not | finalize/close tail | `_close_transcript_tail` not executed / event inconsistent with DB | Check finalize, assistant row |
| Compression repeatedly fails | compressor | Lock, cooldown, summary provider, insufficient window | Release/wait first, then fix provider |
| 400/overflow after fallback | preflight/API | Messages not rebuilt, different window, different api_mode | Rerun preflight, do not reuse old wire |
| Tools repeated after restart | lease/admission | Unknown treated as queued, lacking idempotence/readback | Reconcile first, forbid blind replays |
| Multiple profiles mix sessions | profile scope | Ticker/RPC/thread not bound | Explicitly bind home/profile |
| state.db locked | SQLite/WAL | Long transaction, wrong lock, another backend | Check heartbeat, busy timeout, backup then repair |
| Schema mismatch | migration | Old binary/new DB or vice versa | Stop writing, backup, use official migration path |
| Prompt cache hit rate drops | system prompt | Rebuilt via non-compressed path, dynamic fields entered stable | Compare stable hash/bytes |
| Replies sent repeatedly | event/replay | Client did not handle seq/snapshot, or retry bypassed idempotence | Check event id/seq, request id |

---

## 6. Safe modification recipes

### 6.1 Adding a new tool

Decide first where it belongs:

```text
Core built-in?
  → tools/
  → toolsets.py
  → model_tools.py
  → prompt/tool description
  → tests

Optional features/external integration?
  → plugin or MCP
  → Do not permanently add to the core tool schema
```

No matter which type, answer the following:

1. Is the schema strict, and is there a risk of unknown fields/path traversal?
2. Is a file mutation checkpoint needed?
3. How large might the result be, is there a synopsis/budget?
4. How are errors categorized, and can the model recover based on this?
5. Is it restricted by platform/toolset/authorization/approval?
6. Could it be misused by a child Agent?
7. Can the transcript maintain call/result pairing in case of failure?
8. Are there behavioral contract tests?

**Minimal path**: Implement read-only operations in `tools/`; add the corresponding toolset in `toolsets.py`; confirm visibility in `model_tools.get_tool_definitions()`; add tests for success, out-of-bounds, oversized, errors, and unauthorized access. Do not write tests only in the handler; also prove that assembly and authorization chains are effective.

### 6.2 Adding a new toolset

- Define tools/includes/platform restrictions in `toolsets.py`;
- Check if recursive `includes` has cycles or diamonds;
- Check if `"all"` / `"*"` might bring in tools that shouldn't be exposed;
- Check session-platform gated logic;
- Check if registry generation cache needs to be invalidated;
- Add four types of tests: include/exclude/recursive/platform.

### 6.3 Adding a new provider

Sequence:

```text
ProviderProfile
  → auth_type / env_vars / base_url / api_mode
  → request/stream adapter
  → model catalog / aliases
  → provider discovery
  → credential pool
  → candidate/fallback
  → tests
```

Checklist:

- `prepare_messages` Whether the historical prefix remains stable;
- `build_extra_body` Whether only the required fields for the provider are added;
- Whether tool messages / prompt cache keys / token quirks are declared;
- Whether OAuth failures enter DEAD instead of retrying infinitely;
- `api_mode` Whether there is a corresponding adapter;
- Whether preflight reconstruction is enforced after fallback;
- Whether keys/private inference are written into the public projection.

Prefer to make it a `$HERMES_HOME/plugins/model-providers/<name>/` user plugin rather than changing the core; only bundle it when built-in capability is truly needed.

### 6.4 New plugin

- Directory-based loading, `register(ctx)` or ABC subclass;
- Relative import must be available;
- Registration is an in-process behavior; plugins have the trust to execute arbitrary Python;
- Check for loading deadlocks, timeouts, and loading sequence;
- Specify whether plugin failure is fail open, fail closed, or disables that capability;
- Add real import, registration, tool/channel/provider integration tests.

### 6.5 New skill

- Place into `skills/` (built-in) or `optional-skills/` (on-demand);
- Clearly write trigger conditions, steps, verification, and failure handling;
- Do not write permission logic in the skill text;
- Ensure skills index enters the volatile tier, not stable;
- Add tests that are discoverable, readable, and won't trigger mistakenly.

### 6.6 New platform adapter

- Only responsible for receiving messages, identity mapping, reply routing, media;
- Inbound must construct a unified admission, not run a separate Agent;
- Outbound must go through platform's idempotent/segmented/retry semantics;
- Background notifications go through `admit_internal_event`, not bypassing FIFO;
- Check multi-profile, group/thread, deduplication, approval capability, and unreachable degradation;
- Do not write transcripts directly in the adapter.

### 6.7 New RPC method

- Python `tui_gateway/methods_<topic>.py` defines the handler;
- Update wire contract, generate TypeScript types;
- Handle server→client requests, timeouts, cancellations, and errors;
- Specify profile scope;
- Add protocol coverage, client compatibility, and permission tests.

### 6.8 Modify system prompt or context assembly

This is the highest-risk area. At minimum, verify:

- Whether stable/context/volatile layering still holds;
- Whether dynamic fields have been placed in stable;
- Whether workspace snapshot still freezes per session;
- Whether `content`/`api_content` playback is still consistent;
- Whether reconstruction is triggered only by compression;
- Whether there is a "same input → same stable bytes" contract test.

### 6.9 Modify SessionDB / migration

Direct schema changes or manually deleting tables in the live writer are prohibited. Safe order:

```text
Stop/Isolate writer
  → Backup state.db (together with WAL/SHM semantics)
  Check schema version / integrity / health
  → Use the official migration/repair path
  Restore a sample on the temporary HERMES_HOME
  → Run old transcript reading, admission/lease/receipt Test
  Switch back to the real environment
```

The significance of WAL is concurrent readers and a single writer, not 'allowing arbitrary concurrent writes.' Do not delete or replace the database file while another process is writing to the WAL.

### 6.10 Fix durable state

Classify before fixing:

- **stale lease**: confirm the owner is dead/heartbeat expired, then let the official repair the expired lease;
- **compression lock**: confirm the holder is gone, then release;
- **admission unknown**: read back, do not directly change to queued/terminal;
- **missing worker receipt**: first check execution side effects, then decide whether to retry;
- **conversation generation**: can only advance monotonically, cannot recycle for reuse;
- **messages orphan**: repair pairing according to tool call UID, cannot delete calls out of thin air.

---

## 7. Graduation exercises (with reference answers)

### Exercise 1: Draw a cross-process turn

Mark: CLI/TUI frontend, Gateway admission, TurnRunner, AIAgent, lease, SessionDB, event stream.

**Reference answer:**

```text
Frontend
  → prompt.submit / JSON-RPC
  → Gateway adapter
  → session_admissions(queued)
  → TurnRunner
  → session_turn_leases(holder + TTL)
  → AIAgent.run_conversation
  → build_turn_context / provider / tools
  → messages + tool pairs + events
  → finalize / transcript / reply
  → admission terminal + lease release
```

Acceptance point: Indicates which step is in the CLI process, which step is in the Gateway, and which step is in the Python TUI backend; Indicates that "ACK/accepted" does not equal "model completed." 

### Exercise 2: Construct a lease stuck in place

Let one turn hold a lease, and another turn commits with the same session. Observe waiting, timeout, cancellation, and recovery after owner death. 

**Reference Answer**: The second turn should wait for lease, not concurrent transcript writing; Interrupts can occur during the waiting period; If the owner survives but the event loop gets stuck, watchdog/heartbeat should cause interrupts; If the owner truly dies, only new owners can take over after TTL expires. The acceptance point is that after the old owner loses their rights, they no longer write the final state, and the new owner will not repeat the submitted tool. 

### Exercise 3: Recovery from Compression Failure

Construct four scenarios: compression lock occupied, summary provider failure, cooldown, compression timeout. 

**Reference Answers**: 

- lock occupied: should not be compressed concurrently, waiting/avoiding; 
- cooldown: Do not retry the same summary provider for every API call; 
- Compress unreached provider: refund API call; 
- Compression timeout: turn may end with context compression timeout, keeping the transcript and switching to a clean session in the next round; 
- After failure, do not disguise "Compression Failed" as normal context. 

Acceptance points: status, event, logs can distinguish lock/cooldown/timeout/provider error. 

### Exercise 4: SessionDB Locks and Repairs

Manufacture `database is locked`, then resume according to safe procedures. 

**Reference Answer**: First, confirm whether there is live writer/backend heartbeat; Do not delete `state.db`; Read schema, integrity, and WAL status; Stop writing, back up, and use official repair/migration; Verify transcript/admission/lease/receipt readability during temporary `HERMES_HOME` process; Only restore service last. The acceptance point is that call/result remains paired after repair, unknown admission is not misjudged, and compression lock/lease is not crudely cleared. 

### Exercise 5: Provider fallback

Have the main provider return a recoverable error and configure a fallback. Check if the fallback returns to preflight. 

**Reference Answer**: Errors should be categorized first; When rotation is possible, credentials are replaced first; only when unavailable is fallback; Fallback settings `restart_with_rebuilt_messages`, system prompt/wire messages are rebuilt, window recalculation and compression are recalculated; Failure candidates must not contaminate the final transcript. The acceptance point is that the final session advances only once, and the final provider's context does not use the old window. 

### Exercise 6: Add a read-only tool

Requirements: Read files within the workspace, strict schema, large result summaries, misclassification, do not expose to sub-agents, and have testing. 

**Reference Answer**: Placed in plugin or non-core toolset; Path must be checked by sandbox/provider, rejecting `..`, symbolic link escape, and absolute host path; Result exceeds threshold returns synopsis + byte count + lookback reference; Error at least `not_found/permission/too_large/transient`; Authorization layer prohibits sub-agents; Test covers normal, out-of-bounds, oversize, error, unauthorized and toolset visibility. Acceptance point is prompt/schema cost controllable and does not bypass unified policy. 

### Exercise 7: Add a Provider Plugin

Requirements: declaration `ProviderProfile`, authentication, API mode, model alias, can be discovered and can be fallbacked. 

**Reference Answer**: Implement profile/adapter in the user plugin directory; Declare streaming, tool message, prompt cache, token quirks; Authenticate with environment variables or OAuth; Verify discovery order, user override bundled, candidate chain, and credential pool state at the temporary `HERMES_HOME`); Add a real request shape test and an unavailable/fallback test. The acceptance point is that the core loop has not added a provider branch. 

### Exercise 8: Multiple profile isolation

Requirement: One process serves two profiles simultaneously, proving that session, model, skills, cron, and RPC are not concatenated. 

**Reference Answer**: All non-turn entries explicitly bind profile/home scope; Test session/admission/lease, model catalog, skills index, cron tick, RPC method for both profiles; Check that `os.environ`/modules are globally retained only with launch profiles without leakage. Acceptance point is that the state dir, generation, and prompt of both profiles do not affect each other. 

### Exercise 9: Prove prompt stability

Requirement: Modify a dynamic system prompt field to prove that the stable prefix is not broken.

**Reference Answer**: Record the bytes and hash of stable/context/volatile before and after modification; dynamic fields should only change volatile; stable hash remains unchanged; do a provider request construction test; if there is a cache hit metric, observe whether it decreases. If stable changes, revert context/volatile or rebuild only after compression. The acceptance point is `same stable inputs → same stable bytes`.

---

## 8. Three-Minute Whiteboard Explanation

If you only have three minutes, explain Hermes in these eight steps:

1. **Entry**: CLI proxies to Gateway; TUI/Desktop uses Python JSON-RPC; messaging platforms use an adapter.
2. **Admission**: Inputs first become `session_admissions`, with queue/steer/redirect and an idempotent request ID.
3. **Ownership**: TurnRunner acquires `session_turn_leases`, TTL refresh, watchdog.
4. **Context**: stable/context/volatile system prompts, `api_content` playback, preflight compression.
5. **Execution**: API → tool round → persist-before-execute → result pairing → next round.
6. **Persistence**: messages/system_prompts/usage/receipts each record different facts.
7. **Wrap-up**: finalize, transcript closure, event delivery, lease/scope release.
8. **Recovery**: first readback/receipt, then decide retry; effects already submitted are never redone.

Conclude with one sentence:

> **Hermes' reliability doesn't come from how smart the model is, but from the four-step order: "persist input first, acquire lease before execution, record tools first, wrap up before finishing."**

---

## 9. One-Page Code Map

```text
hermes_cli/main.py                    cmd_chat
hermes_cli/cli_chat_turn_mixin.py     CLI chat
hermes_cli/gateway_agent.py           CLI side GatewayAgent
gateway/session_authority.py          admission / authority
gateway/run_turn_runner.py            TurnRunner
agent/turn_facade.py                  Turn facade
agent/turn_facade_lease.py            lease / refresher / watchdog
agent/conversation_loop.py            turn loop
agent/turn_context.py                 context / wire messages
agent/system_prompt.py                three prompt tiers
agent/context_compressor.py           compression / rotation
agent/turn_preflight.py               preflight gate
agent/turn_tool_round.py              persist-before-execute
agent/tool_executor.py                concurrent/sequential execution
toolsets.py                           toolset resolution
model_tools.py                        tool definitions / dispatch
providers/base.py                     ProviderProfile
providers/__init__.py                 provider discovery
agent/credential_pool.py              credential states
hermes_state_common.py                schema 32
hermes_state.py                       SessionDB facade
plugins/plugin_loader.py              plugin loading
cron/scheduler.py                     durable cron
tui_gateway/                          TUI/Desktop backend
```

---

*Written based on the Hermes Agent 0.22.5 release source code · 2026-10-31*
