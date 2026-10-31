---
title: "Hermes Agent 0.22.5 Core Mechanism"
description: "Sort out synchronous loops, context compression, tool execution, credential pools, recovery, and platform expansion."
---

> Baseline: `hermes-agent-0.22.5` release archive, `hermes_cli/__init__.py` of `__release_date__ = "2026.9.24"`. The archive does not include `.git`, so this article does not invent tags/commits; `version = "0.0.0"` in `pyproject.toml` is a build placeholder, not a release version. 
> All source paths in this article are relative to `$HERMES_SRC`.
> First read `overview.md` and `turn-lifecycle.md`, then look at this one.

## 0. One-Page Overview of the Model

The place where Hermes is most easily misread is treating it as "a CLI TTS model." A more accurate mental model is:

```text
Client: CLI / TUI / Desktop / Telegram / Discord ...
   │  prompt.submit / slash / event
   ▼
Gateway:adapter → durable admission FIFO → TurnRunner
   │
   ▼
AIAgent:TurnFacade → durable lease → conversation loop
   │                 │              │
   │                 │              ├─ context compressor
   │                 │              ├─ provider / tools
   │                 │              └─ SessionDB / event stream
   │                 └─ liveness watchdog
   ▼
Event stream / transcript / final reply → client
```

In one sentence:

> **Session is a ledger, Turn is a transaction, Admission is a queue number, Lease is a room card, Transcript is a fact that has occurred, Event is a fact that is occurring.**

| Object | What facts it owns | Most easily confused as |
| --- | --- | --- |
| Session | cross-turn transcripts, model configuration, system prompt, parent-child session relationships | a single message / a running coroutine |
| Turn | identity of a single execution, lease, iteration, tool round, terminal state | the Session itself |
| Admission | whether the input is accepted, queue order, queue/steer/redirect intent | in-memory queue |
| Lease | which process/owner currently has the right to advance this session | permanent lock |
| Transcript | canonical message paired with tool calls/results | projection of this prompt |
| Event | streaming progress, tool events, status notifications | durable history |
| Compression | turning old context into a summary and possibly rotating the session | simple message deletion |

When reading this piece, always ask three things:

1. Who wrote this fact? Is it a projection or canonical state?
2. If the process crashes here, where can the next owner resume from?
3. Will this change cause the same history to generate different bytes in two API calls, breaking the prompt cache?

---

## 1. Loop: Where a Turn starts and where it ends

### 1.1 Problem

The difficulty of the agent loop is not about "continue while there is a tool_call," but rather:

- Who ensures that only one writer exists per session?
- In what order do model calls, tool side effects, and transcript writing occur?
- How are budget, cancellation, fallback, compression, and persistence failures finalized?
- After a process crashes, how does the next owner know where the previous one left off?

Hermes' answer is not to shove these problems into a big loop, but to make a single turn into a transaction with pre-admission, execution body, and finalization.

### 1.2 Mental Model: A Turn is a session transaction with a room card

```text
Input has been persisted
  → Acquire/Wait for session turn lease
  → Build the context for this round (the system prompt is only built once)
  → preflight compression
  → API call
  Tool rounds (first record, then execute)
  → normalize / finalize
  Persistent transcript / usage / event
  → Release lease, scope, watchdog
```

A lease is not "performance optimization," but a fact of cross-process ownership. The TTL defaults to 300 seconds, with a maximum wait of 1800 seconds and a normal refresh interval of 60 seconds; a refresh failure will interrupt the turn, rather than continuing to write a transcript it no longer owns. The liveness watchdog handles the situation where "the process is still running, the event loop is stuck, and the refresh coroutine has also stopped."

### 1.3 Main Source Code Line

**Execution Core**:

- `run_agent.py:214`: `class AIAgent`, combining capabilities through mixins.
- `run_agent.py:241`: `max_iterations: int = sys.maxsize`. Note: this is the kernel default value and does not mean the host will run indefinitely; Gateway/TUI will provide a smaller budget, such as TUI's `_cfg_max_turns(cfg, 500)`.
- `agent/turn_facade.py:22`: `TurnFacadeMixin.run_conversation()`, responsible for admission, lease, relay/accounting/portal scope, and final cleanup.
- `agent/conversation_loop.py:1785`: `run_conversation()`; the real turn body is in `_run_conversation_turn()` (about `:1623`).
- `agent/turn_facade_lease.py:26-27`: `LEASE_TTL_SECONDS = 300.0`, `LEASE_WAIT_SECONDS = 1800.0`.
- `agent/turn_facade_lease.py:34`: `DurableTurnLease`; `:297`: `admit_durable_turn_lease()`.

**On the Gateway side**:

- `gateway/run.py:3339`: `GatewayRunner`.
- `gateway/run_turn.py:1165`: constructs `TurnRunner`.
- `gateway/run_turn_runner.py:175`: `TurnRunner`.
- `gateway/run_turn_runner.py:998`: calls the real `agent.run_conversation(...)`.

**Key stages of the main loop** (`conversation_loop.py`):

```text
begin_iteration
  → prepare_iteration
  → assemble_api_request
  → run_preflight_gate
  → announce_api_call
  → _run_api_retry_loop
  → apply_retry_restarts
  → normalize_model_response
  → run_tool_round or finish_text_response
  → finalize_turn
```

