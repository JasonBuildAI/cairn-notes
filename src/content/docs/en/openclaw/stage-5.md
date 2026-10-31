---
title: "Stage 5: Model Validation, Fallback, and Harness"
description: "Stage 5: Model validation, fallback, and harness. Understand facts, contracts, observable evidence, and failure recovery along the main line of the source code."
---

> Course: OpenClaw Source Code Class · Stage Assignment
> Prerequisite: Stages 2–4
> Corresponding Overview: Model integration part in `core-mechanisms.md`
> Goal of this stage: Distinguish model parsing, authentication, candidate chains, model fallback, and harness selection.

## 1. What this stage solves

"Which model to use" is far more than reading a string. OpenClaw needs to parse:

- Which provider/model corresponds to the logical model ref;
- Which auth profiles the current account has;
- When the first candidate fails, whether to switch credentials, change models, or surface the error;
- Which harness can support this provider, model, and tool policy;
- If an explicit plugin harness fails, whether it can fall back to the built-in OpenClaw;
- Whether the output of failed candidates can pollute the final transcript.

## 2. Remember one rule

**Model fallback switches routes within the same harness; harness fallback switches execution runtime.**

The former usually keeps the tool loop and session protocol unchanged, while the latter may change steering, tool strategy, session mapping, and capabilities. Both must ensure that only accepted candidates advance the transcript.

## 3. Source code mainline

1. `model.ts::resolveModelAsync()` Parse provider/model, workspace, registry, and authentication context.
2. `model-resolution.ts` and `model-fallback-candidates.ts` Generate candidate chains.
3. `run/model-setup.ts` Freeze model ownership and auth selection for this run to prevent drift after preparation.
4. `embedded-agent-runner/run/attempt.ts` Execute candidates; failure handled by rotate/fallback/surface decision.
5. `harness/selection.ts` Parse explicit or auto harness, validate provider/model/tool policy support.
6. `harness/auto-selection.ts` First filter out clearly unsupported candidates, then select by priority.
7. `harness/builtin-openclaw.ts` Provide built-in fallback; if plugin harness does not declare lossless fallback, failure defaults to fail closed.

## 4. Key objects and contracts

| Object | Purpose | Cannot do |
| --- | --- | --- |
| model ref | Logical model identity | Treat provider error as model non-existence |
| auth profile | Account/credential selection | Switch accounts without record after failure |
| candidate chain | Sequence of models/routes that can be attempted | Infinite retries or repeated side effects |
| harness | Actual execution runtime | Bypass unified tool policy |
| selection decision | Reason for selecting/rejecting a harness | Trust based solely on id or same name |
| fallback policy | Rule for failure transfer | Treat harness fallback as model fallback |

### Auto harness selection order

```text
Enumerate registered plugin harness
  → Check provider/model/tool policy/operational capability
  → Remove explicit-only or clearly unsupported ones
  → Select the highest priority
  Stable sort by id within the same priority
  Return to built-in OpenClaw when no plugins are available →
```

"Available" does not mean "registered." Supporting conditions, authentication, platform capabilities, and policies can all make it unavailable.

### Failed Candidates and Transcript

After a candidate fails, you cannot write its partial assistant output into the final history. Only candidates that are accepted and can continue the conversation can advance the transcript; the rest of the failures should be kept as diagnostics/candidate events and must not be mixed into the final message sequence.

## 5. An Observable Path

```text
model ref
  → resolve provider/model
  → auth profile
  → candidate chain
  → harness selection
  → attempt
  → error? rotate/fallback/surface
  → accepted candidate
  → loop continues
  → transcript commit
```

During debugging, record each candidate provider, model, auth profile, harness, error type, and whether it was ultimately accepted, rather than just looking at the last error. 

## 6. Experiment

### Experiment A: Voucher Rotation

Allows the first auth profile to return a rotatable error. Reference acceptance: replace credentials but maintain the same harness/session protocol; failed configurations are not marked as successful. 

