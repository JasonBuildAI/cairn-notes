---
title: "Stage 4: Tool Approval and Sandbox"
description: "Stage 4: Tool approval and Sandbox. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: OpenClaw Source Code Class · Stage Exam  
> Prerequisite: Stages 2–3  
> Corresponding Overview: The tools section of `core-mechanisms.md`  
> Goal of This Stage: Distinguish the four layers of tool assembly, call strategy, manual approval, and isolated execution, and master the order of before_tool_call.  

## 1. What this phase addresses

A model's suggestion of a tool call only indicates "what you want to do," not "what you are allowed to do." OpenClaw needs to answer:

- Whether this tool is assembled under the current agent/session/channel;  
- Whether the parameters comply with the policy and whether manual confirmation is needed;  
- Whether standard hooks can modify the parameters, and whether the approval examines the original or altered call;  
- When multiple tools run in parallel, who maintains batch consistency;  
- Where the actual execution occurs: host, sandbox, container, or remote;  
- How to generate paired tool results when calls are rejected/skipped.  

## 2. Remember one judgment first

**Policy determines "Is the rule allowed?", Approval determines "Is this call currently allowed?", Sandbox determines "Which isolation boundary executes it once allowed?".**

The three cannot replace each other. Approval passing does not mean the sandbox configuration is safe; the existence of a sandbox does not mean the tool should be allowed.  

## 3. Source code mainline

1. `agent-tools.ts` Assemble the tool directory according to agent, session, channel, capability/profile.  
2. `before_tool_call.policy.ts` Execute loop admission, owner probes, voice confirmation, and trusted policies.  
3. `before_tool_call.approval.ts` Handle approvals and final owner approval.  
4. Standard hooks run after approval and cannot pre-process the parameters before the approval sees them.  
5. `before_tool_call.decision.ts` Convert deny/defer/report/request results into a unified decision.  
6. `agent-loop.ts::executeToolCallGroups()` Apply batch-level serial, parallel, steering skips, and result pairing.  
7. `src/agents/sandbox/` Choose the execution boundary through backend, workspace authority, mount plan, environment sanitization, and security validation.  

## 4. Key objects and contracts

### Order of `before_tool_call`

```text
loop admission
  → owner probes
  → voice confirmation
  → trusted policies
  → approvals
  → normal hooks
  → final owner approval
```

This order cannot be changed: approval must come before the regular hook, and the final owner approval must be independently confirmed after the hook.

### Four Decision Semantics

| Decision | Meaning | Result |
| --- | --- | --- |
| `deny` | Explicit rejection | Generates a rejection result, not executed |
| `defer` | Postpone to execution boundary | Determined by subsequent owner/context |
| `report` | Report only, do not block | Continue execution, leave observation |
| `request` | Immediate request for manual approval | Wait for approval owner |
| skipped | Not started due to steering/termination | Generates paired synthetic result |

### Sandbox Layer

| Layer | Response |
| --- | --- |
| backend | Which type of executor: Docker/Podman/SSH/remote-shell/local |
| workspace authority | Which workspace can be mounted/read/write |
| mount plan | Which paths are read-only/read-write/hidden |
| env sanitize | Which secrets can enter subprocess |
| security validation | Whether configuration allows startup |
| lifecycle | Container creation, reuse, cleanup, and failure recovery |

## 5. An Observable Chain

```text
model tool call
  → tool lookup / profile
  → before_tool_call chain
  → decision
  → sandbox/backend selection
  → execute
  → tool result
  → transcript
```

Even if rejected, you must follow the "result" path; Otherwise, the transcript will have an isolated tool call, and subsequent models cannot continue. 

## 6. Experiment

### Experiment A: Modifying parameters before approval

Construct a standard hook to modify tool parameters. Reference acceptance: Approve and see the original call; After the hook, the final owner approval checks the modification results. Reversing the order means failure. 

### Experiment B: Compare deny/defer/report

