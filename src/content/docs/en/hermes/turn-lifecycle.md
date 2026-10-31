---
title: "01 · The Life of a Turn"
description: "Track a Turn from admission, lease, and context assembly to tool execution and persistence."
---

> Baseline: `hermes-agent-0.22.5` (release version `v0.22.5`, release date `2026.9.24`). The archive does not include `.git` and does not claim commit/tag.  
> Path relative to `$HERMES_SRC`.  
> This article traces only one line: **how one input becomes a Turn that is accepted, lease-protected, processed by the model, driven by tools, persisted, and ultimately delivered.**  
> After reading, you should be able to accurately describe: where the input comes in, who has the authority to execute, what the model sees this time, how the tool results flow back, and under what conditions the system stops.  

## 0. Mental Model: A Turn is a 'session transaction with a room card'

A regular function call is `call → return`. Hermes's Turn is more like a transaction:

```text
Submission (admission)
  Queue (durable FIFO)
  → Pick up the room card (turn lease)
  → Prepare context (transcript + prompt + compression)
  Loop (model / tool / retry)
  → Finishing (tail +  persist +  usage)
  → Delivery (event / stream / adapter)
```

This transaction chain keeps six types of facts separate:

| Fact | Where It's Stored | Question It Answers |
| --- | --- | --- |
| Whether this input has been accepted | `session_admissions` | Will submitting it twice execute it twice? Is it still there after a crash? |
| Who currently has the right to run this session | `session_turn_leases` | Will two processes write to the same transcript at the same time? |
| What has happened in the conversation so far | `messages` | What should the next round of the model see? |
| What is happening in this turn | event stream | What should the UI display? Who should the approval request be sent to? |
| Whether the context has been compressed | `sessions.parent_session_id` compressor state | Is this the original session or a child spun off? |
| How much this turn cost | usage/cost field and auxiliary ledger | Which model, how many tokens, was there a cache hit? |

So when reading the Turn lifecycle, don't just focus on `agent.run_conversation()`. **What truly makes Hermes a cross-platform product are these five layers: admission, lease, transcript, event, and delivery.**

## 1. Entry: Three doors, one execution core

### 1.1 Classic CLI: Proxy to Gateway

The classic REPL in `hermes` enters `_init_agent()` the first time an Agent is needed:

```python
from hermes_cli.gateway_agent import GatewayAgent as AIAgent  # the gateway runs the turn
```

The module docstring of `GatewayAgent` clearly states:

> The CLI process does not build the agent, does not run tools, and does not write `state.db`; turns run in the gateway.

The call chain is:

```text
hermes_cli/main.py::cmd_chat
  → cli.py::HermesCLI
  → cli_chat_turn_mixin.py::chat()
  → self.agent.run_conversation(...)
  → GatewayAgent.run_conversation(...)
  → connection.call("prompt.submit", ...)
  Replay gateway event stream
  → returns a dict with the same shape as AIAgent.run_conversation
```

Key actions of `GatewayAgent.run_conversation()`:

- First, obtain the session and admission for this turn;
- Submit `prompt.submit` with user messages, history, author, display metadata, and platform message ID;
- Consume `connection.events` on the calling thread, translating `message.delta`, tool progress, approval requests, etc., into CLI callbacks;
- Wait for `message.complete` of this admission or interruption settlement;
- If reconnection/frame loss occurs, try to patch using event sequence numbers and already-seen text (`_paint_owed`) instead of repeating the entire output.

The value of this design is: **The CLI doesn't need to understand the internals of the Agent, only the event contract.** The trade-off is that the CLI must correctly handle disconnections, reconnections, out-of-order, duplicate frames, and approval round trips.

### 1.2 Message Platform: adapter → SessionAuthority

The path of the message platform is closer to the 'server':

```text
gateway/platforms/<platform>.py
  → Analysis Source / Identity / chat_key
  → Enter the adapter _pending_messages when busy
  → SessionAuthority.submit(Principal, Submission)
  → session_admissions(durable FIFO)
  → drain receive
  → TurnRunner.run_sync
  → AIAgent.run_conversation
  → Event / Streaming Output
  → adapter replies to the original channel
```

There are **two** busy message guards in the Gateway:

1. adapter's `_pending_messages`: queues when the session is running;
2. runner's `run_busy.py`: intercepts `/stop`, `/new`, `/queue`, `/status`, `/approve`, `/deny` before the message enters `running_agent.interrupt()`.

If a new command must arrive while the Agent is blocked (especially approval), it must bypass both guards and be dispatched inline, not through `_process_message_background()`, otherwise it will race with the session lifecycle.

### 1.3 TUI / Desktop: Shared Python Backend

The process model of `hermes --tui` is:

```text
Node (Ink)  ──stdio JSON-RPC──  Python (tui_gateway)
   │                                  └─ AIAgent + tools + sessions
   └─ Render transcript / composer / prompts / activity
```

