---
title: "Stage 9: Capstone Project"
description: "Stage 9: Capstone Project. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: OpenClaw Source Code Class · Stage Assignment
> Prerequisite: Stages 0–8
> Corresponding Overview: Extended exercises of `engineering.md`
> Goal of this stage: Design an extension that can access the OpenClaw main chain and prove that it is still interpretable under concurrency, approval, fallback, and crash conditions.

## 1. What this stage addresses

The previous eight stages covered entry, loop, context, tools, models, transcript, and extensions. The real test is: given a new requirement, can one determine which layer it should extend and write the failure boundaries.

This design task: **add a "code review gate" channel/tool extension**. Users can request "review the current branch" through any channel. The system performs read-only checks, generates a review report, requests owner approval before high-risk changes, and sends the results back to the original channel.

The challenge is not invoking the model once, but:

- Determining which session the review task belongs to;
- Whether the read-only tool can truly isolate;
- How to persist the transcript once the report is generated;
- Who approves high-risk actions;
- Whether model/harness failures can be transferred without loss;
- How to avoid duplicate reviews or messages after disconnection or restart.

## 2. Remember a key judgment

**The first question in extension design is not "where to write the code," but "what new facts are added and who owns them."

If you add approvals, review results, or channel receipts, you must specify the owner, idempotent key, storage location, and failure recovery.

## 3. Source code mainline: integrate like a first-class citizen

1. Plugin registers channel/tool/hook in `src/plugins/` using only `openclaw/plugin-sdk/*`.
2. Channel ingress is normalized via `src/auto-reply/` or Gateway RPC, not written directly to the transcript.
3. Gateway routes via `sessionKey`, handles idempotency via `clientRunId`, and marks execution via `runId`.
4. Agent Loop only accepts assembled tools; review tools follow unified policy/approval/sandbox.
5. Read-only code uses workspace authority and read-only mount; do not assume "read" in tool name equals isolation.
6. Model candidates/harness selection follow existing selection and fallback contracts.
7. Reports, as assistant/structured results, are committed via the transcript writer.
8. Channel receipts use stable message id/idempotent acknowledgement; events are pushed through Gateway.

## 4. Key objects and contracts

### New Objects

| Object | Owner | Idempotency/Recovery |
| --- | --- | --- |
| review request | Gateway session/run | `clientRunId` deduplication |
| review tool invocation | agent tool layer | tool call id + runId |
| review report | transcript | writer submission |
| approval request | approval owner | approval id bound to run/tool call |
| channel delivery | ReplyDispatcher/adapter | message id/receipt |
| risk finding | report schema | stable fingerprint |

### Tool boundaries that must be defined

- `review.repo_read`: Read-only, limited workspace, cannot execute repository code;
- `review.test`: Executes in sandbox, restricts network, mount, and timeout;
- `review.comment_post`: External write operations must be approved and idempotent;
- `review.approve`: Owner-only, cannot be called by the model itself;
- Any file/write/push/merge tools should not appear by default in read-only review profiles.

### Failure Classification

| Type | Fact | Handling |
| --- | --- | --- |
| Access Denied | no run | return permission/parameter error |
| Model Failure | run has typed error | transfer or expose candidate |
| Tool Rejection | paired rejection result | continue or terminate based on policy |
| Approval Pending | approval pending | do not mark as completed |
| Sandbox Timeout | tool error result | retain evidence, allow fix |
| Report Commit Failed | history not committed | do not send "completed" reply |
| Reply Failed | transcript committed | retry sending only, do not rerun review |

## 5. An observable chain

```text
User: Review the current branch
  → channel ingress
  → chat.send / auto-reply dispatch
  → session lane
  → writer fence
  → review tool profile
  → sandbox readonly/test
  → model synthesis
  → report transcript commit
  → high-risk finding? approval
  → ReplyDispatcher
  Original Channel
```

Note that "review report generated" and "report delivered" are different facts; the former is referred to as transcript, the latter as reply receipt. 

## 6. Experiment: Six deliverables that must be completed

### A. Expand Positioning

Write a one-page explanation: Why it was made as a plugin channel/tool, rather than a new agent or new session system; List the gateway/runner contracts it reuses. 

### B. Tools and Approval Matrices

Label each tool with read/write, scope, whether approval is required, whether sandboxes are allowed, and failure result format. Acceptance criteria: The model cannot bypass read-only restrictions by renaming. 

### C. Concurrency and Idempotency

Repeat requests using the same `clientRunId`, concurrently run sessions twice, and click cancel during run. Acceptance criteria: up to one transcript reviewed, up to one external comment, no longer written by the old writer. 

### D. fallback experiment

