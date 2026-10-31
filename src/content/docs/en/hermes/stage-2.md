---
title: "Stage 2: Conversation Loop"
description: "Stage 2: Conversation Loop. Understand facts, contracts, observable evidence, and failure recovery along the main line of the source code."
---

> Course: Hermes Agent Source Code Class · Stage Test
> Prerequisite: Stage 1
> Corresponding Overview: `turn-lifecycle.md` Sections 7–9
> Goal of this stage: Expand 'a single model call' into 'a synchronous turn that can be stopped, retried, and can execute tools'.

## 1. What is solved in this stage

Obtaining the lease only indicates that it can be executed, but it does not indicate how to execute it. Hermes's main loop needs to handle simultaneously:

- When can the model be viewed again?
- How to proceed to the next round after using the tool;
- `max_iterations`, token budget, interrupt, how to stop compression failure;
- Where do API retry and fallback exit the retry loop;
- After an abnormal loop exit, who is responsible for closing the transcript and results?

## 2. First, remember a judgment

**Loop is not `while model_has_tool_calls`, but a phase machine with multiple gates.**

Each round goes through the same stages, but any stage can be expressed through a verdict `continue / break / return`. Understanding the verdict is more important than memorizing the while condition.

## 3. Main Source Code Line

1. `agent/turn_facade.py`'s `run_conversation()` first cancels the background review of the same session, establishing relay/accounting/interrupt scope.
2. It calls `admit_durable_turn_lease()`; after obtaining the lease, it executes `lease.start()`, and then calls `agent/conversation_loop.py::run_conversation`.
3. `_run_conversation_turn()` First `build_turn_context()`, obtain the local variables for this round, such as messages, system prompt, history, task/turn id, etc.
4. Clear per-turn state at the entry: interim deduplication, persistent failure flags, compression adoption failures, credential refresh counts, etc., to prevent cache Agent cross-talk.
5. Construct `_LoopState`, and then handle optional special execution paths, such as `codex_app_server` and the scripted prelude.
6. The main loop condition is the number of iterations and `iteration_budget.remaining`, and one explicit grace call is allowed.
7. Each round passes through `begin_iteration → prepare_iteration → assemble_api_request → run_preflight_gate` in turn.
8. Enter `_run_api_retry_loop()` after passing through the gate: `build_api_request → perform_api_call → handle_api_error`.
9. After response normalization, if there is `tool_calls` go to `run_tool_round`, otherwise go to `finish_text_response`.
10. After the loop exits, call `finalize_turn()` uniformly; even if the loop ends due to budget, error, or interruption, the results and transcript must be closed.

## 4. Key Parties and Contracts

| Object | Responsibility | Cannot do |
| --- | --- | --- |
| `TurnFacadeMixin` | Lease, relay scope, outer finally | Execution model tool loop |
| `_LoopState` | All mutable local variables in this round | Are reused across turns |
| `PreflightGateVerdict` | Whether to call, retest, or terminate | Directly send request to provider |
| `ApiCallVerdict` | Streaming/Non-streaming Call Results | Determine Context Compression Strategy |
| `ApiErrorVerdict` | retry/fallback/terminate | bypass preflight and directly switch provider |
| `ToolRoundVerdict` | Whether the tool round continues/ends | Skip call/result pairing |
| `finalize_turn` | Results, transcript tail, post-processing | Recover lost lease |

Key invariant:

- Try to keep the bytes stable across API calls within the same round of context;
- After the tool ends, it can be compressed, but compression is an explicit context boundary;
- Every `return` must have a result field, and every `break` must be handed over to the finalizer;
- The outer `finally` must release the lease, even if the loop throws an exception.

## 5. An Observable Link

~~~text
TurnFacade.run_conversation
  → cancel background review
  → admit lease
  → lease.start
  → conversation_loop.run_conversation
  → _run_conversation_turn
  → build_turn_context
  → while budget:
       begin_iteration
       prepare_iteration
       assemble_api_request
       run_preflight_gate
       retry loop:
         build_api_request
         perform_api_call
         handle_api_error
       normalize response
       tool round OR finish text
  → finalize_turn
  → lease.stop/join/clear/release
~~~