`tui_gateway/agent_factory.py` is built directly `AIAgent`; `tui_gateway/server.py` is the facade of the method/event directory, `methods_*.py` is the RPC implementation for each topic. Desktop connects to the same backend via WebSocket through `apps/shared`'s `JsonRpcGatewayClient`.

The differences between TUI/Desktop and the classic CLI are:

- In the classic CLI, `GatewayAgent` is a **proxy**;
- In TUI/Desktop, the Python backend is the **real host**, and the AIAgent is in this process (or in a compute-host child process);
- Both can bind canonical session authority, but they bind to different transport layers.

The Dashboard embeds the real `hermes --tui` via PTY. It does not rewrite the transcript/composer; any capabilities added to Ink automatically appear in the Dashboard.

## 2. Admission: Input first becomes a "persistent work item"

`gateway/session_authority.py:121`'s `SessionAuthority` has live sessions and canonical durable FIFO. `submit()` is in `:636`, `_submit()` is in `:656`.

### 2.1 Authorize before submission

```text
authorize(actor, request.ref, 'session:submit')
  Check whether the principal has the right to submit to this session
  Authorize again under mutation_lock in →
  Standardized payload
  → admit_session_input(...)
```

Here are two points that are easy to overlook:

- **Permissions are not a payload field.** The client cannot elevate privileges by sending fields like `owner_id`, `local_operator_v1`; the server generates trusted fields based on the principal and session binding.
- **Repeated submissions must be idempotent.** `admission_id`, `request_id`, `payload_digest`, together with unique constraints, ensure that the same request arriving multiple times will not be executed twice.

### 2.2 Payload will be normalized

`_submit()` handles:

- `finite`: one-time viewer/limited rounds;
- `surface`: source aspects;
- `display`: display type and metadata;
- `cli_turn`: CLI-specific parameters;
- `attachments`: attachment capture and persistence;
- `text`: actual user text;
- `voice_context`, `interrupted`, `voice_turn`, `title_preview`, `turn_author`, `api_text`, `model_override`, `clarify_batch`, etc.: optional fields.

Only after normalization is `payload_json` written. This means that **what is queued is the 'server-understood input', not the original HTTP body.**

### 2.3 State machine

`session_admissions.status` has at least four types:

| State | Meaning | Recovery Meaning |
| --- | --- | --- |
| `queued` | Persistently accepted, waiting for drain to take | Can still be taken after restart |
| `started` | Taken and started by an owner | Cannot be taken again; if owner dies, may switch to `unknown` |
| `unknown` | Owner crashed/disconnected, execution result uncertain | Requires recovery scan, manual confirmation, or safe retry |
| `terminal` | Settled (success/failure/cancelled) | Read-only receipt |

`unknown` is a key design: **"Not knowing if it has executed" cannot be treated as "not executed."** For turns with side effects, the system prefers marking it as unknown rather than blindly rerunning it.

### 2.4 Why we cannot use only in-memory queues

Because input may cross processes at the following times:

```text
Received message → Writing to queue → process crashed
```

If the queue is only in memory, messages will be lost. Hermes writes the admission into SQLite and lets drain receive them in `seq` order, so consistency can be maintained across multiprocessing, restarts, and background notifications.

### 2.5 Background events also go through the same entrance

Background processes completing notifications, cron triggers, or sub-Agents reporting back do not "just insert a message directly." They obtain an admission receipt via `admit_internal_event`, then enter the same durable FIFO; if admission is refused, the caller must return the batch it has received rather than pretending it succeeded.

The value of this rule is: **the system has only one "new input" entry, and all inputs are subject to the same queuing, permission, and crash recovery constraints.**

## 3. TurnRunner: The host sets the stage

Gateway's `_run_agent_inner()` is in `gateway/run_turn.py:2293`. It is responsible for:

- Parsing the current round's behavior from the display configuration (streaming, tool progress, interim messages, cleanup);
- Constructing `TurnContext` and `TurnRunner`;
- Binding tool lifecycle callbacks, approval notifications, and progress queues;
- Starting the progress sender, tool log, stream consumer, tracking, interrupt monitor, and long-running notifier;
- Calling `TurnRunner.run_sync`;
- Waiting for the worker to finish, handling interrupts, queued follow-ups, stream finalization, and cleanup.

`TurnRunner` is in `gateway/run_turn_runner.py:175`, and its `:998` call:

```python
result = agent.run_conversation(api_message, **kwargs)
```

Note that the `agent` here is the real `AIAgent` in the Gateway process, not the `GatewayAgent` of the CLI. So the "same input" will go through different entry points in different hosts, but will all land on the same `AIAgent.run_conversation()`.

## 4. TurnFacade: Get the room card first, then start working

The implementation of `AIAgent.run_conversation()` is in `agent/turn_facade.py:22`. Its order is very worth remembering:

```text
1. cancel_background_review_for_live_turn(self)
2. admit_durable_turn_lease(...)
3. If admission returns early_result: bring back the unadmitted user message and return it directly
4. Enter relay / accounting / portal scope
5. lease.start()
6. agent.conversation_loop.run_conversation(...)
7. finally: stop refresher, release lease, clean up scope
```

### 4.1 Why Cancel Background Review First

Background review (memory/skill reflection) might reuse the same `session_id` to keep the prompt cache aligned. If it runs in parallel with the foreground turn, it will compete for the same transcript. `cancel_background_review_for_live_turn()` first gives the review a limited exit window; if it does not exit, the foreground takes priority.

### 4.2 What is a Durable Lease

`agent/turn_facade_lease.py:34`'s `DurableTurnLease`:

- `LEASE_TTL_SECONDS = 300.0`;
- `LEASE_WAIT_SECONDS = 1800.0`;
- By default, it refreshes every 60 seconds;
- Holder includes pid, pid namespace token, turn id, platform;
- Persisted in `session_turn_leases` table;
- Losing the lease interrupts the turn;
- When a liveness watchdog is configured, long periods of inactivity will hard interrupt.

It is not a "database-wide lock," but a **turn key card for a single session**. Different sessions can run in parallel; the same turn in the same session is only allowed one holder at a time.

### 4.3 Why Save User Messages When Admission Fails

If the lease wait times out, is interrupted, or cannot be accepted, `carry_unadmitted_user_message()` will return the user messages in an early result. This way, the caller doesn't "lose messages," and the next round can continue. The detail is minor, but it reflects a principle: **refusing execution does not equal discarding input.**

### 4.4 What Happens During Lease Waiting

`admit_durable_turn_lease()` is in `:297`. If another process holds the lease, it will wait until:

- it acquires the lease;
- times out (`LEASE_WAIT_SECONDS`);
- gets interrupted by the user;
- finds that the owner is dead and can be reclaimed.

Waiting is not busy-waiting; it also allows temporarily storing current user messages, avoiding loss of input during the queue.

## 5. build_turn_context: What the Model Actually Sees This Turn

`agent/turn_context.py:1036`'s `build_turn_context()` is the only entry point for preparing a turn. Its docstring indicates a very critical order:

> DB session row must be created after the system prompt is built; otherwise, it will write into `system_prompt=NULL`, causing a cache miss.

### 5.1 Preparation Sequence

According to the main source code, it goes through at least these steps:

1. **stdio guard**: prevents a broken pipe from crashing the whole process;
2. **surrogate cleansing**: prevents invalid UTF-16 surrogate characters from entering the provider;
3. **restore rotated compression session**: if the previous turn rotated a session with compression, first find the canonical child;
4. **bind session context / write origin**: logs, memory write source, review attended mark;
5. **restore primary runtime**: if the previous turn fell back to another provider, this turn returns to the main runtime;
6. **refresh MCP tools**: the MCP toolset can change between turns, but once this turn starts, it should stabilize;
7. **bind turn identity**: task_id, turn_id, stream callback, persist metadata;
8. **reset per-turn state**: interim deduplication, persist failure marks, credential refresh counts, etc., absolutely no leakage from previous turn;
9. **copy history**: `messages = list(conversation_history)`, without modifying caller list;
10. **stage current user messages**: handle persist override, display type, platform message id;
11. **hydrate history**: restore token estimates, image costs, session-related state;
12. **append current user message**, record `current_turn_user_idx`;
13. **restore or build system prompt**: once per session, then reuse;
14. **create DB session row**: after the prompt, avoids NULL prompt;
15. **turn-start compaction / idle compaction**: handle over-window before first API call;
16. **fire `pre_llm_call` hook, memory prefetch, skills index note**;
17. **persist turn start**.

### 5.2 Three Layers of System Prompt

`agent/system_prompt.py:736`'s `build_system_prompt_parts()` divides the prompt into three layers:

| Layer | What to Place | Why Place Here |
| --- | --- | --- |
| `stable` | identity, guidance, coding brief, workspace snapshot, environment prompts, platform prompts | Least likely to change, placed at the very front to maximize longest-prefix cache |
| `context` | caller `system_message`, project context files (AGENTS.md, etc.), remaining workspace guidance | Relatively stable within a session but may depend on the working directory |
| `volatile` | skills index, memory, USER.md, external memory provider, timestamp, runtime hints | Most likely to change, placed at the end; even if changed, try to only affect the tail |

`build_system_prompt()` is assembled and cached in `:802` at `agent._cached_system_prompt`. `invalidate_system_prompt()` is at `:814`, only called after compression.

### 5.3 Why Freeze the Workspace Snapshot

`_coding_parts()` performs a git/workspace probe once. If the prompt is rebuilt with a new probe each time, any repository change alters the prompt bytes, breaking the cache prefix. Therefore Hermes **freezes the workspace block per session**, with the key being the cwd at probe time; as long as cwd doesn't change during a rebuild, the same bytes are replayed.

