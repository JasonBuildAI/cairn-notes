---
title: "Stage 9: Capstone Project"
description: "Stage 9: Capstone Project. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: DeerFlow Source Code Course · Stage Paper
> Pre-position: Stage 0~8
> The goal of this stage: no longer "understand" it, but to complete an end-to-end transformation that can be explained, verified, and restored. 

## 1. Task Positioning

Choose one of the following three questions. Common requirements: do not bypass `start_run`, do not directly call the host shell, and do not forge the successful final state. 

| Title | Modification Points | Main Source Code |
| --- | --- | --- |
| A. New read-only audit tool | Tool registration + middleware + receipt | `tools/`, `middlewares/` |
| B. Added Controlled Channel Entry | Input Normalization + Multiplexing Order Acceptance | `app/channels/`, `services.py` |
| C. New Delivery Validation Experiment | workspace changes + receipt | `worker.py`, `routers/thread_runs.py` |

## 2. Five must-answer design questions

1. What is the source of new capabilities? 
2. Who has the right to create/modify it? 
3. Will it change the Run state or cause external side effects? 
4. After failure, which receipt/journal can prove progress? 
5. Which actions must never be repeated? 

Write the answer before the code changes. If you can't answer, it means you haven't found the boundary yet. 

## 3. Reference Scheme A: Read-only audit tools

**Method**: 

- Define a read-only tool with strict parameters in `tools/`; 
- Join according to permissions during Agent assembly; 
- Use existing tools like middleware to ensure parameters, output budgets, and receipts; 
- Do not add a Run state, and do not write workspace. 

**Acceptance Points**: 

- Tools are invisible when not authorized; 
- Ultra-long output is bounded and called by receipt records; 
- The tool fails and returns a structured result, and the graph can continue; 
- No new successful end-state paths are generated. 

## 4. Reference Plan B: Controlled channels

**Method**: 

- The adapter is only responsible for making external messages uniform `RunCreateRequest`; 
- Generate stable idempotent keys and source metadata; 
- Call `start_run`, reuse lease, events, and return routes; 
- Clearly handle duplicate messages and failed replies to them. 

**Acceptance Points**: 

- Replaying the same external message does not cause two side effects of Run; 
- Permissions and model whitelists are still determined by the server; 
- Reply to deliveries/events that only consume Run, without changing the final state yourself. 

## 5. Reference Scheme C: Delivery Validation

**Method**: 

- Observe `_produced_output_paths`, delivery content, and receipt; 
- Constructing cases where "models claim completion but no product"; 
- Reconstruct real cases written and presented; 
- Record the differences between the two terminal states. 

**Acceptance Points**: 

- Without products, it cannot be cleanly successful; 
- When there is a product, the receipt can find the path; 
- Restart/replay will not run a delivered run again. 

## 6. Failure and recovery drills

At least one demonstration is required: 

- Cancellation before work starts; 
- Manufacturing failure after tool execution; 
- Create write interrupts before and after receipt; 
- Explain why the old worker can't continue writing. 

Reference recovery principles: **Read the facts first, then decide which step to supplement; Submitted effects are not redone.** 

## 7. Deliverables

- One change description: boundary, source of fact, failure path, recovery path; 
- A set of tests or repeatable experiments; 
- An end-to-end timing diagram; 
- A boundary list of "I didn't change anything." 

## 8. Pass through customs and self-test

1. Why don't you bypass your transformation `start_run`? 
2. How do the side effects caused by new abilities prove to occur? 
3. If a process crashes before delivery, how does the restorer decide not to rerun the tool? 
4. Is the code you modified belong to Harness or the app? Why? 

### Reference answers

1. Because the entry only translates input and calls the unified order receiving port, permissions, powers, model whitelist, lease, events, and delivery are consistent; Any new entry that is bypassed will form a second state machine. 
2. Forming a chain through tools such as receipt, journal events, workspace products, and delivery receipts; Model text is only a declaration, not evidence. 
3. Read RunRecord, journal, and checkpoint to confirm whether the tool/delivery fact has been submitted; Only fill in the missing phase; submitted external side effects cannot be replayed. 
4. Ability to extract from specific product entry points and be reusable by other hosts for deployment of Mount Harness; Assembled placement apps that rely on a certain Web/IM/scheduling implementation. Boundary testing is the final judgment. 

## 9. Source code coordinates

- `backend/app/gateway/services.py`
- `backend/app/gateway/routers/thread_runs.py`
- `backend/packages/harness/deerflow/runtime/runs/worker.py`
- `backend/packages/harness/deerflow/runtime/journal.py`
- `backend/packages/harness/deerflow/runtime/checkpoint_state.py`
- `backend/packages/harness/deerflow/agents/middlewares/tool_receipt.py`
- `backend/tests/test_run_journal.py`
- `backend/tests/test_tool_receipt_middleware.py`

## 10. Scoring criteria

| Dimension | Pass | Excellent |
| --- | --- | --- |
| Lifecycle | Can describe from admission → terminal state | Can explain each failure window |
| Trust boundaries | Does not forge owner/terminal state | Can identify client-forgeable points and seal them |
| Tool security | Goes through middleware/sandbox | Has idempotent and readback design |
| Evidence | Has logs | Has receipts and can replay experiments |
| Engineering | Tests pass | Covers boundaries, recovery, negative cases |

## 11. Last Sentence

The core of DeerFlow is not 'make the model use the tool a few more times', but **turn one Agent execution into a Run that can be accepted, isolated, recovered, audited, and delivered**. The graduation project must demonstrate that you uphold this statement.