The corresponding code is about `:1727-1774`. This is a "staged" loop: each stage can return `continue`, `break` or the full result, rather than having all logic overwrite each other in one large `try`. 

### 1.4 The stop condition is not a boolean value

A turn may end for the following reasons: 

- Plain text responses via stop gates; 
- `api_call_count` or `iteration_budget` exhausted; 
- User interruption / lease loss / liveness watchdog; 
- Compression timeout or blockage; 
- Guardrail halt tool; 
- Transcript persistence failure; 
- Provider terminal errors, retry exhaustion, fallback failures; 
- Recovery paths such as empty response and repeated output still fail. 

Do not record all of this as `error` or `success`. Reliable systems must retain **end reasons**; otherwise, recovery strategies may treat "budget stop" as "model failure" or "persistence failure" as "safe retry". 

### 1.5 Design Trade-offs

- **Kernel default infinite iteration, host sets budget**: Facilitates reuse by sub-agents/batch processors, but requires the host to truly be responsible for the cost ceiling. 
- **Synchronous turn, not resident coroutine**: Simplifies transcript order and lease lifecycle, at the cost of long tool calls occupying the worker. 
- **Staged Loops**: Each stage can be tested and recovered, at the cost of more state fields and return protocols. 

### 1.6 Common Misconceptions

| Misunderstanding | Fact |
| --- | --- |
| `run_conversation()` is a large function | in AIAgent. It is a facade, and the true loop is in `agent/conversation_loop.py` |
| `max_iterations` Default 500 | The default code is `sys.maxsize`; 500 is the policy value passed in by certain hosts |
| Lease is just a database lock | It also determines whether persistence can continue after interruption or loss of privilege, and when a new owner can take over |
| When the model stops outputting, turn ends | You also need finalize, persist, deliver events, and clean up resources |

--- 

## 2. Context: The model does not see `messages` as is

### 2.1 Issues

The same session must meet three conflicting objectives in each API call round: 

1. Allow the model to see sufficient historical and instrumental results; 
2. Does not burst the context window; 
3. Try to stabilize the prefix bytes and hit the provider's prefix cache. 

Hermes solves by splitting "display history," "API playback history," and "current wire copy," and explicitly changes the session boundaries during compression. 

### 2.2 Mental Model: Three Layers of Prompts + Three Messages

**System prompt three-layer**(`agent/system_prompt.py:736`): 

- `stable`: identity, guidance, coding brief, fixed skills guidance, etc.; 
- `context`: Caller `system_message`, project context file, workspace snapshot; 
- `volatile`: skills index, memory, user profile, external memory, profile row, timestamp, runtime hints. 

The more unstable the content, the later it moves back, so the stable prefix can be reused; Only compression triggers `invalidate_system_prompt()`(`:814`) reconstruction. 

**Three Types of Messages**: 

| Form | Where to store | Purpose |
| --- | --- | --- |
| `content` | SessionDB `messages` | Canonical content displayed/audited |
| `api_content` | SessionDB `messages` sidecar | Stable API shape for provider playback |
| wire copy | This request memory | The actual request copy after compression, budgeting, hooking, and provider adaptation |

`build_api_messages()` in `agent/turn_context.py:1243`. It does not send the DB lines as they are, but reassembles wire messages according to the context of this round; However, the historical prefix must match the persistent playback, otherwise the resume will exhibit byte branching midway. 

### 2.3 Source Code Main Storyline

**Turn context**: 

- `agent/turn_context.py:1036`:`build_turn_context()`.  
- Order is very important: **Build the system prompt first, then create/bind the DB session row**. If the other way around, the session row may record `system_prompt=NULL`, and the next round may not be able to reuse the same prompt, causing cache miss or missing constraints. 
- Workspace snapshot freezes by session, and the cache key contains cwd; This way, multiple API calls in the same round won't override prefixes due to changes in the working directory. 

**Context Documents**: 

- `agent/prompt_builder.py:41`:`_CONTEXT_FILE_READ_TIMEOUT_SECS = 5.0`.  
- `CONTEXT_FILE_MAX_CHARS = 20_000`.  
- The dynamic limit is about 6% of the context window, with a maximum of 500,000 characters. 
- Reading timeout will degrade and cause diagnostics; turn should not be blocked indefinitely. 

**Compression**:

- `agent/context_engine.py:48`: `ContextEngine` base class default `0.75 / protect_first_n=3 / protect_last_n=6`, only used when the plugin engine does not override it.  
- `agent/context_compressor.py:2152`: `ContextCompressor`.  
- `__init__` defaults to `threshold_percent=0.50`, `protect_first_n=3`, `protect_last_n=20`, `summary_target_ratio=0.20`.  
- The default value of `hermes_cli/config_defaults.py` is also `threshold 0.50 / target_ratio 0.20 / protect_last_n 20 / protect_first_n 3 / tail_mode lean`.  
- Small windows have a raise-only lower threshold (about 0.75) to avoid triggering too early when the window is very small; it is 'only raise, do not lower what the user explicitly set'.  
- `should_compress()` in `context_compressor.py:3002`, `compress()` in `:5447`.

**Compressed session rotation**:

Compression can rotate out a child session along `parent_session_id`. This way the transcript of the old session remains unchanged, and the new session continues from the summary while keeping the tail context.

