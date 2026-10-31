---
title: "Stage 8: Engineering, Testing, and Recovery"
description: "Stage 8: Engineering, testing, and recovery. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: LoopX Source Code Class · Stage Test
> Prerequisite: Stages 5–7
> Corresponding Overview: `engineering.md`
> Objective of this phase: Use testing, journals, atomic writes, and recovery audits to prove that the system still upholds the contract under failures.

## 1. What is solved in this stage

The difficulty in control lies not in the successful path, but in these situations:

- The host crashed immediately after execution;
- Writeback succeeded but spend not submitted;
- Two workers attempt to own the same Turn at the same time;
- The state file was only half written;
- Restore package path escape or member type unsafety;
- The projection version has changed, but the old receipt still needs to be readable.

LoopX handles it with 'typed contract, ordered journal, readback, fail-closed,' rather than guessing based on logs.

## 2. First, remember a judgment

**Recovery is not a rerun, but reading the committed prefix and only filling in the missing stages; any prefix that cannot be verified is regarded as unknown and blocked.**

The goal of engineering is not to make all failures automatically succeed, but to make failures categorized, bounded, auditable, and free from repeating side effects.

## 3. Main Source Code Line

1. `turn_journal.ts` Check whether the journal identity, lineage, and completed phases have an ordered prefix, and whether the status is consistent with the phase.
2. `recovery.py::assess_existing_turn_recovery()` Form a typed recovery decision, `require_turn_recovery_continuation()` refuse to continue if it is illegal.
3. `recovery_audit` Record planned vs actual to avoid trace-free overwriting during the recovery process.
4. `runtime/document_io.py::atomic_write_state_text()` Use temporary files/atomic replacement with durability check to protect state writes.
5. `state_recovery_io.py` Check the path, link, member type, size, and checksum before unpacking; if it fails, do not create the target.
6. Test layered fixed behaviors according to 'Plan/Receipt/Status Recovery/Projection/Public Safety', such as `test_turn_loop_disposition.py`, `test_state_recovery.py`, `test_state_refresh_projections.py`.

## 4. Key Parties and Contracts

| Object | Guarantee | On Failure |
| --- | --- | --- |
| Turn journal | There is a single log for the planned and actual phases | Blocked if inconsistent |
| `completed_phases` | Ordered, continuous committed prefix | Jumping/disordered is invalid |
| effect readback | External effects observable | Do not assume occurrence if not observed |
| atomic write | The reader will not see a half-written file | Retain old file / Clean up staging |
| recovery audit | Recovery actions can be planned/actual | Cannot be silently rerun |
| contract tests | result kind, phase, public safety stability | regression exposed immediately |
| archive validation | Path, type, size, digest restricted | Fail closed before writing |

### The difference between a journal and a regular log

Ordinary logs can have missing lines, be out of order, and are only for human viewing; a journal is a recovery contract. It must be bound to a turn_key, lineage, planned stage, and actual stage, and its status must be clear. Writing a lot of logs does not make a journal reliable.

### Atomic Writing and 'Looks Like It Writes Successfully'

Calling `write_text` only once may leave a half-written file in the event of a crash. Atomic writing first writes a temporary file, checks the content/permissions, and then replaces the target; the recovery package also needs to prevent symlinks, hardlinks, `..`, and oversized members from escaping during unpacking.

## 5. An Observable Link

```text
read journal
  → validate turn_key / lineage / phase prefix
  → inspect effect receipts / readback
  → recovery decision
  → if blocked: return typed refusal
  → if continuable: resume_from
  → execute only missing phases
  → append recovery audit
```

Debugging recovery issues: first answer whether the journal is consistent, then answer which effect has been acknowledged, and finally decide whether to retry.

## 6. Experiments

### Experiment A: Tampering with the Stage Prefix

Change `completed_phases` to a random order or missing items. Acceptance reference: recovery should be deemed invalid and blocked, without attempting to guess the missing stage.

### Experiment B: Simulating Half-Written Files