Let the main model fail, candidate model succeeds; Then let the explicit plugin harness fail. Acceptance criteria: Model fallback continues the same run; Harness failure fails without declaring losslessness, without secretly switching runtimes. 

### E. Collapse recovery

Interrupt when the report has been submitted but the reply has not been sent. Acceptance criteria: Restores only replies without rerunning the review tool. Restarts again during approval pending; after approval, resumes the original run/tool call. 

### F. Test Matrix

At least covered: access idempotency, workspace boundary exceedance, approval rejection, tool pair, transcript submission, ReplyDispatcher repost, MCP/plugin unavailable, schema migration. 

### Experimental Reference Answers

1. It should specify the extended reuse of the Gateway/Runner contract, rather than the new Agent/Session; and list the states it does not own. 
2. The tool matrix must provide read/write, scope, approval, sandbox, and failure formats; Renaming does not change permissions. 
3. The same `clientRunId` can be reviewed at most once and at most one external comment; After cancellation/takeover, the old writer will no longer write. 
4. The model fallback continues the same run; If the explicit plugin harness is not declared lossless, it must fail closed. 
5. If the report has been submitted but the reply has not been sent, only reply; After restarting the approval pending, approval should continue with the original run/tool call. 
6. The test matrix must at least cover access idempotents, workspace boundary outreach, approval rejection, tool pair, transcript submission, ReplyDispatcher repost, MCP/plugin unavailable, schema migration. 

## 7. Failure and recovery

| Design Vulnerabilities | Consequences | Fixes |
| --- | --- | --- |
| Use channel id as session | Cross-channel context misalignment | Use Gateway sessionKey |
| Review tool writable repository | Read-only commitment expires | Workspace authority + read-only mount |
| Approval after hook | Parameter rewritten | Restored approval order |
| Reply before the report is submitted | Users see results that don't exist | First transcript commit, then ReplyDispatcher |
| Failed reply Replay review | Duplicate model/tool side effects | Only repost reply |
| Failed candidate writes transcript | Historical contamination | Only accepted candidate is submitted |
| MCP directory When available | Runtime failure | Connect health check /unavailable |

## 8. Pass through customs and self-test

1. Why should "reviewing current branches" reuse Gateway Session/Run instead of creating a new system? 
2. At what levels should the security boundaries of read-only tools be placed? 
3. Why must approval know the original tool call? 
4. What is the correct recovery when a report has been submitted but the response failed? 
5. What do model fallback and harness fallback affect in this design? 
6. How can I prove that extensions did not copy the second transcript? 

### Reference answers

1. It is still an execution with session, run, writer, tools, models, and responses. Reusing existing contracts can yield idempotents, concurrency, approvals, transcripts, and disconnection recovery; A new system will create a second set of factual sources. 
2. At least tool profile/policy, approval (if external writing is involved), workspace authority, read-only mount, env sanitize, and sandbox lifecycle. Tool naming/prompts cannot serve as security boundaries. 
3. Otherwise, hooks or middleware layers may modify parameters or fabricate evidence, making approval see that the call was not originally proposed by the model. Approval must target the original call, and the final owner approval should then review the result after the hook. 
4. Read submitted reports and reply receipts, only supplementing submissions/events; Do not rerun reviews or regenerate reports, otherwise results may be altered and side effects may be repeated. 
5. Model fallback swaps models/credentials within the same harness and continues the same review run; Harness fallback may fail closed if there is no lossless declaration when the entire runtime is replaced. 
6. Check whether all write operations are only through the writer/transcript service, whether UI/channels only consume events, and whether they read from the same session/branch after reboot; Then tamper with the UI state and confirm that the refresh returns to the canonical transcript. 

## 9. Source code coordinates

- `src/plugins/`
- `src/plugin-sdk/`
- `src/auto-reply/dispatch.ts`
- `src/gateway/server-methods/chat-send-handler.ts`
- `packages/agent-core/src/agent-loop.ts`
- `src/agents/agent-tools.before-tool-call.approval.ts`
- `src/agents/sandbox/workspace-authority.ts`
- `src/agents/sessions/agent-session-transcript.ts`
- `src/agents/embedded-agent-runner/run/session-bootstrap.ts`

## 10. Completion Criteria

The final design must be able to answer these seven questions clearly:

```text
Where does the message come in?
Which session does it belong to, and who has write permission?
What context does the model see?
Who approves the tool, and where is it isolated for execution?
When it fails, should I switch the model, change the harness, or stop?
Which results have been written into the transcript?
After disconnection/restart, which step should be resumed?
```

You are only considered to have completed learning OpenClaw if you can clearly answer and successfully run at least one concurrency experiment, one approval experiment, one fallback experiment, and one crash recovery experiment.