- `compression_locks` table ensures only one compressor exists per session at a time;  
- Compression failures have a cooldown to prevent repeated failures on every API call;  
- Successful compression invalidates the system prompt and rebuilds it;  
- If compression does not actually call the provider, the API call budget needs to be refunded.

### 2.4 Preflight gate: the gate before each API call

`agent/turn_preflight.py:57`'s `run_preflight_compression()` first checks:

```text
compression_enabled?
Number of messages > 1?
Did this round of compression attempt not exceed the limit?
Is there a first request pending without a review fork?
No failure cooldown?
should_compress(pressure)?
```

Only attempt compression after the conditions are met. The process is:

1. Try to expand the window for the managed local llama.cpp first (last resort);
2. Otherwise, compress the messages;
3. Re-measure after compression, `continue` return to the main loop;
4. If compression does not actually reach the provider, refund the API call;
5. If the provider has already indicated overflow, do not retry indefinitely; fail closed if necessary.

### 2.5 Design Trade-offs

- **Stable prefix first**: Sacrifice the immediacy of "inserting the latest environment each round" in exchange for cache hits and interpretability.
- **Compression is lossy**: Preserve the beginning and end, summarize the middle, fix orphan tool pairs; cannot promise complete restoration of every original sentence.
- **Rotate sessions instead of deleting history in place**: Increases the complexity of parent-child sessions and projections, but preserves auditable original transcripts.

### 2.6 Common Misunderstandings

| Misunderstanding | Fact |
| --- | --- |
| `content` is just the text sent to the model | There are also `api_content` and the current wire copy |
| Compression just deletes old messages | It generates summaries, protects the beginning and end, fixes tool pairings, and may rotate sessions |
| Default threshold is fixed at 75% | Built-in compressor defaults to 50%; only small windows might be raised to about 75% |
| memory/skill is the current context | They affect the volatile layer of the prompt; the current request sees the assembled wire copy |
| System prompt can be recalculated each round | Only rebuilt when the session is established or after compression, otherwise it breaks the prefix cache |

---

## 3. Tools: From Registration to Execution, Every Layer Must Have Ownership

### 3.1 Problems

The tool system needs to solve simultaneously:

- Too many tools, causing explosion of prompt/schema costs;
- Which tools are available in the current session/platform;
- Whether the tool calls generated by the model are legal and authorized;
- Tool side effects and transcript order;
- How to maintain original order during concurrent execution;
- How to wrap up approvals, guardrails, cancellations, and persistent failures.

### 3.2 Mental Model: Tools are "assembled"

```text
Tool Definition/Registration
  → toolsets.resolve_toolset()
  → model_tools.get_tool_definitions()
  → schema cache / tool search / connectors
  → Model Selection tool call
  → run_tool_round: validate/cap/dedupe
  → First persist assistant(tool_calls)
  Execute (concurrently or serially)
  → Result pairing, budget, checkpoint
  → Persist as role=tool
  → Back to the next round API
```

"'Tool existence' does not equal 'available this turn'; 'available this turn' also does not equal 'this call is allowed.' These three layers must be distinguished.

### 3.3 Mainline Source Code

**Toolset**:

- `toolsets.py:11`: `_HERMES_CORE_TOOLS`.
- `toolsets.py:74`: `TOOLSETS`.
- `toolsets.py:366`: `resolve_toolset()`, recursively handles `includes`, safe for cycle/diamond, with registry generation caching.
- `"all"` / `"*"` skip session-platform gated toolsets and will not unconditionally expose all platform tools to all sessions.

**Tool Definition**:

- `model_tools.py:215`: `get_tool_definitions()`.
- `model_tools.py:500`: `_compute_tool_definitions()`.
- `model_tools.py:873`: `handle_function_call()`.
- The schema cache keeps at most 8 warm combinations; tool search bridges, connectors, middleware, hooks, approvals, guardrails, and `transform_tool_result` converge at this layer.

**Tool Turns** (`agent/turn_tool_round.py:49`):

1. validate, cap, dedupe;
2. **persist tool-call turn before any side effects**;
3. execute tools;
4. handle guardrail/persistence failures;
5. compress again after tool results.

Key invariants:

- canonical DB append failure → end turn, mark `session_persistence_failed`;
- tool result cannot be canonically persisted → do not send in-memory results back to the model;
- invalid tool calls in mixed batches still generate matching tool results, but just aren't dispatched;
- guardrail halt produces a controlled halt response;
- only when `execute_code` is in a single batch is the iteration budget refunded;
- post-tool compression is required even after tool results.

**Executor** (`agent/tool_executor.py`):

- `_MAX_TOOL_WORKERS = 8` (`:134`);
- `_DEFAULT_CONCURRENT_TOOL_TIMEOUT_S = 420.0`;
- `_START_ORDER_GATE_TIMEOUT_S = 120.0`;
- `_AUTHORIZATION_GATE_LOCK_TIMEOUT_S = 360.0`;
- `execute_tool_calls_concurrent()` (`:1585`), `execute_tool_calls_sequential()` (`:1865`), `execute_tool_calls_segmented()` (`:1935`);
- Concurrent results are backfilled by original tool call order, not by completion time.
- After an interrupt, skipped results are provided for unexecuted calls.
- File mutation tools perform checkpoints.

