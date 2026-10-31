---
title: "Stage 4: Capability, Provider, and Host"
description: "Stage 4: Capability, Provider, and Host. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: LoopX Source Code Course · Stage Paper
> Prerequisite: Stage 3, understanding Turn Envelope and seven-stage transactions
> Overview of Corresponding Tools: `core-mechanisms.md` Tools and Extensions
> Goal of this stage: Distinguish between three types of responsibilities: "domain rules," "external implementation," and "candidate executors." 

## 1. This stage addresses what to address

After the Turn plan is established, the next step is to hand over the work to the Host. But the Host is only the executor, not the judge of fact. LoopX uses a three-tier division of labor to avoid "the model says done, and it's done": 

- Capability: Define what constitutes success, what evidence is needed, and how failure is classified in this field; 
- The Provider declares whether it can provide an implementation and executes a typed effect/readback; 
- The host receives a bounded request and outputs a candidate typed result. 

The same model can have different hosts, and the same capability can have multiple providers. The kernel only recognizes contracts, not any specific model brand. 

## 2. Remember one judgment first

**Host outputs candidate results, Capability defines acceptance semantics, and Provider provides controlled implementation.** 

The three cannot replace each other. Host cannot directly write a canonical state; Provider cannot bypass validation and settlement; Capability should not secretly execute undeclared side effects. 

## 3. Source code main storyline

1. `capabilities/registry.py` Register the provider, capability, and implementation, and verify the lifecycle sequence. 
2. `capabilities/catalog.py::get_capability()` Parse currently available domain contracts from the directory. 
3. `control_plane/capability_hooks.py::project_turn_context()` Projecting the competency requirements into the context of this round. 
4. `turn_driver/executor.py::build_loopx_turn_host_request()` Generate a Host request, declaring that only the first two stages are allowed to be completed in this round. 
5. `validate_loopx_turn_host_result()` Check Result Kind, Evidence, Path Delta, Completed Phases, and Completion Lifecycle. 
6. `run_loopx_turn_once()` Connect Host execution, validation, writeback, consumption, and scheduling. 

## 4. Key Objects and Contracts

### The Four Lifecycles of Providers

| Status | Meaning | Legal Change |
| --- | --- | --- |
| `declared` | The directory knows it will provide a certain capability | Declare it first before installing |
| `installed` | Installed on this machine | Cannot say "installed but not declared" |
| `enabled` | Current policy allows the use of | It cannot be "Enabled but Not Installed" |
| `ready` | Health Checks and Dependency Satisfaction | Cannot be "ready but not enabled" |

Four layers are not synonyms. `enabled` only means the policy is enabled, `ready` means it can currently be safely called. 

### Capability's contract with Host

| Contract | Must express | Not allowed |
| --- | --- | --- |
| Success Conditions | What observable facts prove completion | Replace "I feel good" in natural language |
| Evidence Requirements | Types of evidence, scope, and content that can be public-safe | Stuffing private paths or secrets into the evidence |
| Error classification | Validation, host, writeback, spend, etc. types | All exceptions are classified as "Failed" |
| typed transition | Legitimate migration of progress/completion/repair/replan | Skip repair and declare completion directly |
| Host request | route, Todo, gate, output schema, resume condition | Let the Host expand the scope itself |
| Host result | Candidate outcome, evidence, completion stage, lifecycle intent | Let the Host claim that it has written back or consumed |

### Hard constraints on Host results

- `completed_phases` can only be `host_execute` and `typed_result`; validation, writeback, or spend cannot be claimed. 
- `validated_completion` must include the lifecycle adapter, successor/active goal, or the full intent of `no_followup`. 
- Non-material results should not include evidence, path delta, or progress observation, avoiding "waiting but secretly advancing." 
- Host result has a read limit of `HOST_RESULT_MAX_BYTES = 12_000`; an oversized output cannot be directly turned into reality. 
- The result must be bound to the same `turn_key` and `effect_ref` files; you cannot combine another round of receipts. 

## 5. An observable link

```text
Capability record
  → required provider / evidence / transition
  → provider lifecycle: declared → installed → enabled → ready
  → project_turn_context
  → host request(scope + schema + completed_phases[:2])
  → host execution
  → candidate result
  → validate_loopx_turn_host_result
  → validation phase
```

When debugging, first check whether the Provider is stuck at installed, enabled, or ready, then check whether the Host is overstepping to claim subsequent stages. Do not merge the two into a single 'tool unavailable.'