By observing a log, you can see: under the same `turn_id`, there may be multiple `api_call_count`, and after each API cycle, it may be rounded with a tool; Only after the loop exit does finalize begin. 

## 6. Experiment

### Experiment A: Single-round text reply

Make the model return only text, recording whether `api_call_count`, tool rounds have occurred, and finalize has been executed. 

### Experiment B: Answer after one round of tools

Let the model first call the read-only tool, then respond based on the result. Observe whether the second round of API messages adds assistant tool call and tool result. 

### Experiment C: Exhausting the Iteration Budget

Set `max_iterations` to very small and observe whether grace calls are still allowed; the final result is normal completion, budget exits end, or exceptions. 

### Experimental Reference Answers

1. **Experiment A**: There should be only one successful API call without a tool round, then the transcript will still be finalized to close the transcript. 
2. **Experiment B**: In the first round, the assistant's tool call and corresponding tool result must be persisted first; In the second round, the model sees the paired history and then generates the final text. 
3. **Experiment C**: Loop conditions are jointly determined by the number of iterations and `iteration_budget`, `_budget_grace_call` can provide an opportunity to finish; After exhaustion, the finalizer produces explanatory results instead of letting the loop continue indefinitely. 

## 7. Failure and recovery

| Failure | Location of Occurrence | Recovery Point |
| --- | --- | --- |
| preflight compression timeout | Before API call | Returns compression timeout results and retains transcript |
| provider Retry Errors | retry loop | Increment retry; Rerequest |if necessary
| Fallback activated | error handler | Leave the retry loop and re-enter preflight |
| Tool parameters are illegal | tool round | Generate a pairing error result, continue or end |
| Tool Execution Interrupt | executor | Complete any unfinished/skipped tool results |
| persistence failure | Before tool execution | `session_persistence_failed` Terminates, side effects are prohibited from continuing |
| Budget exhaustion | Main loop condition | grace/finish, finalize Additional explanation |
| lease lost | backend refresher | hard interrupt, old loop stops |

## 8. Pass through customs and self-test

1. How are the responsibilities of `TurnFacadeMixin`([`agent/turn_facade.py`) and `conversation_loop` divided? 
2. Why do we have to redo the preflight every round, instead of just once at the start of the turn? 
3. What is the difference between `action=break` and `action=return`? 
4. Why does a tool call increase `api_call_count`? 
5. Why do you still need to finalize after exiting the loop? 
6. Which states must be cleared at the start of each turn? 

### Reference answers

1. `TurnFacadeMixin` Manages leases, outer scope, backend review mutually exclusive, and finally cleanup; `conversation_loop` Manages current context, API retry, tool rounds, and finalize, which is the core of synchronous execution. 
2. Because tool results, compression, and fallback all change the request size or provider context window; Before sending a request, you must reassess whether it fits. 
3. `return` Ends directly with a complete result; `break` Only exits the current loop/retry loop; afterwards, the finalizer must be submitted or the next stage must be closed together. 
4. After the model returns tool calls, Hermes executes the tool and writes these messages back to history, then initiates the next model request; Each model request counts as an API call. 
5. Because the model stopping does not mean the turn is complete. It is necessary to restore the streaming text, close the transcript tail, process budget interpretation, persist post-processing, and output the final result. 
6. Includes interim deduplication sets, incremental persistence failure, compression adoption failure, one-shot reasoning status, credential refresh count, and current round usage. 

## 9. Source code coordinates

- `agent/turn_facade.py::TurnFacadeMixin.run_conversation`
- `agent/conversation_loop.py::_run_conversation_turn`
- `agent/conversation_loop.py::_run_api_retry_loop`
- `agent/conversation_loop.py::run_conversation`
- `agent/turn_context.py::build_turn_context`
- `agent/turn_preflight.py::PreflightGateVerdict`
- `agent/turn_tool_round.py::run_tool_round`
- `agent/turn_finalizer.py::finalize_turn`
- `tests/agent/test_context_token_tracking.py`

## 10. Next

Entering Stage 3: After entering the loop, `messages` does not equal the bytes sent to the provider; the system prompt, API sidecar, and compression together determine what the model actually sees.