### 3.4 Design Trade-offs

- **persist-before-execute**: One extra DB write in exchange for auditable, recoverable side effect boundaries after a crash.
- **Concurrency limits and sequential backfilling**: Sacrifices some scheduling flexibility but protects transcript and result protocols.
- **Delayed tool discovery**: The model first sees core tools and search entry points, reducing schema/token costs but adds an extra discovery step.

### 3.5 Common Misunderstandings

| Misunderstanding | Reality |
| --- | --- |
| Tool calls execute first, then logs are filled | Must persist the tool-call turn before executing |
| Tool failures can skip writing results | Calls/results must be paired; invalid calls still need matching results |
| Concurrent completion order equals result order | Results are backfilled according to original call order |
| More tools make the model stronger | Tool text and JSON schema are dual context costs and also expand misselection/attack surface |
| Guardrails just alert the model | They can produce controlled halts, ending the current turn |

---

## 4. Model Integration: Provider is a contract, not scattered if/else

### 4.1 Problem

Different providers vary in authentication, API shape, streaming, tool messages, prompt caching, token counting, error semantics, and fallback. Encoding these differences directly into the Agent loop will turn the main loop into an unmaintainable branch tree.

### 4.2 Mental Model

```text
ProviderProfile (declarative metadata)
  → Certification/Credential Pool
  → API mode adapter(chat/responses/messages/converse/gemini)
  → request builder
  → streaming accumulator / error classifier
  → retry / rotate credential / fallback
  → normalized response
```

Core Principle: **Provider semantics belong to the provider layer, and the loop only consumes a unified contract.**

### 4.3 Main Source Code Flow

- `providers/base.py:42`: `ProviderProfile`.
  - Declare `name/api_mode/aliases/env_vars/base_url/models_url/auth_type/streaming/vision/tool-message/prompt-cache-key/model aliases/default headers/temperature/token quirks/aux model/model capabilities`.
  - Optionally override `prepare_messages/build_extra_body/build_api_kwargs_extras/create_client`.
  - `auth_type` supports `api_key`, `oauth_device_code`, `oauth_external`, `copilot`, `aws_sdk`, `external_process`.
- `providers/__init__.py`: Discovery order includes bundled plugins, `$HERMES_HOME/plugins/model-providers/`, pip entry points, legacy `providers/*.py`; lazy discovery; user plugins can override bundled ones; multiple profile home layers must be explicitly bound.
- `agent/credential_pool.py`:
  - `STATUS_OK`, `STATUS_EXHAUSTED`, `STATUS_DEAD`;
  - Terminal OAuth failure enters DEAD, not ordinary exhausted;
  - Strategy `fill_first / round_robin / random / least_used`;
  - TTL: 401 about 5 minutes, 429/default about 1 hour.
- `agent/chat_completion_helpers.py`: Unified handling of `chat_completions`, `codex_responses`, `anthropic_messages`, `bedrock_converse`, native Gemini, as well as streaming accumulator, SSE error, stream fallback, watchdog.

### 4.4 Retry and Fallback Order

- `agent/turn_api_error.py:52`: `handle_api_error()`.
- `agent/turn_retry_state.py`: `TurnRetryState`.
- `agent/turn_response_intake.py:120`: `normalize_model_response()`.
- `agent/turn_final_response.py:56`: `finish_text_response()`.

Errors are first categorized, then decide:

1. Whether to retry;
2. Whether to rotate credentials;
3. Whether to compress/overflow recovery;
4. Whether to fallback model/provider;
5. Whether to fail immediately.

Fallback must set `restart_with_rebuilt_messages`, return to preflight to recompute context, and cannot directly continue with a new provider using old wire messages. Otherwise, window, prompt, tool schema, compression state, and provider-specific fields may be inconsistent.

### 4.5 Design Trade-offs

- **Declarative Provider**: Adding a new provider does not require changes to the core loop, but profile fields and adapter contracts are more complex.
- **Credential Pool Rotation**: Improves availability, with the cost of distinguishing temporary 429 from permanent OAuth failures, and preventing the same entry from refreshing repeatedly.
- **Fallback to Preflight**: Builds context one more time for correct window/cache/message structure.

### 4.6 Common Misunderstandings

| Misunderstanding | Reality |
| --- | --- |
| Switching providers is just changing base_url | Also need to switch API mode, message format, authentication, tool/cache semantics |
| 429 is the same as OAuth expiration | The former is usually recoverable/cooldown, the latter may be DEAD |
| Old messages can be used after fallback | Wire messages must be rebuilt and preflight rerun |
| Provider profile is user prompt | It is a machine contract; keys or private reasoning should not be written into the public projection |

---

## 5. SessionDB: Not Just Chat History, But Cross-Process Session Authority

### 5.1 Problem

If `state.db` only stores chat text, then the following problems have no answers:

- If two processes receive input from the same session at the same time, which one executes first?  
- After a process crashes, is a given request 'not yet started' or 'started but not finished'?  
- How far have the cron/child/kanban workers executed?  
- Which process is currently compressing this session?  
- Is the heartbeat of the old backend still active, and can its orphan sessions be safely cleaned up?  
- Will the new owner reuse a prompt-cache affinity that has already been retired?  

