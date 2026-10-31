---
title: "Stage 3: Context Compression and Pruning"
description: "Stage 3: Context compression and pruning. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: OpenClaw Source Code Class · Stage Roll  
> Prerequisite: Stage 2  
> Corresponding overview: Context section of `core-mechanisms.md`  
> Objective of this stage: Distinguish the owners and side effects of system prompt, workspace bootstrap, compaction, and cache-TTL pruning.  

## 1. What this stage solves

Each model request can only see a limited context. OpenClaw faces four types of pressure simultaneously:

- system prompt and workspace bootstrap getting longer and longer;  
- transcript exceeding the model window;  
- old tool results occupying a large number of tokens;  
- tool directories, channel prompts, and dynamic dates changing every turn, which breaks cached prefixes.  

Not all of these pressures can be solved by "deleting messages." Different layers modify different objects, and the recoverability also differs.  

## 2. First, remember a judgment

**Compaction rewrites the historical view, cache-TTL pruning only modifies the projection of this prompt.**  

The former affects the transcript seen in subsequent rounds; the latter does not write to disk history and can still be reconstructed from the original text after a restart. Confusing the two leads to incorrect judgments about whether "the original text is still there."  

## 3. Source code mainline

1. `buildAgentSystemPrompt()` Assembles the stable prefix, dynamic suffix, and tool/channel descriptions, and generates `stablePrefixCacheKey`.  
2. Content above the cache boundary remains stable; date, session, channel, and runtime prompts are placed in the suffix to avoid invalidating the entire prefix.  
3. `bootstrap-files.ts` Parses workspace files, hooks, budgets, and injection mode, injecting project context into controlled locations.  
4. `prepareCompaction()` Measures the context, retains the recent tail, and selects the middle history that needs to be summarized.  
5. `compact()` Calls the summarization model; `compactWithoutSummary()` if summarization fails, still retains the recent original text and inserts an explicit downgrade marker.  
6. `tool-result-truncation.ts` Cache-TTL pruning replaces expired tool results with placeholders or truncates/saves references when limits are exceeded.  
7. Transcript rewrite is submitted by harness/runner; pruning only generates request projections without modifying the canonical history.  

## 4. Key objects and contracts

| Object | Owner | Modified object | Recoverability |  
| --- | --- | --- | --- |  
| system prompt stable prefix | agent/system prompt | each round prompt | rebuildable |  
| bootstrap context | workspace bootstrap | current round context | rereadable from file |  
| compaction summary | harness/agent-core | historical/transcript view | depends on summary and original text strategy |  
| kept recent tail | compaction | tail of history | retains recent original text |  
| cache-TTL pruning | embedded runner | projection of this prompt | original text on disk still exists |  
| spill file | tool-result truncation | large external result | can be re-read via path |  

### Default budget for compaction

The source code defaults to `reserveTokens: 16384`, `keepRecentTokens: 20000`. The trigger is not "feeling too long" but estimating that the context exceeds `contextWindow - reserveTokens`. The retained tail must be able to accommodate a complete message atom, and cannot cut a half tool pair.  

### Placeholder semantics of pruning

`CACHE_TTL_DEFAULT_PLACEHOLDER = "[Old tool result content cleared]"` is a projection marker for the model to see. Images also have a separate marker. It indicates "do not send old content this time," not "the history has been deleted."  

## 5. An observable chain

```text
transcript + bootstrap + system prompt
  → estimate context
  → compaction? (rewrite history view)
  → cache-TTL pruning? (Clear old tool result projection)
  → truncate oversized results? (projection/write to disk)
  → provider request
```

During debugging, you should look at the disk transcript, messages sent to the provider, and the pruning checkpoint at the same time. Reading only one will lead to incorrect conclusions. 

## 6. Experiment

### Experiment A: Compare compaction with pruning

Constructs a long history containing the old tool result. Triggers compaction and cache-TTL pruning respectively. Reference acceptance: After compaction, the historical view shows a summary/boundary; After pruning, the disk transcript remains unchanged, but only the request projection shows placeholder. 