This is a typical engineering trade-off: **it's better to show slightly outdated workspace info than to create cache misses mid-session.**

### 5.4 build_api_messages: separation of wire copy and transcript

`build_api_messages()` is at `agent/turn_context.py:1243`. It does not simply send `messages` as-is, but builds a wire copy:

- If there are `api_content` in historical user/assistant turns, replay the **actual bytes sent at that time**;
- The current user turn reuses the prologue stamped version;
- Local bookkeeping fields like `api_content`, `display_*`, `_row_id` are removed from the wire copy;
- Memory prefetch, `pre_llm_call` hook, `ephemeral_system_prompt` are only injected during API calls, not written back to `messages`;
- System prompt is constructed once per session and then replayed verbatim.

This explains a common question: **why do the messages seen in the transcript differ from what the provider receives?** Because the transcript is a human-readable record, while the wire copy is the cache-stable "sent view." Both are connected by `api_content` sidecar.

### 5.5 Common Misunderstandings

- **"System prompt is rebuilt every round"**: No. It is constructed once per session, only reconstructed if compression invalidates it.
- **"Just append tool results directly to history"**: No. Tool results must go through budgeting, persistence, and provider adaptation before entering the next round of wire copy.
- **"Memory is part of the system prompt, so it can change every turn"**: Memory is in the volatile layer but only read during session construction; mid-session writes are not reflected until compression or the next session.

## 6. Preflight compression: the gateway before each API call

`agent/turn_preflight.py:57`'s `run_preflight_compression()` runs before every API call. It obtains the current request pressure (tokens) and then determines:

```text
Whether eligible (compression_enabled, number of messages > 1, attempt not exceeded)
  → Is in failure cooldown
  → Whether to review fork first request pending
  → compressor.should_compress(request_pressure_tokens)
```

If hit: 

1. First, try using a grow managed local window (llama.cpp a local model like this); 
2. Otherwise, call compressor compression to refund the API call that did not actually occur; 
3. After compression, re-enter the cycle and measure again; 
4. If compression times out, blocks, or is not feasible, handle it as fail-closed or deferred. 

### 6.1 The default value is not "fixed 75%" 

`hermes_cli/config_defaults.py` segment of `compression`: 

- `threshold: 0.50`; 
- `target_ratio: 0.20`; 
- `protect_last_n: 20`; 
- `protect_first_n: 3`; 
- `tail_mode: "lean"`.  

But the note also states: **Models with windows less than 512K will raise the threshold to 0.75 (raise-only floor)** to avoid "compressing when the window is half left." So the actual trigger point depends on the model window and the per-model override. 

The base class also declares the default values for `0.75 / 3 / 6`, which is for plugin engines that do not override these properties; The actual constructor of `ContextCompressor` comes from `CompressionSettings`, so do not mix the two default values. 

### What does the 6.2 compressor do?

`agent/context_compressor.py:2152` of `ContextCompressor`: 

- First, prune the old tool result (deterministic, no LLM needed); 
- Protect head(system first few items); 
- Keep the tail of token-budget (not a fixed number); 
- Summarize the middle segment with a cheap auxiliary model; 
- Subsequent compression iteration updates existing summaries, rather than starting from scratch each time; 
- Handle orphan tool pairs to ensure the `assistant(tool_calls) → tool` structure is valid; 
- Supports micro-compaction, proactive prune, failure cooldown, and anti-thrash; 
- Compression can be rotated along `parent_session_id` to create a child session. 

`should_compress()` in `:3002`, `compress()` in `:5447`. 

### 6.3 Why Compression Should Be Locked

Compression rewrites history, may rotate sessions, and affects the prompt cache. `compression_locks` The table ensures there is only one compressor per session at the same time. During compression, admission is not blocked for long periods by LLM calls: `LiveSession.claim_gate` It is only held in the "ready transcript" window, not in the entire summary process. 

### 6.4 Common Misconceptions

- **"Compression means deleting old messages"**: No. It protects the beginning and end, summarizes the middle, preserves user anchors, and may rotate sessions. 
- **"If the threshold is exceeded, compression is guaranteed"**: No. You also need to look at cooldowns, review forks, provider overflow, attempt limits, and feasibility testing. 
- **"If compression fails, the original request will continue"**: Not necessarily. When the provider has proven overflow, the preflight will fail-close, avoiding resending a request that is bound to fail. 

## 7. Main cycle: What exactly is a round of iteration about?

`agent/conversation_loop.py:1785` `run_conversation()` first calls `build_turn_context()`, then enters `_run_conversation_turn()`. The main loop is in `:1724`:

```python
while _prelude_action != "break" and (
    (s.api_call_count < agent.max_iterations and agent.iteration_budget.remaining > 0)
    or agent._budget_grace_call
):
```

Stages of each iteration:

```text
begin_iteration        # Count, check budget/interrupt
prepare_iteration      # Operating budget, tool schema, steer, contextual prompts
assemble_api_request   # Generate this wire request
run_preflight_gate     # Compression/Local Window/overflow Gate
announce_api_call      # Status, usage, request id
_run_api_retry_loop    # Actually call the provider and handle retry
apply_retry_restarts   # Recalculate after fallback / restart
normalize_model_response
  ├─ tool_calls → run_tool_round
  └─ Plain Text     → finish_text_response
finalize_turn
```

The return value of a stage function usually has three actions: 

- `continue`: This round does not end, re-enters the loop (e.g., compressed and re-measured); 
- `break`: End the loop and enter the finale; 
- `return`: Directly returns the result of this turn (e.g., early departure/fatal error). 

### 7.1 The Stop Condition Is Not One

At least the following categories are included: 

1. The model returns plain text and passes through stop gates; 
2. `api_call_count >= max_iterations`; 
3. `iteration_budget.remaining <= 0`; 
4. Running time budget exhausted; 
5. User interruption; 
6. Compression blocking/timeout, ending according to strategy; 
7. Tool Guard halt; 
8. Persistence of failure; 
9. Recovery paths such as empty response, repeated output, or length truncation still cannot be output; 
10. Provider/encoding/connection errors reach terminal state. 

### 7.2 `max_iterations` and `iteration_budget`