Hermes's SessionDB simultaneously handles transcript, admission, lease, worker receipt, compression locks, and generation fence.  

### 5.2 Mental Model: Five types of tables, five kinds of facts

```text
transcript Facts: sessions / messages / system_prompts / usage
Admission Fact: session_admissions
Execution facts: worker_executions / worker_receipts
Ownership Facts: session_turn_leases / compression_locks / gateway_heartbeats
Identity and Generational Facts: runtime_epoch / conversation_generations / async_delegations
```

### 5.3 Main Source Code Line

- `hermes_state_common.py:289`: `SCHEMA_VERSION = 32`.
- `:312`: `FTS_STORAGE_VERSION = 3`.
- `:452+`: `SCHEMA_SQL`.
- `hermes_state.py` Module documentation explanation: SQLite, WAL (concurrent reader single writer), compression via `parent_session_id` chain linking session, source tag such as `cli` / `telegram`.

Key Tables:

| Table | What question it answers |
| --- | --- |
| `sessions` | Which session, model/configuration, system prompt, parent-child relationship, usage, compression status, cwd/git |
| `messages` | Messages that have occurred, tool call/result, `api_content`, display metadata, UID, active/compacted |
| `system_prompts` | Prompt bytes deduplicated by hash, for session reuse |
| `session_admissions` | Whether input was accepted, queue order, queue/steer/redirect, started/unknown/terminal |
| `session_model_usage` | API calls and tokens accumulated by model/billing dimension |
| `worker_executions` | Cron/child/compute/kanban execution identity and status |
| `worker_receipts` | Sequence number, digest, result output by each worker |
| `compression_locks` | Current compressor and expiration time for the same session |
| `session_turn_leases` | Current turn holder and expiration time for the same conversation |
| `gateway_heartbeats` | Whether backend process is still alive, for orphan cleanup judgment |
| `conversation_generations` | Monotonic generation, to prevent ABA reuse of prompt-cache affinity |
| `async_delegations` | Status, result, delivery, and owner fence of background delegation |

Key Constraints of `session_admissions`:

```text
intent ∈ queue | steer | redirect
status ∈ queued | started | unknown | terminal
UNIQUE(principal_id, target_session_id, request_id)
```

`UNIQUE` Each principal, each session, and each request id can only have one admission; `unknown` leaves a legal state for "submission/start boundary uncertain," requiring reconciliation rather than guessing.

`SessionAuthority` at `gateway/session_authority.py:121`, `submit()` at `:636`, `_submit()` at `:656`. Backend completion notifications enter the same durable FIFO through `admit_internal_event`, without bypassing admission.

### 5.4 Why these tables cannot be merged

Their change frequency, lock granularity, and recovery semantics differ:

- Transcript is append/compress, emphasizing replayable history;
- Admission is FIFO + deduplication, emphasizing order and idempotency;
- Lease is short TTL ownership, emphasizing expiration;
- Worker receipt is execution sequence, emphasizing resume;
- Generation is a never-reused counter, cannot be pruned.

Merging would easily let "cleaning old messages" delete ownership facts, or let "UI looks idle" override the canonical state.

### 5.5 Design trade-offs

- **SQLite + WAL**: Simple deployment, reliable on a single machine, at the cost of needing extra architecture for cross-machine/high concurrency.
- **Multiple tables + transactions**: Clear boundaries, recoverable, at the cost of more complex schema/migration and cross-table invariants.
- **Unknown state**: Allows the system to acknowledge uncertainty, avoiding duplicates or loss, at the cost of requiring reconciliation logic.

### 5.6 Common misconceptions

| Misconception | Fact |
| --- | --- |
| `state.db` is just chat history | It is also authoritative for admission/lease/receipt/compression/generation |
| Transaction failure means nothing happened | External side effects may have occurred, requiring readback/idempotency |
| `unknown` can be arbitrarily put into queued | This causes repeated execution; putting in terminal loses work |
| Compression is just a DB update | It also requires locking, session rotation, event/transcript consistency, and prompt reconstruction |
| Multiple profiles sharing one process is fine | Profiles/home scope must be explicitly bound, otherwise states will mix |

---

## 6. Extensions: which layer plugin, skill, MCP, subagent, cron, kanban extend

### 6.1 Clarify per table

| Extension area | Extends what | Does not extend | Main source |
| --- | --- | --- | --- |
| Plugin | In-process capability registration: provider/channel/tool/hook/context engine, etc. | Not process-isolated sandbox | `plugins/plugin_loader.py` |
| Skill | Methods, processes, templates, scripts, etc., knowledge packages loadable on demand | Does not grant tool execution permission | `skills/`, `optional-skills/` |
| MCP | External tools/resources/prompt protocols | Not a backdoor to bypass policy/approval | `tools/mcp_*`, `optional-mcps/` |
| Subagent / delegation | Controlled sub-task execution within the same process | Not cross-restart durable work queue | `tools/delegate_tool*`, `agent/delegation_*`, `agent/subagent_lifecycle.py` |
| Cron | Persistent scheduled tasks and gateway ticker | Not a one-off chat turn | `cron/scheduler.py` and `scheduler_*` |
| Kanban | Durable multi-agent task queue/board | Not a read-only UI projection | `plugins/kanban/`, related tools |