### Experiment B: Model fallback

Make the main model unavailable and configure alternative models. Reference acceptance: Candidate chain switching, tool loop continues; The final transcript only accepts valid messages from the model being accepted. 

### Experiment C:harness auto selection

Register two plugins with different support conditions for harness. Reference acceptance: filter out unsupported plugins, select by priority/id; If all are unavailable, return to the built-in OpenClaw. 

### Experiment D: Explicit plugin failed

Explicitly specify the plugin harness, but let it fail and fail without declaring OpenClaw as a lossless fallback. Reference acceptance: fail closed and expose errors, without secretly switching runtimes. 

### Experimental Reference Answers

1. The first auth profile can rotate if there is an error, the credential should be replaced and the same harness/session protocol maintained; Bad credentials cannot be recorded as successful. 
2. When the main model is unavailable, switching along the candidate chain allows the tool loop to continue; Only valid messages from the accepted model enter the final transcript. 
3. Auto selection filters unsupported harnesses, then selects by priority/id; When all are unavailable, it returns to the built-in OpenClaw. 
4. If the explicit plugin harness fails and does not declare a lossless fallback, it must fail closed, exposing errors and not secretly switching the runtime. 

## 7. Failure and recovery

| Failure | Check first | Restore |
| --- | --- | --- |
| Model does not exist | registry/resolveModelAsync | Fix model ref/provider |
| Authentication failure | auth profile and error type | rotation or request to log in again |
| Candidate repeat execution | candidate/admission idempotency | Only one accepted effect is allowed |
| Plugin Harness Not Compatible | support conditions | Switch to harness or the built-in fallback |
| Failure output pollution history | transcript commit boundary | Only submit accepted candidate |
| Ownership Drift | model/auth tuple | Reprepare, don't mix up old conversations |

## 8. Pass through customs and self-test

1. What is the difference between Model Fallback and Harness Fallback? 
2. Why does "registering for Harness" not mean "Auto will select it"? 
3. How to choose the same priority stably? 
4. Why does the explicit plugin Harness fail by default? 
5. Why can't the failed candidate assistant output enter the final transcript? 
6. What is the difference between auth profile rotation and model fallback? 

### Reference answers

1. Model fallback: Swap models/credentials/routing within the same runtime, usually maintaining tool loops and session protocols; Harness fallback: Swap runtime, possibly changing protocols, policies, and session mappings. 
2. You must also meet conditions such as provider/model, tool policy, platform capability, explicit-only, and health. Registration only indicates existence; support conditions determine whether it can be safely executed. 
3. Sort by priority, then by stable ID for the same priority; Do not rely on the random order of registration traversal. 
4. Plugin harness failures may not be lossless; switching runtimes may change tools/steering/context semantics. Unless the plugin explicitly states that OpenClaw is a lossless fallback, failures should be exposed. 
5. It may be incomplete, incorrect, or rejected output. Writing the final history allows subsequent models to continue based on failed candidates and also breaks the boundary of "only accepted candidate advances the session." 
6. Credential rotation still uses the same provider/model route, only swapping accounts/keys; Model fallback changes to the model or provider, which may change capabilities, context windows, and output formats. 

## 9. Source code coordinates

- `src/agents/embedded-agent-runner/model.ts`
- `src/agents/embedded-agent-runner/model-resolution.ts`
- `src/agents/model-fallback-candidates.ts`
- `src/agents/embedded-agent-runner/run/model-setup.ts`
- `src/agents/embedded-agent-runner/run/attempt.ts`
- `src/agents/harness/selection.ts`
- `src/agents/harness/selection-decision.ts`
- `src/agents/harness/auto-selection.ts`
- `src/agents/harness/builtin-openclaw.ts`

## 10. Next

Entering Stage 6: After the model and tools are all running, which messages, tool results, errors, and summaries are actually written into the transcript? Who guarantees that only one valid history is submitted per run?
