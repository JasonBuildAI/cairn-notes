---
title: "Stage 3: Prompt, Context, and Compression"
description: "Stage 3: Prompts, context, and compression. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: Hermes Agent Source Code Class · Stage Quiz
> Prerequisites: Stage 1, 2
> Corresponding Overview: `turn-lifecycle.md` Sections 5–6, `core-mechanisms.md` Section 2
> Goal of this stage: Distinguish `messages`, `api_messages`, and system prompt, and understand why compression is the only boundary allowed to alter historical bytes.

## 1. What this stage addresses

The model does not see the messages in SessionDB as-is, nor are they simply `messages + system prompt`. Hermes simultaneously maintains:

- transcript: persistent, recoverable, session records for UI/audit viewing;
- wire copy: the structured messages actually sent to the provider this time;
- three-tier cache of the system prompt;
- compressed summaries, tool result pruning, and session rotation.

If these copies are not clearly distinguished, one may mistakenly treat "appearing identical locally" as a "prompt cache hit," or "still recoverable after compression" as "the original session was modified in place."

## 2. Remember one rule first

**The same session must send a stable prefix of bytes within a segment of stable history; only explicit compression can alter this history.**

This rule constrains:

- Why the system prompt is divided into stable/context/volatile;
- Why the workspace snapshot must be frozen;
- Why the `api_content` sidecar must retain the "actually sent bytes";
- Why tool execution may append a tail but must not secretly rewrite history;
- Why fallbacks must go through preflight again, rather than swapping providers using an old request.

## 3. Source code main line

1. `agent/turn_context.py::build_turn_context()` first restores a possibly rotated session, then binds logs, turn id, platform, and per-turn state.
2. It handles inter-turn tool changes via `_refresh_mcp_tools_between_turns()`, but this does not allow arbitrary mid-turn toolset changes.
3. `_stage_turn_user_message()` inserts the current user input into the message sequence; `_hydrate_from_history()` restores history and compression state.
4. `_restore_or_build_system_prompt()` prioritizes reusing persisted prompts; reconstruction only occurs during the first time or after compression.
5. `agent/system_prompt.py::build_system_prompt_parts()` generates the `stable → context → volatile` three tiers.
6. `build_api_messages()` clones a wire copy from the canonical history, removes fields meant only for persistence, and injects memory/hook context visible only at the API level.
7. `_stamp_api_content_sidecar()` records the actually sent content of this turn into `api_content`, so subsequent replays can reuse the same bytes.
8. `agent/turn_preflight.py::run_preflight_compression()` estimates tokens before each API call, deciding fallthrough, continue, break, or return.
9. `agent/context_compressor.py::ContextCompressor.compress()` first prunes old tool results, then splits head/middle/tail, summarizes the middle, and cleans up orphaned tool pairs.
10. Compression can produce child sessions but preserves parent/child ledger relationships; the original history can still be interpreted from the original session and summary boundaries.

## 4. Key objects and contracts

| Object | What it stores | Must not be confused with |
| --- | --- | --- |
| `messages` | Session sequence in memory for this turn | Provider's final bytes |
| `api_messages` | This turn's wire copy | Persistent transcript |
| `api_content` | Actually sent user/assistant text | Display text or the model's original reasoning |
| stable prompt | Identity, general guidance, stable encoding posture | Current time, memory, skills index |
| context prompt | Caller system message, project context, frozen workspace | Per-turn changing random state |
| volatile prompt | Skills, memory, profile, time, and runtime hints | Stable prefix |
| summary message | Summarized work of compressed middle segment | Original history |
| child session | Session continuing work after compression | Deleted original ledger |

Default compression parameters (configurable in source code, not always fixed):

- `threshold_percent = 0.50`;
- `summary_target_ratio = 0.20`;
- `protect_first_n = 3`;
- `protect_last_n = 20`;
- `tail_mode = "lean"`.

Actual thresholds are also influenced by model-specific limits, small context floor, reserved and maximum output adjustments, so in the course they cannot be stated as "fixed at 75%."

## 5. An observable chain

~~~text
conversation_history
  → build_turn_context
  → stage user message / hydrate history
  → build or restore system prompt
  → build_api_messages
       clone
       pop api_content + persistence fields
       replay exact api_content
       inject ephemeral memory/hooks
  → estimate request tokens
  → preflight gate
       under threshold → provider
       over threshold  → prune + compress
       still over      → continue / fail closed
  → API request
~~~