`run_agent.py:241` The default `AIAgent.__init__` is `max_iterations = sys.maxsize`, meaning "by default, it does not rely on the number of iterations to hard stop." In actual products, smaller values passed in by the host (for example, TUI's `_cfg_max_turns(cfg, 500)`, GatewayAgent defaults to 90). 

`iteration_budget` is another dimension: it records how many more calls can be made in this round,`execute_code` tools that don't really consume model turns can be refunded. `_budget_grace_call` Allows another "tool-free summary" opportunity when the budget is just depleted, preventing users from seeing only half a page. 

### 7.3 Special Branches

- `api_mode == "codex_app_server"`: The entire turn can be handed over to the codex app-server child process, `conversation_loop` only for external coordination. 
- `prelude`: Scripted preset tool call, played before the first model call; Used for onboarding and similar scenarios. 
- `PreflightCompressionTimedOut`: Returns an early result in `build_turn_context()` ahead of time, rather than entering the main loop. 

## 8. API requests: How wire copy becomes a real call

### 8.1 build_api_request

`agent/turn_api_request.py:93` of `build_api_request()` is responsible for: 

- Reapply reasoning echo (some providers need to return reasoning); 
- Redo the provider prompt-cache decoration; 
- Remove images from models that do not accept images; 
- Adjust `agent._build_api_kwargs()` to assemble basic parameters; 
- sanitize payload; 
- codex preflight; 
- OpenRouter cache bypass; 
- Copilot `x-initiator`; 
- LLM request middleware; 
- `pre_api_request` hook; 
- debug dump.  

The key to this layer is: **It does not change the transcript, only the "projection of this request."** 

### 8.2 perform_api_call

`agent/turn_api_call.py:72` of `perform_api_call()`: 

- `_should_stream()` Prioritize streaming, as streaming allows Liveness Watchdogs to see progress; 
- The process provider must explicitly support streaming; 
- `nous_rate_limit_guard()` Guards take effect here; 
- Stream failures can be rolled back to non-streaming or other transports, but they cannot corrupt already delivered text. 

### 8.3 retry is not blind retry

`TurnRetryState` Each API attempt is newly created, including a one-time guard to prevent the same recovery action from being triggered repeatedly: 

- auth retry; 
- Thinking signature fix; 
- image shrink; 
- Multimodal downgrade; 
- rate limit waiting; 
- auth failover; 
- auto recovery; 
- restart signal.  

`agent/turn_api_error.py:52` `handle_api_error()` first performs category recovery, then handles interrupt/shutdown, overflow, and non-retry client errors, and finally proceeds to primary transport recovery → fallback → terminal. 

### 8.4 Fallback: Why Return to Preflight?

Because switching providers often means changes in context window, token estimation, image support, and reasoning formats. Simply "switching to a different client and continuing to post" will result in the wrong budget and wire format. 

Hermes' approach is `restart_with_rebuilt_messages`: return to preflight and recalculate context and requests. The trade-off is possibly one more compression/assembly, but correctness takes priority. 

### 8.5 response intake

`agent/turn_response_intake.py:120`'s `normalize_model_response()`:

- Normalize `finish_reason`;
- Enforce `content` types;
- Run response hooks;
- Handle codex incomplete;
- Turn provider responses into structures that later stages can understand.

## 9. Tool Turns: persist-before-execute

`agent/turn_tool_round.py:49`'s `run_tool_round()` module header is very clear:

1. validate / cap / dedupe tool calls;
2. **persist tool-call turn BEFORE any side effect**;
3. execute tools;
4. guardrail / persistence failure handling;
5. compress after tool results.

### 9.1 Why persistence must happen first

Suppose the model requests execution of `rm -rf`, and Hermes crashes before execution. If the tool-call block only exists in memory, the resumed session after restart will not see this call, and the model might think "it hasn't been executed" and could execute it again. The invariant with persisting first is:

> **If a tool call could have side effects, the transcript must already record that 'the model requested its execution'.**

Conversely, if canonical append fails, Hermes will not "run it from process memory anyway," but will directly end the turn and mark `session_persistence_failed`. Because you cannot prove whether a side effect occurred, this is more dangerous than not executing.

### 9.2 Details of mixed batches

- One assistant message might have multiple tool calls;
- Invalid tool names must also generate matching tool results, but just not dispatch;
- Tool call IDs need normalization to ensure `assistant(tool_calls) → tool` pairing by the provider;
- `expand_local_tool_batches` will expand locally bridged batch calls, with each sub-call still following the same scope, approval, state, and scheduling.

### 9.3 Executor

`agent/tool_executor.py`:

- `_MAX_TOOL_WORKERS = 8` (max workers per batch concurrency);
- `_DEFAULT_CONCURRENT_TOOL_TIMEOUT_S = 420.0`;
- `_START_ORDER_GATE_TIMEOUT_S = 120.0`;
- `execute_tool_calls_concurrent()` `:1585`;
- `execute_tool_calls_sequential()` `:1865`;
- `execute_tool_calls_segmented()` `:1935`.

Key mechanisms:

- Concurrent results are filled back according to the original tool call order, so UI does not misalign despite completion order;
- Has per-batch deadline;
- Start-order gate ensures observation order of 'call start';
- Approval lock timeout aligns with max human approval wait;
- Heartbeat prevents slow tools from being mistakenly killed by inactivity timeout;
- After interruption, skipped results are filled for unexecuted calls, ensuring each call has a result;
- File modification tools perform checkpoints;
- Tool results are committed before posting UI completion.

### 9.4 How tool results flow back

After tools return, the executor:

1. Handles multimodal results;
2. For very large text, performs spill/persist, returning summary or path;
3. Records persisted path;
4. Generates `role: "tool"` message;
5. Flushes to SessionDB;
6. If persistence fails, does not send in-memory results back to model;
7. If tool guard halts, generates controlled halt response and ends;
8. After tool turns end, performs post-tool compression once more.

### 9.5 Common misconceptions

- **'Tools execute concurrently, so results are written in completion order'**: No. Results are filled back in call order.
- **'Tool error equals turn failure'**: Not necessarily. Errors become tool results and return to the model; only persistence failure, guard halt, interruption, etc., terminate the turn.
- **'Tool results can be infinitely large'**: No. Exceeding budget will go to disk, only summary/path is sent back to the model.

## 10. finalize_turn: model stopping does not equal turn ending

`agent/turn_finalizer.py`'s module header lists finalization duties:

> budget summary, trajectory save, persist, diagnostics, response transforms, result assembly, steer drain, memory/skill review.

### 10.1 When budget is exhausted, still try once more

`_resolve_budget_fallback()` is around `:125`. If `final_response is None` and the budget is exhausted, Hermes will call `_handle_max_iterations()` to make a **tool-free summary request**. This way, the user can at least get an explanation of "what I accomplished and why it stopped," instead of a blank response.  

If there was previously a candidate answer blocked by the verification gate, it will be retained first when the budget is exhausted, rather than taking another risk of failure.  

### 10.2 Recovering from streaming text  

`_recover_final_from_stream()` is at `:225`: if the final state `final_response` is empty, but text has already been delivered in the stream, recover using the streamed text to avoid overwriting the answer the user has already seen with a blank.  

### 10.3 Closing the transcript tail  

`_close_transcript_tail()` is around `:240`:  

- Close any unfinished tool sequences when interrupted;  
- If `final_response` has been delivered but the transcript lacks a corresponding assistant row, add one;  
- If the last line is tool-call-only or an empty line recovered from streaming, fill in `final_response`;  
- Ensure that "delivered final answer ⇒ there is an assistant row in the transcript."  

### 10.4 Persistence and post-processing  

`_persist_step()` is around `:620`:

```text
recover final from stream
  → apply output transform
  → close transcript tail
  → micro-compact (if enabled)
  → agent._persist_session(messages, conversation_history)
```

Afterwards, it will also: 

- Record turn exit logs; 
- Add file modification footer; 
- Interpret exceptions and exits; 
- Application outputs hooks; 
- sanitize surrogate; 
- Assemble result(`final_response`, `failed`, `interrupted`, usage, cost, failure_reason, etc.); 
- drain leftover steer; 
- Synchronize external memory; 
- Trigger background memory/skill review after delivery. 

### 10.5 Failure Turn Also Needs to Be Closed

`_close_durable_failed_turn()` At the end of `conversation_loop.py`: If the failed turn leaves an open `user` or `tool` trailing line, add a Hermes own assistant boundary to avoid merging failed requests with new ones in the next round. Except for context pressure class failures, because adding content to an overwindowed session creates a growth loop. 

### 10.6 Common Misconceptions

- **"The model returns stop, and it's over"**: No. You also need to pass stop gates, wrap up, persist, usage, and memory review. 
- **"The stream has already been displayed, so there's no need to write transcript"**: No. The stream is a live fact, and a transcript is a durable fact; Both are required. 
- **"No need to finish if you fail"**: No. Turn failure: You need to close the tail even more, otherwise the next round of history will be ruined. 

## 11. Delivery: How event streams return to users

### 11.1 Gateway

The Gateway's `TurnRunner` creates `GatewayStreamConsumer` and sends delta and tool progress to the adapter. Ultimately, `finish(final_text)` ends with **authoritative `final_response`** instead of the last paragraph of the stream accumulator. Reason: 

- The final answer may include verifier footer and completion explainer; 
- Flow accumulators may miss post-processing; 
- Interrupted/failed diagnostic texts cannot overwrite parts the user has already seen. 

For platforms with `draft_stream_is_message=True`, the stream itself is the final message and must satisfy contracts such as prefix stability, final declaration, interim tagging, editing rather than reposting, etc. 

### 11.2 TUI / Desktop

The TUI backend sends `message.delta`, `message.complete`, utility events, and server→client requests via JSON-RPC. Desktop receives the same set of events via WebSocket. When the client disconnects and reconnects, `session.events.since` / `session.resume` replay unfinished issues and necessary events. 

### 11.3 Classic CLI

`GatewayAgent._pump()` Continues reading events until the current admission `message.complete`. If a frame is lost, it uses `turn.seen`, `turn.shown`, `turn.spoken` as a supplement; If Ctrl-C, it has a `INTERRUPT_SETTLE_SECONDS = 10.0` settlement limit. 

## 12. Failure matrix

| Failure points | What has already happened | Recovery strategies |
| --- | --- | --- |
| Crash before committing | Nothing happened | Client retrys; request_id Idempotent |
| Admission written, not claimed | Input persists | After restart, drain continues to claim |
| Claimed, turn not started | admission=started | After owner dies, it will be changed to unknown and handled according to the recovery strategy |
| turn started, tool call persisted, tool not executed | transcript has tool-call block | resume shows the request and won't mistakenly think it didn't happen |
| Tool executed, result not persistent | Side effects may have occurred | Results are not sent back to the model; Persistence failed |
| lease lost | Another process may take over | Current turn interrupts, avoiding doublewrite |
| Compression timeout | History not deleted | Record cooldown, continue or deferred, no message loss |
| provider 429/5xx | This call failed | retry → restore → fallback → terminal with the same provider |
| provider overflow | Request will inevitably fail | Return to preflight to recompress/recalculate |
| Approval rejection | Tool not executed | Generate rejection results and return to the model |
| Tool guards halt | Tool may partially execute | Generates a controlled halt response, ending turn |
| CLI/Gateway disconnected | turn may still be running | After reconnecting, press admission/event to replay; Do not assume turn has stopped |
| TUI client disconnected | Backend turn continues | `session.resume` / `events.since` Playback |

## 13. Retell the entire line with four questions

### Where to enter the input?

- Classic CLI: `prompt.submit` → Gateway;  
- Messaging Platform: adapter → `SessionAuthority.submit`;  
- TUI/Desktop: JSON-RPC `prompt.submit` → `tui_gateway` (can bind authority);  
- Background Events: `admit_internal_event` → same durable FIFO.

### What does the model see this time?

- The system prompt of the current session (three layers: stable/context/volatile, constructed once);  
- Replay of historical messages `api_content`;  
- Current user message (possible prologue stamp);  
- The tool schema for this round;  
- Memory prefetch / hook / ephemeral context injected at API time;  
- Compressed summary with preserved head and tail.

### What does the model do, and how are tool results fed back?

- The model returns `tool_calls`;  
- Tool calls are first persisted, then executed;  
- Execution results are converted into `role: tool` messages in original order;  
- Results are flushed to SessionDB;  
- The next round API sees these results;  
- If result persistence fails, the turn ends, and the in-memory results are not sent to the model.

### When does the system truly stop?

- Plain text passes stop gates;  
- Budget/iterations/time run out;  
- User interrupts;  
- Compression blocking/timeout;  
- Tool guard halts;  
- Persistence failure;  
- Provider terminal error;  
- Empty response/repeated output and other recovery paths still fail.

## 14. Self-test and Practice

1. Draw the complete call chain from key press to `AIAgent.run_conversation()` in a classic CLI, marking which step occurs in the CLI process and which in the Gateway process.  
2. Why does `session_admissions` need `unknown` state? What problems occur if you treat it as `queued` or `terminal`?  
3. If the turn lease TTL is 300 seconds with a 60-second refresh interval, why is a liveness watchdog still needed?  
4. Find the comment in `build_turn_context()` "construct system prompt first, then create DB session row," and explain what would happen if this order is not followed.  
5. Pick a historical message and explain the differences between `content`, `api_content`, and the wire copy.  
6. Manually construct an orphan scenario for `assistant(tool_calls) → tool` and explain why the compressor must fix it.  
7. If the provider falls back and does not return to preflight, what specific errors might occur?  
8. Why must tool calls be persisted first? Use an example like "process crashes after file deletion" to illustrate.  
9. Explain why `_close_transcript_tail()` needs to add a row when `final_response` has been delivered but the transcript has no assistant row.  
10. Assume the Gateway process crashes after a turn executes a tool but before results are written back. What should the system see after restart? What should it not see?

### Reference Answers

1. The classic CLI link is: `hermes_cli/main.py::cmd_chat` → `cli.py::HermesCLI` → `cli_chat_turn_mixin.py::chat()` → `GatewayAgent.run_conversation()` → `gateway_agent.py` `connection.call("prompt.submit", ...)`. **Input parsing, callback rendering, and event playback occur in the CLI process**; Actual admission, `TurnRunner`, lease, `AIAgent.run_conversation()`, and model/tool execution occur in the Gateway process. The CLI side does not run the real agent directly. 
2. `queued` indicates persistent queue has been queued and has not yet started; `started` means the worker has taken over; `unknown` indicates that the boundary state of commit/start is uncertain (for example, a process crashes between writing started and execution, making it impossible to determine whether it ran based on local observation), and readback/reconcile is required; `terminal` indicates a clear terminal state. Set `unknown` when queued will execute repeatedly, and when terminal will lose work or erroneously announce completion. 
3. TTL of 300 seconds and refresh of 60 seconds only ensure "lease renewal under normal event cycle"; Liveness Watchdog also detects processes that are present but event loops are stuck, refresh coroutines are starving, DB/network partitions, or threads are blocked. Without watchdog, the system might continue to treat the old owner as alive during this 300-second window; With watchdog, heartbeat loss can be detected earlier and interrupted/isolated. 
4. The code requires building a system prompt first, then writing or associating the prompt to the session row. If the session row is created first, if construction fails or the order is reversed, `system_prompt` will be marked as NULL; The next round cannot reuse the same prompt, which not only damages the byte stability of the prompt cache but may also cause the model to run without system constraints. 
5. `content` is the message content in the transcript facing display/storage; `api_content` is the stable sidecar used by the provider for playback, preserving the message shape in the API protocol; wire copy is a copy temporarily generated before this request based on compression, budgeting, hooks, and provider adaptation, without writing back to the transcript. The three answer "What did people see?", "How will we replay as is next time?", "What was actually sent this time". 
6. After `assistant(tool_calls)`, there must be matching `tool` results. If the compression cutoff falls between the two, an orphan will be created; The provider may directly reject the request, and the model will misunderstand that the tool is still running. The compressor must pair the reserved tool call with the result, or generate a clear placeholder/fix result for missing results, and must never leave a blank UID. 
7. After fallback, the model window, `api_mode`, prompt/tool schema, compression threshold, and message shape may all differ. Not rerunning preflight will reuse the old window budget, causing context overflow for the new provider; It may also send the old provider-specific fields or uncompressed messages, or cause the cache prefix to be inconsistent with the system prompt. The correct approach is to go back to preflight and reassemble wire copy. 
8. Tool calls are persisted first to leave canonical evidence of "what this turn intends to do" before side effects occur. For example, if files are deleted first, the process crashes immediately and there is no tool call in the transcript, so after restarting, the system neither knows the deletion has occurred nor can it determine whether compensation is needed; If persistence calls have already occurred, at least it can locate incomplete calls and rely on idempotent/readback to decide whether to retry or mark unknown, rather than mistakenly treating "no result" as "no execution." 
9. Because users may have already seen the final text from the stream. If the transcript does not correspond to the assistant row, the next round/reboot history will lack this delivered fact, and the audit will show "UI present, ledger absent." `_close_transcript_tail()` Adding a line includes delivered answers in the canonical transcript to ensure "delivered text must have ledger records." 
10. After reboot, you should see: the persisted user/assistant tool-call record, the status of admission and lease, and an unclosed turn without a canonical tool result. The system should identify it as interrupted/unknown, reconcile first, and cannot fake the successful result. You should not see: tool results generated out of thin air, delivered final answers, completed terminal receipts, or automatic reruns of executed side effects. Whether external files are actually deleted can only be determined by readingback/idempotent records. 

> **In short: The reliability of a turn does not come from how smart the model is, but from the four steps of "persistence in input, lease contract after execution, accounting with tools first, and wrapping up after completion."**