Interrupt during the atomic write temporary file stage, retaining the old target. Acceptance reference: the old state should still be readable, temporary files can be cleaned; the partial JSON should not be treated as the new state.

### Experiment C: Constructing Recovery Package Path Escapes

Include `../outside`, symlink, or abnormal member types. Acceptance reference: should be rejected before creating the target directory/unpacking, and the live state remains unchanged.

### Experiment D: Running Directed Tests

```powershell
pytest -q tests/test_turn_loop_disposition.py tests/test_turn_envelope.py
pytest -q tests/test_state_recovery.py tests/test_state_refresh_projections.py
```

Reference acceptance: test coverage plan stage, envelope budget, journal/status consistency, recovery package rejection, and projection recalculation.

### Experiment Reference Answers

1. `completed_phases` Disordered/missing items should be judged as invalid recovery and blocked, guessing to fill in is not allowed.
2. Partially written temporary files should not replace the old target; the old state should still be readable, the temporary file can be cleaned up, and partially written JSON should not be considered as new fact.
3. The recovery package must reject `../outside`, symlinks, and exceptional member types before creating the target or unpacking; the live state remains unchanged.
4. Directional testing should verify the planning phase, envelope budget, journal/status consistency, recovery package rejection, and projection recalculation; when the test fails, first identify which contract has been violated.

## 7. Failure and Recovery

| Fault | Handling | Prohibited |
| --- | --- | --- |
| journal missing lineage | block and require log repair | guess the same Turn |
| completed_phases jump | report structured violation | fill in intermediate phases |
| effect unreadable | marked as unknown, awaiting manual/external evidence | direct replay |
| Atomic write failed | Keep old state, clear staging | Overwrite with empty file |
| Recovery package is unsafe | Reject before unpacking | Unpack first then check |
| Test failed in public safety | Remove leaked fields / fix projection | Relax assertion masking |

## 8. Self-assessment for Passing

1. What is the key difference between a turn journal and a regular operation log?
2. Why must `completed_phases` be an ordered prefix?
3. When the effect has been executed but the readback is uncertain, why not just retry?
4. What failure mode does atomic write solve?
5. Why does the recovery package need to 'verify first and then unpack'?
6. How can a change prove that it has not violated the control plane contract?

### Reference Answer

1. A journal is a restoration contract and must be bound to turn identity, lineage, planned/actual stages, and determinable status; ordinary logs are only used for observation, and missing or out-of-order entries cannot serve as a basis for submission.
2. The seven stages have a causal order, and the prefix indicates 'submitted up to this point.' Jumping or disordering means it is impossible to determine whether the preceding effect occurred, and recovery may repeat side effects or bypass verification.
3. If the readback is uncertain, it indicates that it is unknown whether the effect has taken place. Retrying directly may result in duplicate file writes, message sending, or charges; you should first read the receipt/external state, and if it cannot be verified, fail closed.
4. It prevents readers from seeing partially written files, leaving corrupted targets after a crash, and keeps the old state available through temporary files/replacements/checksums.
5. Extracting itself will create directories, links, or consume resources. Malicious paths/member types may have already caused an impact. Paths, link targets, member types, sizes, and checksums must be checked before writing to disk.
6. Run the corresponding plan/receipt/recovery/projection test to confirm the phase sequence, result kind, journal consistency, public safety fields, and failure paths; then use a crash scenario to verify that only the missing effect is supplemented.

## 9. Source Code Coordinates

- `loopx/control_plane/turn_driver/turn_journal.ts`
- `loopx/control_plane/turn_driver/recovery.py`
- `loopx/control_plane/runtime/document_io.py`
- `loopx/control_plane/state_recovery_io.py`
- `loopx/control_plane/turn_driver/host_process.ts`
- `tests/test_turn_loop_disposition.py`
- `tests/test_turn_envelope.py`
- `tests/test_state_recovery.py`
- `tests/test_state_refresh_projections.py`

## 10. Next Steps

Enter Stage 9: Combine the previous seven stages, projection, recovery, and testing into a deliverable Capability design, rather than just staying at the reading stage.