## 6. Experiments

### Experiment A: Disrupting the Lifecycle Order

Construct the Provider of `enabled=true, installed=false`. Acceptance criteria: the registry clearly refuses registration rather than letting the Host run halfway before noticing. Then verify that `installed=true, declared=false` is also refused.

### Experiment B: Observing Host Request Boundaries

Print `build_loopx_turn_host_request(plan)`. Acceptance criteria: requests only allow the Host to complete the first two stages and include scope, output schema, evidence requirements, and stop conditions; they must not include kernel private state write access.

### Experiment C: Forging Completion Results

Submit `validated_completion` without providing a lifecycle adapter or subsequent intent. Acceptance criteria: validation fails and indicates missing lifecycle/subsequent fields; it must not degrade into silently successful progress.

### Experiment D: Validating Result Size

Have the Host return output exceeding 12,000 bytes. Acceptance criteria: the read phase reports an explicit error or truncates to a diagnosable failure rather than interpreting a partial JSON as a complete result.

### Reference Answers for Experiments

1. `enabled=true, installed=false` and `installed=true, declared=false` should both be refused at the registry stage, not waiting for runtime failures.
2. Host requests only include content that can be completed in the first two stages, along with scope, output schema, evidence requirements, and stop conditions; they must not carry kernel private write access.
3. If `validated_completion` is present but the lifecycle adapter or subsequent intent is missing, validation should fail and should not degrade into progress or silent success.
4. Outputs exceeding 12,000 bytes must explicitly error or form a diagnosable failure, and partial JSON must not be treated as a complete typed result.

## 7. Failures and Recovery

| Failure | Responsibility | Recovery |
| --- | --- | --- |
| Provider not installed | Registry and installation status | Install and re-probe, skipping disabled |
| Provider not ready | Health check/dependencies | Fix dependencies, pass capability gate |
| Host overclaims stage | Host result and plan | Validation rejects, retains journal |
| Completion without lifecycle | Typed result | Convert to a valid progress or complete subsequent contract |
| Non-material includes evidence | Result schema | Refuse inclusion, reissue typed result |
| Host output too large | Executor boundary | Have Host reduce output or save reference |
| Provider crashes after call | Effect/readback receipt | Read back first, prohibit blind repeated side-effects |

## 8. Self-Check

1. What are Capability, Provider, and Host each responsible for?
2. Why does the Provider have declared/installed/enabled/ready states?
3. Why can't the Host write `completed_phases` as all seven stages complete?
4. Why must `validated_completion` have a lifecycle adapter?
5. Why can't non-material results include evidence?
6. Once the Provider has executed but the process crashes, why can't it simply retry?

### Reference Answers

1. Capability defines domain success conditions, evidence, error classification, and typed transitions; Provider offers lifecycle management, controlled effects, and readback; Host uses models and tools to perform bounded work and only produces candidate results.
2. The four states answer different questions: whether known to the catalog, installed, policy-enabled, and currently healthy/usable. Merging them can misinterpret 'declared' as 'runnable' or execute when dependencies aren't ready.
3. The Host can only prove execution and production of typed results. Validation, write-back, quota consumption, and scheduling must be submitted by the kernel in order; letting the Host declare completion bypasses evidence, idempotency, and recovery boundaries.
4. Completion closes the lifecycle or schedules subsequent actions, needing to know who continues, how the active goal changes, or whether `no_followup`. Completion without an adapter cannot safely be recorded and should be rejected rather than guessed.
5. Material fields participate in evidence verification, path changes, and progress write-back. Waiting or failed results including these fields could be misinterpreted as progress; the contract requires purity according to result kind.
6. External effects may have occurred, but receipt is not submitted. Direct retry might duplicate files, messages, or consume resources; must first check through readback/journal whether the effect exists, then proceed with idempotent recovery.

## 9. Source Code Coordinates

- `loopx/capabilities/registry.py`
- `loopx/capabilities/catalog.py`
- `loopx/control_plane/capability_hooks.py`
- `loopx/control_plane/turn_driver/executor.py`
- `loopx/control_plane/turn_driver/host_candidate.py`
- `loopx/control_plane/turn_driver/turn_contract_generated.py`
- `loopx/control_plane/turn_driver/transaction.py`

## 10. Next Steps

Enter Stage 5: Candidate results have been generated, but 'whether the evidence is sufficient, when to write back, when to consume, how the scheduler applies/acks' have not yet been resolved. The next phase will specifically break down settlement.
