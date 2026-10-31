---
title: "Stage 9: Capstone Project"
description: "Stage 9: Capstone Project. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: Hermes Agent Source Code Course · Stage Test  
> Prerequisite: Stages 0–8  
> Corresponding Overview: Full Test  
> Goal of this Stage: Complete a small modification spanning tools, persistence, host inspection, and failure recovery, and be able to verify it with evidence.  

## 1. Project Task: Recoverable Project Notes

Implement a `project_note` tool that only works for the current session/workspace, and add a read-only `session audit` viewing capability.

Functionality:

~~~text
project_note(action="append", text="...")
  → generate note receipt (note_id, hash, session_id)
  → Write an append-only notes file
  → Return tool result

project_note(action="list")
  → Only return notes for the current session/workspace

session audit
  → associated with admission / lease / tool call / tool result in SessionDB
  → Reconcile with notes file receipt
  → Output interpretable state without modifying any ledger
~~~

This topic seems simple, but it simultaneously covers stages 1 through 8:

- admission and lease: who can execute, whether it has been executed;
- toolset and schema: what the model can see, parameter boundaries;
- persist-before-execute: the call comes first, then side effects;
- context: how tool results return to the model;
- provider: results remain auditable after failure/model switch;
- SessionDB: association between call/result and note receipt;
- Extension: read-only audit commands for CLI/TUI;
- Engineering: crash points, idempotency, path safety, and testing.

## 2. First, remember one rule

**The note file is an external side effect, SessionDB is the record of calls, audit is just aligning the two; none of the three can forge each other.**

Do not:

- directly modify unknown to success using `session audit`;
- only write notes into tool results without saving to external files;
- assume a call has been persisted just by looking at the note file;
- deduplicate on retry based only on text content without using a stable call id.

## 3. Design boundaries

### 3.1 Tool side

- Tool name: `project_note`;
- actions: `append`, `list`;
- append requires `text`, with length, character/path safety restrictions;
- list does not accept arbitrary session ids, can only read the session bound to the current turn;
- tools are only added to explicitly authorized toolsets;
- visibility of `delegate`/cron is determined by the toolset, cannot be open by default to the entire platform.

### 3.2 File layout

It is recommended to use profiles to isolate paths:

~~~text
$HERMES_HOME/session-notes/<session_id>.jsonl
~~~

Each line is an append-only JSON record:

~~~text
call_id
note_id
session_id
workspace_key
text_hash
text
created_at
~~~

Constraints:

- Do not return the host's absolute path to the model, only return note_id/hash and logical location;
- Session ID must pass security validation and cannot be constructed as `../`;
- Writes must use per-session file locks with flush/fsync;
- Repeating the same `call_id` must return the same receipt;
- The same `call_id` with different text must report a conflict and cannot overwrite.

### 3.3 Audit Aspect

Add read-only `session audit` capability, which can first be implemented as a CLI command, and later integrated with TUI or RPC as needed. Output:

~~~text
session_id / canonical parent-child
admission status / request id
lease holder / expires_at (diagnosis only)
tool call id / name / args hash
Does the tool result exist?
whether the note receipt exists and the hash matches
Final assistant row / delivery receipt (if any)
~~~

Audit commands do not call models, do not rush turn leases, and do not fix the database. They only read and interpret. 

## 4. Three invariants that must be maintained

1. **Call First, Side Effects Later**: When SessionDB does not have canonical calls, the tool cannot generate notes. 
2. **Power Orders Are Determined by Call ID**: The same call retries yields the same receipt; Different calls cannot be mistakenly merged just because the text is the same. 
3. **Audit only reconciles accounts, not changes**: If you see a call missing a result, a note missing a receipt, or a hash inconsistency, you can only report the status and take a clear recovery. 

## 5. Source code access point

| Changes | Main Positions | Need to Reuse |
| --- | --- | --- |
| tool handler/schema | `tools/` | Parameter validation, error format |
| Tool Visibility | `toolsets.py`, `model_tools.py` | platform, authorization, schema |
| Call Persistence | `agent/turn_tool_round.py` | persist-before-execute |
| Execution and Results | `agent/tool_executor.py` | timeout, pairing, commit |
| session binding | `agent/turn_context.py` | canonical session id |
| Ledger Inquiry | `hermes_state.py::SessionDB` | messages, admission, lease |
| CLI/RPC Entry | `hermes_cli/`, `tui_gateway/` | read-only command, profile scope |
| Testing | `tests/tools/`, `tests/gateway/`, `tests/tui_gateway/` | Failure, recovery, agreement |

Don't create a new session query tool just for this topic; Prioritize reusing `SessionDB` existing public methods. 

## 6. Implementation sequence

### Step 1: Pure Functions and File Formats

- Define the note record schema; 
- Implements call_id deduplication, collision detection, and text hashing; 
- Write path validation and append-only read. 

### Step 2: Tool contract

- Implement `append` / `list`; 
- Strict schema, rejecting unknown fields; 
- Error classification: unauthorized status, invalid parameters, conflicts, IO failure, corrupted files. 

### Step 3: Integrate Toolset

- Exposed in the allowed toolset; 
- Verifying that `get_tool_definitions()` can be seen; 
- Verify platform limitations and visibility of sub-agents. 

### Step 4: Persistent Linkage

- Use real `run_tool_round` to verify call and place the queue first; 
- Confirm that the handler will not be called when call flush fails; 
- Confirm turn termination when the result commit fails. 

### Step 5: Audit Command