### 6.2 Plugin

`plugins/plugin_loader.py` loading logic has several engineering details:

- Load plugins by directory, using composite packages to make relative imports work;
- Support `register(ctx)` and ABC subclass fallback;
- Detect cross-thread load deadlocks;
- Has bounded load wait to prevent one plugin from blocking the whole agent build;
- User plugins can override bundled implementations, but override order must be clear.

Built-in plugins include browser, computer_use, context_engine, cron_providers, delegation, image_gen, kanban, memory, model-providers, platforms, web, video_gen, etc. Plugins are **trusted in-process**: they can register capabilities, which also means they can execute arbitrary Python; do not mistake the "plugin system" for a security sandbox.

### 6.3 Skill

- `skills/` are built-in skills; `optional-skills/` are installed on demand.
- Skills index enters the system prompt's volatile tier, so skill changes should not break the stable prefix.
- `SOUL.md` is a persona, not a skill.
- Skill usually reads via tools like `skill_view`; it extends "how to do," and does not automatically grant "what you can do."

### 6.4 MCP

- MCP connections, tool discovery, and invocation are in `tools/mcp_*`.
- `optional-mcps/` provides on-demand configuration.
- MCP tools still require tool policy, approval, schema validation, and result budgeting.
- When a connection fails, the catalog may remain but execution is unavailable; recovery should follow backoff and explicit reload.

### 6.5 Subagent / delegation

- Relevant implementations are distributed in `tools/delegate_tool*`, `agent/delegation_*`, `agent/subagent_lifecycle.py`.
- Subagents have independent sessions/lifecycles but share the parent process and a set of controlled resources.
- **Background delegation is process-local**: after a process restart, it cannot be assumed to continue.
- Persistent work across restarts should use cron or paths like `terminal(background=True, notify_on_complete=True)` with durable semantics.
- The end of the parent turn does not necessarily end the child; announce, cascade stop, and orphan must be explicitly handled.

### 6.6 Cron

- `cron/scheduler.py` is a facade, specifically implemented in `scheduler_*`.
- Jobs are persisted in SQLite; the gateway contains dispatcher/ticker.
- Inactivity watchdog defaults to about 600 seconds.
- Supports catch-up and per-home tick lock; headless ticks cannot be spawned arbitrarily.
- The key of cron is not "timer," but claim, heartbeat, dead-owner reclaim, and idempotent fire.

### 6.7 Kanban

Kanban is another durable multi-agent queue: card/task status must be translated into canonical transitions; UI drag-and-drop cannot be taken directly as fact. It is suitable for long-task collaboration and not suitable as "another name for subagent."

### 6.8 Design trade-offs

- **In-process plugin**: deep integration, low latency, cost is weak trust boundaries.
- **Skill external**: context loaded on demand, cost is discovery and version management.
- **Subagent process-local**: simple, cost is cannot naturally survive restarts.
- **Cron/Kanban durable**: high reliability, cost is claim, receipt, recovery, and database schema complexity.

### 6.9 Common misconceptions

| Misconception | Reality |
| --- | --- |
| Plugin equals sandbox | Plugin is in-process code execution |
| Skill is tool permission | Skill is knowledge/process; permissions are still determined by tool policy |
| MCP connects and can execute immediately | Still must go through the unified toolchain and approval |
| Subagent always continues across restarts | Background delegation is process-local |
| Scheduled job is just a `sleep` call afterward | Also includes persistent jobs, claim, heartbeat, catch-up, and dead-owner reclaim |

---

## 7. Interface: TypeScript handles only the screen, Python handles semantics

### 7.1 Three interfaces share the same backend

```text
Classic CLI
  └─ GatewayAgent ── prompt.submit ── Gateway process (real AIAgent)

TUI
  └─ Node/Ink ── stdio JSON-RPC ── tui_gateway(Python)── AIAgent

Desktop
  └─ WebSocket JSON-RPC ── same tui_gateway / Gateway backend

Dashboard
  └─ PTY embed real TUI, do not write a separate set Agent
```

Written very clearly:

```text
hermes --tui
  └─ Node (Ink) ──stdio JSON-RPC── Python (tui_gateway)
                          └─ AIAgent + tools + sessions
```

### 7.2 Source Code Main Storyline

- `tui_gateway/agent_factory.py:637`:`from run_agent import AIAgent`.  
- `:655`: Constructs `AIAgent(...)`. 
- TUI's RPC methods are themed under `methods_<topic>.py`, such as config, complete, browser, bot relay, etc. 
- wire contract: Define and generate TypeScript in Python, avoiding the need to write a separate schema for both the front and back ends. 
- server→client request is used for approval, clarify, sudo, secret, vault, connection, etc.; the client can reject or timeout, but the Python side must fail closed. 
- Desktop connects via the same WebSocket; Dashboard embeds the TUI via PTY. 

### 7.3 Key Boundaries

- TypeScript does not have session, tool, model, or slash logic; It only renders and collects inputs. 
- Python does not have a screen layout; It expresses state through event/RPC. 
- New RPC methods should be created or extended `methods_<topic>.py` and synchronized with protocol generation/testing. 
- When a process serves multiple profiles, each RPC must explicitly bind the profile scope; otherwise, it will read the session/model of another home. 

### 7.4 Design Trade-offs