Returns three types of decisions respectively. Reference acceptance: deny does not execute, defer is left at the boundary, report continues but there is an observation record; All three generate clear results. 

### Experiment C: Skip steering mode

Inject steering into the batch to prevent some calls from starting. Reference acceptance: Unstarted calls generate skipped/error results, the tool has been started, and no orphaned calls occur. 

### Experiment D: Sandbox Crossing the Line

Allows tools to access paths outside the workspace or read unauthorized secrets. Reference acceptance: mount/authority/env layers reject before startup; errors can be audited, and tools do not rely on self-checking. 

### Experimental Reference Answers

1. Approval must see the original call; If the hook modifies parameters, the final owner approval must check the modified result. Approval before modifying parameters will become invalid. 
2. deny does not execute; defer leaves a clear boundary; report continues but leaves an observation record. All three should produce interpretable results. 
3. The call has been started, but the unstarted call generates a skipped/error result; The batch must remain paired. 
4. Out-of-bounds paths, mount permissions, and secret environments should be rejected and audited by the authority/mount/env layer before startup, and cannot rely on tools for self-checking. 

## 7. Failure and recovery

| Failure | Root cause | Recovery |
| --- | --- | --- |
| Tool not assembled | Profile/capability mismatch | Repair assembly, do not forge calls |
| Approval after seeing the modified parameters | Incorrect hook order | Restoring approval before the hook |
| No result after rejection | Did not follow the unified result path | Rejected result of supplementary pairing |
| Batch Concurrency Conflicts | Ignore Sequential/Budget | Batch Level Serial/Rejection |
| Sandbox configuration is insecure | mount/env/backend Validation missing | Fail closed before startup |
| Container residue | lifecycle/Cleanup failure | Record and recycle, do not create again |

## 8. Pass through customs and self-test

1. What do tool assembly, policy, approval, and sandbox each answer? 
2. Why must approval be before normal hooks? 
3. What is the difference between final owner approval and a regular hook? 
4. What do deny, defer, report, and request each mean? 
5. Why does a tool generate a result when it is skipped by a steering tool? 
6. Why is a sandbox still needed after approval? 

### Reference answers

1. Assembly determines whether the tool exists; Policy determines whether the rule allows; Approval determines whether the current call is allowed by the manual/owner; Sandbox determines the execution of isolation and path/secret boundaries. 
2. Otherwise, the hook can first modify parameters or rewrite the context so that approval can see the "washed" call. Approval must target the original call, and the final owner approval after the hook is checked independently. 
3. A regular hook is an extension logic, not a permission holder; Final owner approval is the last independent release point, which must be confirmed after the hook and cannot be replaced by a hook. 
4. Deny directly rejects; defer delays to execution boundaries; report only records without blocking; request immediately requests manual approval. Skipped means steering/termination is not started. 
5. Tool call and result must be paired. Missing skipped results makes the transcript protocol invalid, and the model cannot correctly understand which calls are not executed. 
6. The approval response is "Is it allowed?" and does not guarantee the tool's security or that parameters will not cross boundaries. Sandbox continues to restrict workspace, paths, environments, and processes to prevent approved tools from causing excessive side effects. 

## 9. Source code coordinates

- `src/agents/agent-tools.ts`
- `src/agents/agent-tools.before-tool-call.policy.ts`
- `src/agents/agent-tools.before-tool-call.approval.ts`
- `src/agents/agent-tools.before-tool-call.decision.ts`
- `packages/agent-core/src/agent-loop.ts`
- `src/agents/sandbox/backend.ts`
- `src/agents/sandbox/workspace-authority.ts`
- `src/agents/sandbox/validate-sandbox-security.ts`
- `src/agents/sandbox/sanitize-env-vars.ts`

## 10. Next

Entering Stage 5: The tool runs under a certain harness/model. Model parsing, authentication, fallback, and harness choices How can you avoid running a run into two sets of semantics?