Observation points: The same historical user message may differ in the transcript and the wire copy `content`; this is not a bug, but a separation of responsibilities between display/restoration and provider bytes.

## 6. Experiments

### Experiment A: Compare transcript and wire copy

Record a round of messages with ephemeral memory, printing before and after `build_api_messages()`.

### Experiment B: Verify prompt prefix stability

Compare the stable + context prefix in two consecutive rounds without changing memory/skills/workspace.

### Experiment C: Trigger compression

Construct historical messages exceeding the threshold and observe the number of pruned items, head/tail boundaries, summaries, orphan tool pairs, and session IDs.

### Reference Answers for Experiments

1. **Experiment A**: Transcript retains persistent content and metadata; wire copy removes `api_content`, `_row_id`, display, and similar fields, keeping only fields the provider can accept and injecting the current round's API-only context.
2. **Experiment B**: The stable/context portions should remain the same across two rounds; volatile fields such as timestamps may differ, so the true cache prefix should stop at the stable boundary.
3. **Experiment C**: Old tool results may be summarized/pruned first; the head and tail are protected, while the middle is summarized; orphan tool call/results need pairing or safe cleaning; rotation generates a child session while preserving source relationships.

## 7. Failures and Recovery

| Failure | Fact | Recovery |
| --- | --- | --- |
| System prompt stored prematurely | May be saved as NULL or old bytes | Construct the prompt before creating/updating the session row |
| Memory reloaded mid-turn | History prefix changes, cache invalidates | Only rebuild at explicit compression boundaries |
| `api_content` lost | Replay byte drift | Keep sidecar; rebuild during compression according to rules |
| Compression blocked by lock/cooldown | Request still too large | Refund the current compression attempt, continue or fail according to gate |
| Compression makes no progress | Cannot retry indefinitely | Fail closed after reaching limit, keep recoverable transcript |
| Compression timeout | Not yet sent to provider | Return compression timeout result without sending the original request |
| Orphan tool pair | Provider may reject | Clean up or pair, maintaining call/result structure |
| Read incorrect session after rotation | Subsequent writes go to child or old ledger | First resolve the current canonical child |

## 8. Self-Check for Completion

1. What are the differences among `messages`, `api_messages`, and transcript?
2. Why is the system prompt divided into stable/context/volatile?
3. Why must the workspace snapshot be frozen?
4. What problem does `api_content` solve?
5. Why does compression protect the head and tail and only summarize the middle?
6. Why might a child session need to be rotated after compression?
7. Why can't fallback use the old `api_messages`?

### Reference Answers

1. `messages` is the work sequence within the turn; `api_messages` is the actual clone sent to the provider this turn; transcript is the persistent ledger for recovery, display, auditing, and subsequent round playback.
2. To let unchanging content form the longest common prefix, reducing prompt cache misses; at the same time, place memory, skills, time, and profile in the tail to avoid recalculating the entire prefix when any change occurs.
3. In the same session, reading the working directory, project context, and environment hints each turn would alter stable/context bytes; freezing the snapshot ensures a stable cache prefix, only updating at session/compression boundaries.
4. It records the exact text the model actually received, reusing the same bytes during playback, preventing display-level cleaning, proxy injection, or sanitization from causing each turn's wire copy to drift.
5. The head usually contains system constraints and the earliest context, the tail contains recent work and the current turn; straight summarization would lose the most necessary behavioral constraints and immediate tasks. Middle historical information has lower density, suitable for summarization.
6. Rotation separates the "new work context after compression" from the "original ledger," avoiding disguising the summary as the original message, while keeping parent/child relationships for recovery, auditing, and continued conversation.
7. The new provider may have different context windows, adapters, message formats, and token budgets; you must re-estimate, compress, and construct the request in preflight, otherwise it may exceed the window or send incompatible fields.

## 9. Source Code Coordinates

- `agent/turn_context.py::build_turn_context`
- `agent/turn_context.py::build_api_messages`
- `agent/turn_context.py::_stamp_api_content_sidecar`
- `agent/system_prompt.py::build_system_prompt_parts`
- `agent/system_prompt.py::invalidate_system_prompt`
- `agent/turn_preflight.py::run_preflight_compression`
- `agent/context_compressor.py::ContextCompressor.compress`
- `agent/context_compressor.py::_compress_window`
- `tests/agent/test_context_token_tracking.py`
- `tests/gateway/test_runner_compressed_receipt.py`

## 10. Next Steps

Enter Stage 4: After a tool call appears in the context, the one who first writes the call into the ledger is the only one qualified to produce real side effects.
