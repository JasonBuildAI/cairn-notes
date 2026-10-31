---
title: "OpenClaw 2026.10.9 Stage Class · Reading Guide"
description: "The reading order, stage map, recommended pace, and completion standards for the ten source code stages."
---

> Baseline: Release archive `openclaw-2026.10.9`. The archive does not include `.git` and does not fabricate commits/tags.  
> Paths are relative to `$OPENCLAW_SRC`.  
> `00` to `03` is an overview; this set breaks down the lifecycle of the same message from stage 0 to stage 9 in depth.  

## Understanding OpenClaw in One Sentence

**OpenClaw is a personal agent runtime driven by a resident Gateway: channels and UI only handle input and output, Session/Run manages ownership and execution, Agent Harness handles model and tool loops, and transcript and writer fence manage recoverable history.**

Think of it as a 24-hour operating dispatch center:

```text
Channel / WebChat / TUI / Node
        │
        ▼
Gateway: Authentication, routing, idempotence, events
        │
        ▼
Session / Run admission: queue, takeover, cancellation
        │
        ▼
fence: Who is qualified to write this history
        │
        ▼
Agent Loop: Model flow → tool batch → steering → next round
        │
        ▼
Compaction / Pruning / Approval / Model fallback
        │
        ▼
Transcript commit → Reply → Original Channel / UI
```

## Ten-Stage General Framework

| Act | Stage | Core Questions |
| --- | --- | --- |
| Act I: Entering the System | 0–2 | Where is the code, who owns the request, how is the loop advanced |
| Act II: Controlling Context | 3 | What historical changes, what only affect this prompt |
| Act III: Safe Execution | 4–5 | Who approves tools, how the model/harness fails over |
| Act IV: Retaining Facts | 6–7 | How to write the transcript, how to extend plugins/channels |
| Act V: Engineering Closed Loop | 8–9 | Testing, migration, recovery, and capstone project |

These five acts are not five separate modules but the same chain of causality: **single entry → unique ownership → bounded loop → reconstructible context → tools can be released → outcomes can be recorded.**

## Ten Stages

| Stage | Documentation | What You Will Get |
| --- | --- | --- |
| 0 | [Environment and Source Map](../stage-0/) | Version, directories, process topology, six core identities |
| 1 | [Gateway, Session, and Run](../stage-1/) | `chat.send`, in-flight, lane, writer fence, cancel |
| 2 | [Entry and Agent Loop](../stage-2/) | Channel ingress, two-layer loop, tool batching, steering, follow-up |
| 3 | [Context Compression and Pruning](../stage-3/) | system prompt, bootstrap, compaction, cache-TTL pruning |
| 4 | [Tool Approval and Sandbox](../stage-4/) | Tool assembly, before_tool_call order, deny/defer/report/request, isolation |
| 5 | [Model Authentication, Fallback, and Harness](../stage-5/) | model ref, auth profile, candidate chain, fallback, auto harness |
| 6 | [Session, Transcript, and Writer](../stage-6/) | SQLite transcript, branches, rewrite, terminal state and recovery |
| 7 | [Plugins, Channels, Protocols, and UI](../stage-7/) | Plugin/MCP/Skills, channels, Gateway events, UI/sub Agent |
| 8 | [Engineering, Testing, and Operations](../stage-8/) | Checkchains, schema migration, writer/lane tests, troubleshooting |
| 9 | [Capstone Project](../stage-9/) | Design an extensible system that can be approved, replayed, and recovered |

## Three Cross-Cutting Principles

### 1. Messages share a single entry, but facts are not mixed

WhatsApp, Telegram, WebChat, and TUI have different transmissions but ultimately enter the same Session/Run semantics. Channel messages are not the transcript; `chat.send`'s ACK is not the final response.

### 2. Ownership must be unique

The session lane determines who executes first, the writer fence determines who writes the transcript, the approval owner determines who releases a tool, and the plugin capability owner determines which provider/channel is available. When ownership is unclear, the system may produce interleaved history, duplicate side effects, or "hook-altered parameters after approval."

### 3. Separate reconstructible views from irreplaceable facts

Compaction/pruning is a reconstructible context view; run terminal states, writer takeover, approval results, idempotent keys, and transcript commits are irreplaceable facts that cannot be casually discarded.

## One main chain to memorize

```text
ingress
  → normalize / admission
  → session binding
  → writer fence
  → model + harness selection
  → context projection
  → agent loop
  → tool policy / approval / sandbox
  → transcript commit
  → reply delivery
```

Ask three questions at each stage: **Who does this fact belong to? Where does it stop after failure? Which side effects cannot be repeated when retrying?**

## Recommended Reading Approach

- The first pass: only look at the main chain, do not trace specific channels/providers.
- The second pass: open the source code coordinates, confirm functions, objects, and failure returns.
- The third pass: conduct experiments: concurrency within the same session, tools waiting for approval, provider fallback, comparison of compaction/pruning.

## Learning Completion Criteria

1. What are `clientRunId`, `sessionKey`, `sessionId`, `runId`?
2. Why is `chat.send` returning `in_flight` not considered complete?
3. When a new writer takes over, why must the old run `superseded`?
4. What do the inner and outer continuation conditions of the Agent Loop solve respectively?
5. How do the objects modified by compaction differ from those modified by cache-TTL pruning?
6. In the order of `before_tool_call`, why must approval happen before ordinary hooks?
7. Why are model fallback and harness fallback not the same thing?
8. Why might submissions or logging continue even after `agent_end`?

### Reference Answers

1. `clientRunId` is the client retry idempotent identity; `sessionKey` is the Gateway routing identity; `sessionId` is the persistent session record identity, which may change due to rewriting/branching; `runId` is the identity of a single execution run.
2. It only indicates that the Gateway has accepted the request and established a recoverable execution; the subsequent model, tools, transcript, and submission are not yet complete. Treating ACK as the result may cause the client to resubmit or misjudge success after disconnection.
3. If the old writer continues writing, it will interleave history with the new writer and duplicate side effects, and it will be impossible to audit ultimate ownership. Explicit `superseded` stops the old run from writing, releases resources, and leaves an explainable final state.
4. The inner part handles "the current turn hasn't ended yet": if there are still tool calls or steering messages, continue; the outer part handles "whether there is a follow-up after the turn ends": if yes, continue the same logic; if not, enter `agent_end`.
5. Compaction rewrites the history/transcript view and generates summaries; cache-TTL pruning only replaces expired tool results in the current prompt, while the disk transcript remains original.
6. If ordinary hooks run before approval, they can modify tool parameters or fabricate evidence, making the approval see a "washed" call. Approval must see the original call; the final owner approval still releases independently after hooks.
7. Model fallback switches models/credentials/routing within the same harness; harness fallback switches the execution runtime, possibly changing tool protocols, steering, session mapping, and capabilities.
8. The end of the model loop only means generation stops; afterwards, transcript submission, terminal outcome recording, reply dispatcher settlement, segmented response sending, session metadata update, and resource release still need to happen.

## Next Steps

Starting from `stage-0.md`, first recognize identities and boundaries, then see how a single request enters the same Run.