- Read admission, lease, tool messages, note receipts; 
- Output `consistent / call_without_result / result_without_note / note_without_result / collision / unknown`; 
- No automatic bypass repair is provided. 

### Step 6: Resume testing

- Crashes before append; 
- Crashes after append or before result; 
- Crashes after result or before final; 
- duplicate call/different text; 
- lease lost; 
- compression: changes in canonical session after rotation. 

## 7. Acceptance criteria

### 7.1 Functional Acceptance

- The same Call ID is replayed N times, and the notes file contains only one record; 
- Different call IDs can write the same text and obtain different note_id; 
- Conflicts between different text messages within the same Call ID; 
- Two sessions are invisible; 
- List will not read notes from other profiles. 

### 7.2 Safety Acceptance

- `../`, absolute paths, control characters, and oversized text are rejected; 
- Do not expose credentials or complete host paths in logs/errors; 
- Unauthorized platforms/sub-agents cannot see the tool; 
- Audit commands should not be used to secure leases or write transcripts. 

### 7.3 Restoring Acceptance

- call unpersistent→ handler zero call; 
- Notes written, result not persisted→ Replay returns the existing receipt, then submit the result; 
- Corruption at the end of the file → Report and refuse to silently rewrite; 
- admission `unknown` → Read-only audit provides evidence, not inventing successfully; 
- Session rotation → Use the canonical session to find the correct notes and ledger. 

### 7.4 Project Acceptance

- Comprehensive testing of units, integration, recovery, and protocols; 
- `ruff` Clean; 
- Temporary `HERMES_HOME` Medium Run Through; 
- Can provide a one-time end-to-end trace; 
- Documentation explains failure semantics and idempotent keys. 

## 8. Experiment

### Experiment A: Replay the idempotent

The same `call_id` is executed 10 times in a row. 

### Experiment B: Crash after append

After the note is successfully written and before tool result persistence, the process is terminated and restored via canonical call. 

### Experiment C: Audit Inconsistency

Handmade `call_without_result`, confirm `session audit` with clear reporting, rather than automatically fixing it. 

### Experiment D: provider fallback

After calling `project_note`, the next provider request fallback, confirming that call/result in the history still matches notes receipt. 

### Experimental Reference Answers

1. **Experiment A**: The notes file contains only one record; Returns the same note_id/hash 10 times. If the text changes, a collision should be reported. 
2. **Experiment B**: Replay the existing note via call ID and return the same receipt, then submit the tool result; Do not add the second item. 
3. **Experiment C**:audit outputs `call_without_result`, listing call id, session, time, and related note status. Repair actions must follow a clear recovery process. 
4. **Experiment D**: The fallback only changes the context of subsequent providers/requests, without altering the persisted tool history or notes receipt; audit can still be aligned. 

## 9. Pass through customs and self-test

1. Why must idempotent keys use the call ID, and not just text hashes? 
2. Which is the source of fact: Note Files or SessionDB? 
3. What should be done when the call has been persisted, the note has been written, and the result has not been persisted? 
4. `session audit` Why must it be read-only? 
5. Why can't the list accept any session ID? 
6. After compression rotation, how does audit find the same session chain? 
7. Why can't this question only test the tool handler? 
8. If the last line of a note file is corrupted, why can't it be automatically truncated and then continued? 

### Reference answers

1. Duplicate text does not mean the same intent; Users may intentionally write the same content twice. Call ID is the stable identity for "this model call," enabling safe deduplication and collision detection. 
2. Each has its own type of fact: SessionDB has call/result/session state, notes files have external side effect collections; audit aligns both. No single party can prove the full chain. 
3. Read existing receipts with the same Call ID to avoid duplicate additions; Submit existing receipts as tool results. If the integrity of the file cannot be confirmed, report and fail closed. 
4. Because audits must be safe for use at fault sites; Automatic "fixing" masks unknowns, repetitive side effects, or double-writes, requiring changes through an independent recovery process. 
5. This breaks session isolation and may leak other session content; Only the currently bound and resolved canonical session can be used. 
6. Find the canonical child through parent/child relationship and resume parsing, while retaining the parent session source; Save the actual bound session/workspace key in the notes record. 
7. Because the real risk lies beyond the handler: whether the tool is visible, whether the call is stored first, whether the actuator is paired, whether the result is canonical, whether lease loss and compression rotation are safe. 
8. Last-line corruption may only be half a written record, or it could indicate inconsistent content from earlier; Automatic truncation will permanently obscure evidence. Isolation/reporting should be done before clear fixing. 

## 10. Source code coordinates

- `toolsets.py`
- `model_tools.py::get_tool_definitions`
- `agent/turn_tool_round.py::run_tool_round`
- `agent/tool_executor.py::_commit_tool_result`
- `agent/turn_context.py::_bind_turn_identity`
- `hermes_state.py::SessionDB`
- `gateway/session_authority.py::SessionAuthority`
- `gateway/run_turn_runner.py::TurnRunner`
- `tui_gateway/prompt_turn.py`
- `tests/tools/`
- `tests/gateway/`

## 11. Graduation defense

Without reading the document, complete the following five-minute explanation: 

1. What layers does an append request go through from the entry point to the note file? 
2. At what moment did external side effects occur? What lasting facts must have existed beforehand? 
3. How do you recover at each of the five crash points? 
4. Which states can be automatically determined by audit, and which must be manually verified? 
5. If you request support for cron/child agents, how would you limit visibility and ownership? 
6. If you request a change of provider, which areas must never be affected by fallbacks? 

Only those who can answer these six questions and present the test and trace are considered complete for this paper.
