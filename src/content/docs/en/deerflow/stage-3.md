---
title: "Stage 3: Context and Memory"
description: "Stage 3: Context and memory. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: DeerFlow Source Code Class · Stage Test
> Prerequisite: Stage 2
> Corresponding Overview: Context section of `core-mechanisms.md`
> Goal of this stage: Distinguish current messages, compressed results, checkpoints, and long-term memory.

## 1. What this stage addresses

The model does not automatically "remember items." Each round only sees the projected context:

~~~text
ThreadState.messages
  Dynamic Date/Memory/Skill Reminder
  Current tool results
  - Old content over budget
  → This model request
~~~

DeerFlow uses various middleware to handle "what to inject," "what to compress," "how many tokens to spend," and "which results can be replayed." 

## 2. Remember one judgment first

**The current context is the projection, the checkpoint is the recovery point, and the memory is the cross-session fact.** 

The three have different lifecycles. If you treat memory as the current window, it will be repeatedly injected; If you treat checkpoint as chat history, events and deliveries will be lost; If you treat journal as model context, audit data will be stuffed into the prompt. 

## 3. Source code main storyline

1. `agents/thread_state.py` Defines the graph state, with the core being message and runtime fields. 
2. `DynamicContextMiddleware` Inject dynamic reminders such as date and memory before and after the first HumanMessage to keep system prompts stable. 
3. `MemoryMiddleware` Recovers facts that can be retained long-term in `after_agent`; `agents/memory/manager.py` Responsible for the backend. 
4. `SummarizationMiddleware` Measure and compress history before model calls to generate summaries to continue the conversation. 
5. `TokenBudgetMiddleware` Set a hard upper limit on the entire round budget; `TokenUsageMiddleware` Record actual usage. 
6. `DurableContextMiddleware` Make critical dynamic contexts recoverable, rather than existing only in a single request. 
7. Worker saves graph status in Checkpoint; `RunJournal` Saves running events and delivery facts. 

## 4. Key Objects and Contracts

| Object | Save content | Typical error |
| --- | --- | --- |
| `ThreadState.messages` | Current Graph Message | Treats the UI list as the model context |
| summarization Summary | Compressed Continuing Dialogue View | Treat the summary as the original archive |
| checkpoint | Graph State and Identity Recovery | Replace with a business database |
| memory | Cross-session preferences/facts | Full injection per round |
| `RunJournal` | Events, tokens, tools, delivery | Let the model read directly |
| token budget | This round's cost cap | Usage limit is limited only at the UI layer |

## 5. An observable link

~~~text
checkpoint read history
  → DynamicContext / memory injection
  → token measurement
  → Summarization Compress
  Tool Result Budget
  → Model Request
  → usage record
  New checkpoint
~~~

Key observation: `messages` shortening does not necessarily mean data loss; it may be a projection before sending; Checkpoint still retains recoverable state, journal still retains facts. 

## 6. Experiment

### Experiment A: Create a single compression

Lower the summarization threshold and send a sufficiently long conversation. Reference acceptance: If a summary or compressed tag appears in the model request, the original event can still be found as evidence on the journal/checkpoint link. 

### Experiment B: Compare memory switches

Close `MemoryMiddleware` and repeat the same session. Reference observation: The current message remains, but the cross-session preference injection disappears; This indicates that memory and transcript are two separate paths. 

### Experiment C: Validation tool outputs budget

Allows the tool to return the extra-large text. Reference acceptance: The model sees truncated/summarized results, while the tool receipt can still locate the original output and truncate the facts. 

### Experimental Reference Answers

1. The request side should have a summary or compressed tag; The original history should still be kept by journal/checkpoint/event chain; compression cannot destroy audit evidence. 
2. After closing memory, the current transcript still exists, but cross-session preference injection disappears; This proves that memory is an additional injection channel, not the session message itself. 
3. Model-side outputs should be bounded, and receipt/logs can still locate the original result and truncate facts; Truncation is explicit information, not silent loss. 

## 7. Failure and recovery

| Failure | Where the Facts Are | Principle of Restoration |
| --- | --- | --- |
| Compression model failure | Original message and compression event | Retain the original history, retry or downgrade |
| Context still overruns | Token estimation and provider error | Remeasure, don't pretend compressed |
| memory write failure | Current candidate fact | Do not block the main run, record failure |
| Checkpoint Corruption | Journal and Event | Rebuild from recoverable points, do not forge messages |
| Dynamic context duplication | Injecting middleware and first message | Deduplication, no modifying the original history |

## 8. Pass through customs and self-test

1. Why does `messages` being short mean losing history? 
2. Can Checkpoint, Journal, and Memory replace each other? 
3. Why should dynamic contexts avoid breaking system prompt prefixes as much as possible? 
4. Do tool output budgets and context compression solve the same problem? 

### Reference answers

1. `messages` is the projection sent to the current model round, which may have undergone summarization, tool output truncation, or dynamic injection. The recovery state is still at the checkpoint, and the process facts remain in the journal; Shortening the projection does not mean the canonical history has been deleted. 
2. No. Checkpoint manages graph recovery, Journal manages process and auditing, Memory manages cross-session preferences; They face different lifecycle and consistency goals. 
3. Stable prefixes benefit prompt cache, reproducibility, and auditing. Placing variable content like dates and memories in controlled locations can avoid rewriting the entire system prompt every round. 
4. No. Context compression handles window pressure for message history; Tool output budget limits single tool results and aggregated results. Both affect tokens, but the target and recovery semantics differ. 

## 9. Source code coordinates

- `backend/packages/harness/deerflow/agents/thread_state.py`
- `backend/packages/harness/deerflow/agents/middlewares/dynamic_context_middleware.py`
- `backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py`
- `backend/packages/harness/deerflow/agents/middlewares/memory_middleware.py`
- `backend/packages/harness/deerflow/agents/memory/manager.py`
- `backend/packages/harness/deerflow/runtime/journal.py`

## 10. Next

Entering Stage 4: After the model sees the context, it decides to call the tool. Where does the tool ultimately run?