### Experiment B: Summary Failure to Degrade

Make the summary model error. Reference acceptance: Go `compactWithoutSummary()`, keep the recent original text and insert a clear prompt saying "No summary deleted," rather than silently losing history. 

### Experiment C: Stabilizing Prefixes

Change the date or channel prompt, compare `stablePrefixCacheKey`. Reference acceptance: For dynamic fields, the key remains unchanged when the suffix is used; If the key changes, it means the field has been placed in stable prefix. 

### Experiment D: Tool result exceeds limit

Allows the tool to return oversized text. Reference acceptance: Even if the model receives a truncation or spill reference, the receipt can still locate the original output; Do not treat the half-section as the complete result. 

### Experimental Reference Answers

1. compaction: Change transcript/view semantics and generate summary boundaries; cache-TTL pruning: Only modify the current prompt projection; the original transcript remains unchanged. 
2. If the abstract fails, leave `compactWithoutSummary()`, keep the recent original text and explicitly state that no abstract is deleted; do not silently lose history. 
3. Dynamic fields such as date and channel should be in the postfix `stablePrefixCacheKey` and not change because of them; If they change, it means the field is misaligned in the hierarchy. 
4. The model side should receive truncation or spill references, and the original output can still be located; Half-cut content must not be disguised as a complete result. 

## 7. Failure and recovery

| Failure | Where are the facts | Recovery |
| --- | --- | --- |
| Abstract failed | Original transcript + compaction boundary | Downgrade retains recent original |
| Context still overruns the window | Usage/estimation and provider error | Re-measure, cannot pretend to succeed |
| History "disappears" after pruning | Disk transcript | Reconstructing the projection from canonical |
| stable prefix jitter | cache key/dynamic suffix | Move the variable field to the boundary |
| Large tool result truncation | spill Citation /truncation marker | Read the original text back by path |
| Bootstrap changes not detected | Workspace files/versions | Reconstruct context and record source |

## 8. Pass through customs and self-test

1. What are the owners and modification objects of compaction and pruning? 
2. Why is it still possible to see the full old tool result after rebooting after pruning? 
3. Why can't the entire history of compaction be discarded directly when the summary fails? 
4. Why can't dynamic dates be placed in Stable Prefix? 
5. `keepRecentTokens` What is it protecting? 
6. What is the relationship between bootstrap files and transcripts? 

### Reference answers

1. Compaction is a historical mechanism of harness/agent-core, rewriting the transcript view and generating a summary; Pruning is a request projection for the embedded runner, only replacing the old tool result in this prompt. 
2. The placeholder for pruning only exists in messages sent to the model; the disk transcript has not been rewritten. When rebooting or changing requests, you can reproject from the canonical history. 
3. Discarding all history causes the model to lose task facts and incomplete work. The correct downgrade is to keep recent originals, insert a clear "delete without summary" prompt, and let the system know the summary is incomplete. 
4. Each date change changes the entire prompt prefix and cache key, causing the provider prefix cache to become invalid. It should be placed in the dynamic suffix after the cache boundary. 
5. It protects recent complete messages and tool call/result pairing, ensuring the model still understands the current work and does not cut off half a message due to the summary. 
6. Bootstrap is a context projection parsed from a workspace file, not a transcript. It can be rebuilt each round, with sources and truncations being traceable. 

## 9. Source code coordinates

- `src/agents/system-prompt.ts`
- `src/agents/bootstrap-files.ts`
- `packages/agent-core/src/harness/compaction/compaction.ts`
- `src/agents/sessions/agent-session-compaction.ts`
- `src/agents/embedded-agent-runner/tool-result-truncation.ts`
- `src/agents/embedded-agent-runner/transcript-rewrite.ts`
- `src/agents/embedded-agent-runner/run/session-bootstrap.ts`

## 10. Next

Entering Stage 4: The model has seen the context and decided to call the tool. Who assembles the tool, who approves it, and where is the isolation of execution?
