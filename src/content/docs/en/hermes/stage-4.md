---
title: "Stage 4: Tools and PersistBeforeExecute"
description: "Stage 4: Tools and Persist Before Execute. Understand facts, contracts, observable evidence, and failure recovery along the main source code path."
---

> Course: Hermes Agent Source Code Class · Stage Exam
> Prerequisite: Stages 2 and 3
> Corresponding Overview: `turn-lifecycle.md` Section 9, `core-mechanisms.md` Section 3
> Goal of this stage: Trace the model's tool calls to the visible tool table, persistence boundaries, executors, result backfill, and failure termination.

## 1. What this stage addresses

Tool calls are the easiest point at which 'dialogue errors' can escalate into 'real-world side effects.' Hermes's core constraint is:

~~~text
Model proposes tool call
  Visibility/Parameter/Batch Verification
  → assistant call first enter canonical transcript
  Tool Execution
  Persist again
  Next-generation model
~~~

This is not 'run first, then log,' but **persist-before-execute**: if a destructive tool is executing and the process restarts halfway, upon recovery it must already be able to see 'I requested this call to be executed.'

## 2. First, remember one principle

**The factual order of tool calls is 'call gets recorded first, side effects occur afterward'; if persistence fails, side effects must not proceed.**

Therefore, the following alternatives are not allowed:

- Execute in memory first, then batch write to the DB upon success;
- Do not write the call if the tool fails;
- If the tool succeeds but writing the result fails, still let the model see the in-memory result;
- Arbitrarily delete a previously sent tool call to make a pairing.

## 3. Source code mainline

1. `toolsets.py` Define toolset, include relationships, platform restrictions, and tool collection.
2. `model_tools.py::get_tool_definitions()` Based on enabled/disabled toolsets, dynamic schema, aliases, and platform, generate tool definitions visible to the model.
3. Tool visibility does not equal authorization; before execution, there are still parameter validation, approval, pre-write checks, budget, and guardrails.
4. `agent/turn_tool_round.py::run_tool_round()` Then `validate_tool_calls()`, handle truncation, mixed invalid batches, and duplicate calls.
5. Only perform ID normalization, batch expansion, deduplication, and delegate quantity limits on tool calls in this round that have not yet been persisted.
6. `stage_tool_call_message()` Construct assistant tool-call rows, then immediately `_flush_messages_to_session_db()`.
7. If flush fails, the turn ends with `session_persistence_failed`, and the tools will not execute.
8. Executor chooses concurrent, sequential, or segmented according to batch semantics, preserving original order, approval, timeout, and result pairing.
9. Each tool result is written back via the commit path; if the result cannot become canonical, `_incremental_persistence_failed` will terminate this round instead of sending the in-memory result to the model.
10. Tool post-processing may trigger compression, then move to the next API round.

## 4. Key objects and contracts

| Object | Responsibility | Invariant |
| --- | --- | --- |
| toolset | Declare the tools that can be exposed | Cannot bypass platform/authorization |
| `model_tools.get_tool_definitions` | Generate schema and cache key | The visible set must be interpretable |
| `validate_tool_calls` | Structure, name, truncation, batch validation | Invalid calls must still have a result or explicitly terminate |
| `stage_tool_call_message` | Generate call message | Before any side effects |
| `_flush_messages_to_session_db` | Turn call into canonical form | Stop on failure |
| `execute_tool_calls_*` | Schedule real execution | Order, approval, timeout, pairing |
| tool result commit | Write back results | The model cannot see unpersisted results first |
| `session_persistence_failed` | Explicit failure reason | Cannot be disguised as ordinary model failure |

Mixed batch rules: assistant messages retain all previously sent tool calls because each call requires a result; calls with invalid names will receive an error result but will not enter actual execution. This both maintains pairing and prevents invalid tools from executing.

## 5. An observable trace

~~~text
assistant_message.tool_calls
  → validate_tool_calls
  → expand batches / dedupe / cap delegate
  → normalize ids
  → stage assistant call
  → flush call to SessionDB
       fail → session_persistence_failed
       ok   → execute
  → approval / policy / timeout / budget
  → commit each tool result
       fail → session_persistence_failed
       ok   → append to messages
  → compress after tool results (optional)
  → next API iteration