- **stdio JSON-RPC**: Simple, testable, and suitable for Ink, but at the cost of cross-language protocol maintenance. 
- **WebSocket Desktop**: Supports remote and multi-client support, but at the cost of permissions, reconnections, and snapshot consistency. 
- **Classic CLI proxy to Gateway**: Ensures platform consistency, but at the cost of one extra process/protocol jump. 

### 7.5 Common Misconceptions

| Misunderstanding | Fact |
| --- | --- |
| TUI is another set of Agent | It is only the frontend; the backend is still Python `AIAgent` |
| The frontend can directly change the transcript | The transcript belongs to SessionDB/writer, and the frontend can only send commands |
| RPC methods only need to be changed to Python | Also synchronize wire contracts, TypeScript clients, and tests |
| Multiple profiles only affect the display | It affects session/model/tool/home scope, so you must explicitly bind |

--- 

## 8. Engineering: Reliability comes from sequential and invariants

### 8.1 Six Most Important Invariants

1. **Persistence of Input First**: Admission is a durable FIFO, not a memory queue. 
2. **Execute lease first**: After losing rights, stop writing transcripts, instead of "writing as much as possible." 
3. **Tool Ledger First**: Tool-call turn is placed before side effects. 
4. **End the end first**: finalize, persist, event, lease/scope cleanup order must not be reversed. 
5. **Fallback: Reconstruct context first**: When switching providers, you must re-run the preflight. 
6. **Compression to Edit History**: Normal rounds cannot be rearranged with stable prefix. 

### 8.2 Dependency and Checking

- `pyproject.toml`: Direct dependence on almost all exact pins `==X.Y.Z`. 
- `requires-python = ">=3.11,<3.15"`; The actual main target is 3.14, and 3.11 mainly serves the old updater bridge. 
- `uv.lock` Participate in the hash-verified PM installation. 
- `ruff.toml`:line length 88,target py311.  
- `justfile`:`ruff check` Add ESLint for each JS/TS workspace. 
- `lefthook.yml`:pre-commit lint.  
- `scripts/check`: Blocking lint main entrance. 
- Use `scripts/run_tests.sh` for testing, do not bare pytest; Point `HERMES_HOME` to the temporary directory during testing to prevent contamination of the actual state. 

### 8.3 Several hard rules for `AGENTS.md`.

- Prompt cache is sacred and cannot be arbitrarily changed to stable prefix; 
- narrow waist: high threshold for core tools, with capabilities externally extended to CLI skills / service-gated tools / plugins / MCP; 
- When a process serves multiple profiles, it must explicitly bind the profile scope; 
- Depends on exact pin; 
- Write behavioral contract tests, not change-detector; 
- Do not use the argv substring to determine process identity; 
- Not hardcoded `~/.hermes`. 

### 8.4 The "First Scene" of Common Faults

| Symptom | First Check |
| --- | --- |
| turn keeps waiting | lease waiting, admission, session lane |
| tool executed but no UI result | tool result persistence, event stream, transcript tail |
| context overflow after fallback | whether to rerun preflight, whether window is updated |
| compression keeps failing | compression lock, cooldown, summary provider |
| session state wrong after restart | admission unknown, lease, heartbeat, generation |
| prompt cache hit drops | whether system prompt was rebuilt via a non-compression path, whether volatile fields mixed into stable |
| multiple profiles data mixed | whether profile/home scope explicitly bound |

---

## 9. Self-testing and Practice

### Self-testing

1. In which process is the classic CLI `AIAgent.run_conversation()` actually executed?
2. Why is `session_admissions` needed `unknown`?
3. With TTL 300 seconds and refresh 60 seconds, why is a liveness watchdog still needed?
4. What goes into the three layers of the system prompt? Why must the prompt be constructed before creating the session row?
5. What are the differences between `content`, `api_content`, and wire copy?
6. What are the default thresholds and protected head/tail of compression? Why is session rotation and `compression_locks` needed?
7. Why must tools be persisted before execution? Why can't memory results be sent to the model if persistence fails?
8. Why must fallback return to preflight?
9. How does `toolsets.resolve_toolset()` handle include, loops, and platform gating?
10. What is the provider discovery order? What are the three states of the credential pool and common strategies?
11. Which layer does each extension apply to: plugin, skill, MCP, subagent, cron, kanban?
12. What are the responsibility boundaries of TUI/Desktop/Classic CLI? What errors are most common with multiple profiles?

### Reference Answers

