---
title: "Stage 6: Session, Transcript, and Writer"
description: "Stage 6: Session, Transcript, and Writer. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: OpenClaw Source Code Class · Stage Exercises
> Prerequisite: Stages 1–5
> Corresponding Overview: The posting part in `message-lifecycle.md`
> Goal of this Stage: Understand the canonical status of transcript, append/rewrite, branching, repair, and writer commits.

## 1. What this stage addresses

After the model finishes, the system still needs to decide:

- Which messages count as committed history;
- Whether failed candidates, assistant errors, or reasoning are recorded;
- How compaction rewrites old history;
- How tool calls and results remain paired;
- Whether sessionId/branch changes after rewrite;
- How old writers and terminal errors leave auditable facts;
- Where to read the same segment of transcript after a restart.

These are not UI display issues but are central to session recoverability.

## 2. Remember one rule first

**The transcript is the session fact, the prompt is this round's projection; append/rewrite must be committed by the current writer.**

Seeing model output does not mean the transcript has been committed; seeing a compaction summary does not mean the original text is gone. Recovery relies on the database/transcript contract.

## 3. Source Code Main Line

1. `agent-session-transcript.ts` handles reading, appending, and projecting the session transcript.
2. `src/state/openclaw-agent-db-schema.ts`, together with session migrations, defines SQLite tables, versions, and migrations.
3. `transcript-rewrite.ts` generates controllable history rewrites; compaction posts through rewrite boundaries.
4. `session-bootstrap.ts` binds sessionId and activeWriterRunId under the writer barrier.
5. `transcript-policy.ts` decides what content is writable, requires sanitization, or needs projection.
6. `session-transcript-repair.ts` fixes protocol issues such as missing/isolated tool results.
7. `assistant-error-transcript.ts` together with terminal error records turns failures into typed session facts.

## 4. Key Objects and Contracts

| Object | Fact | Note |
| --- | --- | --- |
| transcript entry | Committed messages/events | Ordered, branchable, replayable |
| session row | Session metadata and current branch | Do not mix with sessionKey |
| writer | Current write privilege | Non-writers cannot append/rewrite |
| rewrite | One historical transformation | Must be atomically committed and retain boundaries |
| tool pair | Call and result | Isolated calls are not allowed |
| terminal error | Run outcome | Cannot be disguised as normal assistant reply |
| branch | Historical branch | Current branch must be specified when reading |

### Append and Rewrite

- Append is suitable for new messages, tool results, normal terminations;
- Rewrite is suitable for compaction, repair, and branch rewrites;
- Both are subject to writer permission constraints;
- Rewrite must first construct a complete new history and then atomically publish it; you cannot delete or change entries one by one, exposing readers to intermediate states.

### Why errors must also be recorded

If the provider fails, a tool rejects, or an abort writes no facts, the next round cannot know what happened or explain why there was no reply. Errors should be typed transcript events, not blanks.

## 5. One Observable Chain

```text
accepted candidate messages
  → tool result pairing / redaction
  → append or rewrite plan
  → writer authority check
  → SQLite transaction / branch publication
  → transcript cursor
  → reply/event projection
```

## 6. Experiment

### Experiment A: Comparing append and compaction rewrite

After a normal response, append a message; observe rewrite after triggering compaction. Reference acceptance: append retains the original historical structure; rewrite atomically replaces the view while preserving boundaries/recent tail.

### Experiment B: Isolated tool call

Delete a tool result or have the tool skip without generating a result. Acceptance criteria: Fix/verify logic finds missing pairs, refuse to publish illegal history.

### Experiment C: Writing by the Old Writer

After supersede the old run, let it try to append. Acceptance criteria: writer checks for rejected writes and does not produce interleaved entries.

### Experiment D: Incorrect Posting

Let the provider return a terminal error. Acceptance criteria: record the typed error, do not write it as a normal assistant success text; subsequent recovery should be able to recognize the terminal state.

### Experiment Reference Answers

1. append retains the original history; compaction rewrites the view atomically while preserving boundaries and recent tails, and cannot be partially written.
2. Tool calls missing results should be checked/fixed or rejected from release; illegal history cannot be left behind.
3. An old writer should be rejected by the writer fence when trying to append, to avoid interleaving entries.
4. provider terminal error should be written as typed error, it cannot be disguised as normal assistant success text.

## 7. Failure and Recovery

| Failure | Factual Risk | Recovery |
| --- | --- | --- |
| rewrite half-submit | readers see incomplete history | atomic publish/rollback staging |
| Old writer added | Interleaving and repetition | Refuse writing rights, retain superseded |
| tool result missing | protocol illegal | fix or supplement synthetic result |
| Error not posted | Unable to explain final state | Write typed terminal event |
| Branch read error | Continue based on sibling history | Bind current branch/cursor |
| Schema migration failed | Database unreadable | Fail closed, migrate/backup first |

## 8. Self-Assessment for Passing

1. What is the difference between a transcript and a prompt?
2. Why must the transcript rewrite be released atomically?
3. What scenarios are append and rewrite each suitable for?
4. Why does a terminal error also need to be included in the transcript?
5. Why can't a non-current writer append?
6. What can a branch read error cause?

### Reference Answer

1. A transcript is a persistent session fact, while a prompt is the current projection generated from the transcript, system prompt, and pruning rules. Projections can be reconstructed, but the submission of a transcript must be subject to writer and transaction constraints.
2. Readers may see missing messages, isolated tool calls, or partial summaries in intermediate states. Atomic releases guarantee that the history is either the complete old version or the complete new version.
3. append is used to add new messages/results/final states; rewrite is used for compaction, repair, and branch-level historical transformations. Both must go through the writer and verification.
4. Otherwise, the system cannot explain why the run did not succeed, whether it can be retried, or whether the error has been exposed to the user; a blank history will also make the next round mistakenly think that it never occurred.
5. The writer is the sole owner of write authority. Writes by non-writers will interleave with the current run, disrupting order, tool pairing, and final state causality.
6. The system may read old messages from a sibling branch, treating abandoned history as the current context, leading to repeated tool calls or incorrect completion judgments.

## 9. Source Code Coordinates

- `src/agents/sessions/agent-session-transcript.ts`
- `src/agents/embedded-agent-runner/transcript-rewrite.ts`
- `src/agents/embedded-agent-runner/run/session-bootstrap.ts`
- `src/agents/transcript-policy.ts`
- `src/agents/session-transcript-repair.ts`
- `src/agents/assistant-error-transcript.ts`
- `src/state/openclaw-agent-db-schema.ts`
- `src/state/openclaw-agent-db-session-migrations.ts`
- `src/state/openclaw-agent-session-snapshots-schema.ts`

## 10. Next Steps

Enter Stage 7: Beyond the transcript, how do plugins, MCP, Skills, channels, and UI extend the system without copying the kernel?