~~~

Observation points: Before "Processing N tool call(s)" appears in the log, parameter validation has already been done; there should be a successful persistence before actual execution. Printing tool results does not mean they have been canonicalized; one must check the commit/flush results.

## 6. Experiments

### Experiment A: Mixed batch with invalid tool names

Have the model return in the same batch one valid read-only tool and one non-existent tool.

### Experiment B: Persistence fails before execute

In the test, let `_flush_messages_to_session_db()` throw an error, and set a real side-effect probe for the tool.

### Experiment C: Tool deliberately times out

Execute a tool that will exceed the batch timeout and observe whether the result is still paired in a timeout/incomplete form.

### Reference answers for experiments

1. **Experiment A**: Valid tools execute normally; invalid tools get an error tool result but do not go into real execution. The assistant row still retains both calls to maintain pairing.
2. **Experiment B**: The side-effect probe should not be triggered; the turn ends with `session_persistence_failed`. Because the call did not become canonical, the system cannot pretend it didn't happen and then execute it later.
3. **Experiment C**: The executor should submit a result indicating termination/incompletion rather than leaving an isolated call; subsequent model reasoning can interpret it, but already occurred side-effects still need readback.

## 7. Failures and recovery

| Failure | Fact occurred | Correct recovery |
| --- | --- | --- |
| Invalid JSON parameters | Not executed | Generate error result, maintain pairing |
| Tool not visible | Not executed | Reject and indicate available tools |
| Call persistence failed | Not executed | Terminate turn, no side effects |
| Approval rejected | Not executed | Generate reject result |
| Execution timeout | Partial side effects possible | Mark result as timeout; external system readback |
| Result persistence failed | Side effects may have occurred | Terminate; check real status first, cannot retry blindly |
| Process crash inside tool | Call persisted, result unknown | Recover using call + external system evidence |
| Lease lost | Execution rights uncertain | Hard interrupt; new owner reconciles first |

## 8. Self-check

1. Why must tool calls be persisted before tool execution?
2. Why generate a tool result for an invalid tool name?
3. Why can't memory results be sent to the model when result persistence fails?
4. What must concurrent, sequential, and segmented execution modes all ensure?
5. After a tool times out, why can't we assume it "did not execute"?
6. Is an approval rejection a failure or an interpretable result?

### Reference answers

1. Because tools may have destructive side effects. Writing the call first ensures that after a process restart, the system knows "this execution was initiated"; combined with result/external state, it can determine if it completed. Executing first risks total loss if a crash occurs.
2. Because the provider requires that every assistant tool call has a corresponding result. Missing results break the message alternation structure and may make subsequent requests illegal; an error result does not authorize execution.
3. Because the canonical transcript and in-memory projection no longer match. Sending unpersisted results to the model would continue reasoning based on irrecoverable facts, and subsequent replay would not see them, causing state divergence.
4. All must maintain the original call intent, call/result pairing, approvals and policies, timeout semantics, result submission order, and failure termination; concurrency is just the scheduling method, it does not change the persistence contract.
5. Timeout only indicates the call did not return within the deadline; side effects may occur before timeout, during execution, or after return. The target system or idempotent key must be checked first before deciding on completion or error reporting.
6. Approval rejection is a clear, interpretable result, tool not executed; it is not a system crash. A reject result should be generated so the model knows the boundary.

## 9. Source code coordinates

- `toolsets.py`
- `model_tools.py::get_tool_definitions`
- `agent/turn_tool_round.py::run_tool_round`
- `agent/turn_tool_round.py::stage_tool_call_message`
- `agent/tool_executor.py::execute_tool_calls_concurrent`
- `agent/tool_executor.py::execute_tool_calls_sequential`
- `agent/tool_executor.py::execute_tool_calls_segmented`
- `agent/tool_executor.py::_commit_tool_result`
- `tests/tools/test_timeout_transport_drain.py`
- `tests/gateway/test_chat_completions_approval.py`

## 10. Next step

Proceed to phase 5: with tools and requests ready, when provider calls fail, how to use credential rotation, retry, and fallback to recover without breaking the context.