1. In the Gateway process. The classic CLI only runs `GatewayAgent`, which submits `prompt.submit`, replays events, and renders results; the real `TurnRunner` and `AIAgent` are in the Gateway.
2. Because the submit/start boundary can crash or fail to confirm. Treat it as queued for repeated execution; when it's terminal, work may be lost; `unknown` requires readback/reconcile, acknowledging uncertainty.
3. TTL can only handle "owner stops renewing"; watchdog can also detect if the process is alive but the event loop/refresh coroutine is stuck, or the DB/network is blocked, allowing earlier interruption to prevent the stale owner from continuing to write.
4. `stable` contains stable content like identity, guidance, coding brief; `context` contains caller system messages, project context files, workspace snapshot; `volatile` contains skills index, memory, profile, timestamp, runtime hints. Build the prompt first, then the row, so that the same prompt/hash can be bound to the session; doing it the other way may write to `NULL`, causing cache miss or missing constraints.
5. `content` is canonical content for display/audit; `api_content` is a stable sidecar for provider replay; wire copy is a temporary copy of this request after compression, budgeting, hook, provider adaptation, and is not written back to the transcript.
6. The built-in compressor defaults to `threshold=0.50`, `protect_first_n=3`, `protect_last_n=20`, `summary_target_ratio=0.20`, `tail_mode=lean`; a small window may raise the threshold to about 0.75. Use `parent_session_id` to keep the original transcript when rotating, `compression_locks` ensures only one compressor per session, with failure cooldown to prevent repeatedly hitting the same fault.
7. Persist the tool-call turn first to leave canonical intent before side effects; after a crash, unfinished calls can be tracked. If canonical append fails, the transcript cannot prove this call existed, memory results are unreliable, cannot be sent to the model, nor can side effects be pretended not to occur.
8. Because after fallback, the window, API mode, message shape, prompt/tool schema, and compression state may all change; if preflight is not rerun, it may overflow, send wrong fields, or break the cache. You must `restart_with_rebuilt_messages`.
9. Recursively parse `includes`, safe for cycle/diamond, with registry generation cache; `all/*` will skip session-platform gated toolsets and will not expose all platform tools unconditionally.
10. Discovery order: bundled plugins → `$HERMES_HOME/plugins/model-providers/` → pip entry points → old `providers/*.py`; lazy discovery, user plugins can override bundled. Credential pool state `ok/exhausted/dead`, policy `fill_first/round_robin/random/least_used`.
11. Plugin is in-process capability registration; Skill is knowledge/process package; MCP is external tool protocol; Subagent is in-process controlled subtask; Cron is durable scheduled task; Kanban is durable multi-Agent queue. They cannot replace each other.
12. TypeScript/CLI handles screen, input, and event rendering; Python handles session, tool, model, slash, and persistence. When multiple profiles share a process, any RPC/tool/session operation must explicitly bind to profile/home scope, otherwise states may mix.

### Exercises

1. Pick a real or test turn, draw the event sequence from admission → lease → context → API → tool → finalize, and mark which fact is written to which table.
2. Manually kill the process after tool side effects and before tool result writes to disk; after restart, write what facts you should see and should not see.
3. Construct a stale session prompt, observe changes in stable/context/volatile before and after compression; explain which changes are allowed.
4. Add an invalid call to a mixed tool batch, verify it still generates matching results but is not dispatched.
5. Add a minimal RPC method, requiring synchronization of wire contract, Python handler, TypeScript client, and test.

### Exercise Reference Answers and Acceptance Points

1. **Checkpoints**: admission at `session_admissions`; lease at `session_turn_leases`; system prompt/hash at `sessions/system_prompts`; message and tool pair at `messages`; usage at `session_model_usage`; compression lock at `compression_locks`. The diagram should distinguish between event and transcript.
2. **Should see**: persisted user/assistant tool-call, unclosed turn, lease/admission status, possible tool side effects. **Should not see**: fabricated tool result, successful final state, delivered final response, automatic rerun deletion operations. Recovery should first perform readback/idempotent check, then decide whether to retry or mark as unknown.
3. **Checkpoints**: only compression is allowed to reconstruct the system prompt; the stable prefix should match as much as possible in bytes, changes in context/volatile should correspond to compression/permissions/runtime facts. If stable is changed in a normal turn, it is considered cache degradation.
4. **Checkpoints**: assistant retains all calls; each call has a matching tool result; the result of invalid calls is error/not dispatched, not disappearance; in the DB, call/result UIDs come in pairs.
5. **Checkpoints**: Python methods are the only semantic implementation, wire schema generates TypeScript; the client can handle server→client requests/timeouts; there are protocol coverage tests and multi-profile scope tests.

---

## 10. One-page code map

```text
run_agent.py                          AIAgent / mixin combination
agent/turn_facade.py                  run_conversation facade
agent/turn_facade_lease.py            durable lease / refresher / watchdog
Main Loop and Phases
agent/turn_context.py                 build_turn_context / build_api_messages
agent/system_prompt.py                stable/context/volatile prompt
agent/context_compressor.py           Compression / session rotation
agent/turn_preflight.py               API Pre-compression gate
agent/turn_api_request.py             build_api_request
agent/turn_api_call.py                perform_api_call
Error Classification and Recovery
agent/turn_tool_round.py              persist-before-execute
Concurrent/Serial/Segmented Execution
toolsets.py                           toolset analysis
Tool Definition/Distribution
providers/base.py                     ProviderProfile
providers/__init__.py                 provider discovered
Certification Pool
hermes_state_common.py                schema / SQL
gateway/run.py                        GatewayRunner
gateway/run_turn_runner.py            TurnRunner
gateway/session_authority.py          admission/authority
plugin loading
cron/scheduler.py                     durable cron facade
tui_gateway/ TUI/Desktop Python Backend
```

After reading, you should be able to explain in one sentence for each module 'what facts it owns and who can take over if it fails.' If you can only memorize the table of contents, it means you haven't really understood Hermes yet.

---

*Based on the Hermes Agent 0.22.5 source code release · 2026-10-31*
