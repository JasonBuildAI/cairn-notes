---
title: "OpenClaw 2026.10.9 Source Code Class · 02 Core Mechanisms"
description: "Organize loops, context, tool approval, models and harness, plugins, and Gateway protocols."
---

> Baseline: `openclaw-2026.10.9`. The path is relative to `$OPENCLAW_SRC`.
> This article no longer discusses "how a single message travels," but instead breaks it down into seven mechanisms: loop, session, context, tools, model, extension, interface/protocol.
> Each mechanism only answers two questions: **What state does it have? Why must it exist independently?**

## One-sentence Understanding

The core of OpenClaw is not some "super Agent class," but a set of **mechanisms with clear boundaries**:

```text
                 ┌──────────────────────────────┐
                 │ Gateway / UI / Channels      │
                 │ Who comes in, who goes out, who has permission      │
                 └──────────────┬───────────────┘
                                │
                 ┌──────────────▼───────────────┐
                 │ Session / Run / Writer       │
                 Who it belongs to, who writes first, who takes over, who restores
                 └──────────────┬───────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Context       │     │ Agent Loop      │     │ Tools           │
│ What to show the model   │────▶│ Model/Tool/Continue   │────▶│ What it can do/Who approves   │
└───────────────┘     └────────┬────────┘     └─────────────────┘
                               │
                     ┌─────────▼─────────┐
                     │ Model / Harness   │
                     │ Who to use to run, what to do if it fails │
                     └─────────┬─────────┘
                               │
                     ┌─────────▼─────────┐
                     │ Plugins/MCP/Skills│
                     │ How abilities develop     │
                     └───────────────────┘
```

The seven blocks are connected by three hard constraints:

1. **Unique state ownership**: The session is written by the writer, routes are owned by the Gateway, and tool passage is controlled by the approval chain.
2. **Protocol legality**: Tool calls and tool results must come in pairs; events must be replayable/recoverable.
3. **Separation of rebuildable and non-rebuildable**: Views can be derived from the authoritative state; idempotent actions, writers, and approval results cannot be casually discarded as cache.

---

## 1. Loop mechanism: What exactly does the Agent Loop loop over

### 1.1 Two entry points

`packages/agent-core/src/agent-loop.ts` provides:

- `runAgentLoop()` (`81`): Launch with an initial prompt;
- `runAgentLoopContinue()` (`118`): Continue from an existing context without submitting a prompt.

Both ultimately enter `runLoop()` (an internal function starting from `140`).

### 1.2 The complete shape of a turn

In the source code, a turn is not "a single model call," but:

```text
turn_start
  Injection pending / steering
  ├─ optional prepareContinuation (replace systemPrompt/tools)
  ├─ streamAgentResponse
  │    ├─ Text Increment Event
  │    ├─ tool_call incremental event
  │    └─ Tool batch execution
  ├─ Handling Unexecuted Terminal Tool Calls
  ├─ calculate hasMoreToolCalls
  ├─ turn_end
  └─ prepareNextTurn / abort / error / terminate judgment
```

Key lines:

- Inner loop condition: `agent-loop.ts:218`
- Model flow: `269`
- Tool batch: `276`
- `turn_end`: `344`
- `prepareNextTurn`: `390`
- follow-up: `446`
- `agent_end`: `457`

### 1.3 Why two loops are needed

The inner loop addresses 'this round is not over yet':

```text
hasMoreToolCalls || pendingMessages.length > 0
```

The outer loop handles 'whether there are additional messages from users/system after this round ends':

```text
getFollowUpMessages()
```

Without the outer layer, if the model just says 'Done', any follow-up message from the user can only start a new run; with the outer layer, it can continue as part of the same logical execution.

### 1.4 Tool batches are not a simple for loop

`executeToolCalls()` in `461` line, core steps:

1. `beforeToolBatch` Perform batch-level admission;
2. Analyze which tool corresponds to each tool call;
3. Decide whether to use parallel or serial.
4. Execute;
5. Generate tool result;
6. Handle tools that did not start due to skipped steering;
7. Return batch results, termination flag, steering messages.

Parallel/Serial Determination:

- Fully serial when configuring `toolExecution === "sequential"`;
- Otherwise, if any tool declares `executionMode === "sequential"`, the entire batch switches to serial;
- See `agent-loop.ts:514-531`.

This is not a performance detail, but a correctness detail: tools with side effects cannot be executed in parallel out of order.

### 1.5 The 'Safe Cut-In' of Steering

Steering can only take effect at these points:

- Before the start of a round;
- Before batch execution of the tool;
- After the batch ends;
- Before the next round of model calls.

Tools that have already started executing will not be interrupted. Tools that have not yet started will be generated through `completeUnstartedToolCall()` (`1331`):

- A synthetic error result, or
- A result of `status: "skipped"`.

There is only one reason: **the transcript must maintain the pairing of tool call/result.**

### 1.6 Reasons for Termination Must Be Categorized

Don't call every ending 'completion.' At least distinguish in the source code:

| Reason | Semantics |
| --- | --- |
| Naturally no work | No tool invocation, no pending/follow-up |
| abort | User/upper layer cancels |
| provider error | Model call failed |
| tool loop terminate | Repeated error / tool loop protection |
| strategy stop | `prepareNextTurn().stop` or `shouldStopAfterTurn()` |
| superseded | Taken over by a new writer (terminated at the session layer) |

When troubleshooting, first classify, then find the corresponding owner.

---

## 2. Session Mechanism: Session / Run / Writer / Lane

### 2.1 Identity Model

| Identity | Owner | Function |
| --- | --- | --- |
| `sessionKey` | Gateway / session store | Route to which conversation |
| `sessionId` | session store / agent DB | persistently record identity |
| `runId` | Current Execution | Identity for a Single Execution |
| `clientRunId` | Client | Idempotent retry key, usually directly becomes `runId` |
| `lifecycleGeneration` | Runtime | Prevent old lifecycle from continuing operations |

### 2.2 Access and Idempotence

The designated entrance of `chat.send` is at `src/gateway/server-methods/chat-send-admission.ts:75`. It simultaneously handles:

- Upload/attachment access;
- Session binding;
- Idempotent cache;
- Abort controller registration;
- Work admission (gateway work admission);
- Retry comparison.

The idempotency key is `chat:${clientRunId}` (`442`). Repeated requests will not start a new run, but will return `in_flight` or the existing result.

### 2.3 writer fence

`claimAgentSessionWriter()` is in `src/agents/embedded-agent-runner/run/session-bootstrap.ts:523`.

It did:

1. Read the current session snapshot;
2. Confirm that `sessionId` has not changed;
3. CAS writes `activeWriterRunId = current runId`;
4. If the old writer is different, call `supersedeEmbeddedAgentRunByRunId()`;
5. The old run ends with `superseded`.

This solves three types of problems:

- Concurrent input in the same session;
- The new run legally takes over the old run;
- The old writer cannot continue writing when restarting recovery.

### 2.4 Lane and Concurrency Budget

`src/agents/embedded-agent-runner/lanes.ts`:

- `resolveSessionLane()` (`10`): `session:<key>`, serialize the same session;
- `resolveGlobalLane()` (`15`): Resource lane for global/sub-agent/cron.

Special Rules:

- The inner cron operation uses `cron:nested` to avoid deadlocks with the outer cron;
- The subagent lane is bound to the parent owner to prevent child tasks such as the orchestrator from consuming the capacity it needs.

### 2.5 recovery owner

`agentCommandFromIngressInternal()` use:

```ts
runWithAgentCommandRecoveryOwner(..., mode: "claim", ...)
```

Location: `src/agents/agent-command.ts:603`.

It ensures that "restore/takeover" has only one owner. Gateway also has a dedicated `agentCommandFromGatewayIngress()` (`665`) for restoring restart-recovery admissions that were rejected.

### 2.6 detached run

During `sessionPersistence === "detached"`:

- Persistent session metadata is not written;
- Outer deferral is not claimed;
- In-memory session manager (`run-orchestrator.ts:154-158`) is used.

This is not a vague term for a "temporary task," but a clear choice of ownership: **this run does not affect long-term sessions.**

---

## 3. Context Mechanism: Stable Prefix, Bootstrap, Compaction, Pruning

### 3.1 system prompt is hierarchically assembled

`buildAgentSystemPrompt()` is in `src/agents/system-prompt.ts:284`. Input includes:

- Workspace / runtime cwd;
- Visible tools and available tools;
- Skills prompt;
- Context files;
- Bootstrap mode;
- Model aliases;
- Runtime info;
- Sandbox information;
- Provider override sections.

The output is not a block of casually assembled text, but has boundaries of "stable prefix / volatile suffix."

### 3.2 Why maintain a stable prefix

Source code in `system-prompt.ts:605` calculates `stablePrefixCacheKey` from a set of stable inputs and reuses stable prefixes from the cache. Comments in `835-849` note:

- Date/timezone changes go into the volatile suffix;
- Channel/session specific guidance goes after the cache boundary;
- Large chunks of workspace context remain in byte-level stable prefixes.

The reason is **prompt-prefix reuse**: rewriting the prefix each round in the same session would break provider cache hits, and long-term costs would increase significantly.

### 3.3 Bootstrap file injection rules

`resolveBootstrapContextForRun()` is in `src/agents/bootstrap-files.ts:397`. Default filenames come from `workspace-bootstrap-policy.ts`:

- `AGENTS.md`
- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- `BOOTSTRAP.md` (new workspace)
- `MEMORY.md`

Budget:

- Single file: `20000` characters;
- Total: `60000` characters;
- See `src/config/schema.help.models.ts:152-155`.

Exceeding limits triggers truncation and a notice is added in the prompt; budget diagnostics are in `src/agents/bootstrap-budget.ts:122`.

Sub-agents by default inject only `AGENTS.md`, reflecting "context budget allocation by role."

### 3.4 Compaction: rewriting history

`packages/agent-core/src/harness/compaction/compaction.ts`:

- Default configuration: `enabled: true`, `reserveTokens: 16384`, `keepRecentTokens: 20000` (`179-182`);
- `estimateContextTokens()` (`243`) prioritizes provider usage;
- `shouldCompact()` (`276`): `contextTokens > contextWindow - reserveTokens`;
- `findCutPoint()` (`407`): retain approximately `keepRecentTokens` of recent messages, splitting an oversized turn if necessary;
- `compact()` (`815`): generate summaries and create submit-ready compaction artifacts;
- `compactWithoutSummary()` (`895`): if summarization fails, keep recent originals, explicitly record how many early messages were removed.

Summaries are not "lossless compression." They are lossy, so the source code:

- Retains recent original content as much as possible;
- Iteratively updates old summaries;
- Falls back to "no summary but keeping the tail" if summarization fails;
- Clearly informs the model/user of messages that were omitted.

### 3.5 Cache-TTL pruning: only modify projections

`src/agents/embedded-agent-runner/tool-result-truncation.ts`:

- Default TTL `5 * 60_000` (5 minutes);
- `hardClear` default `true`;
- Placeholder default `[Old tool result content cleared]`;
- Soft prune retains `1500` characters at both head and tail (`167`);
- When context pressure ≥ 50% and reclaimable ≥ 50,000 characters, hard clear (`264-283`).

Key difference:

| Mechanism | What to change | Does it modify disk transcript |
| --- | --- | --- |
| compaction | historical structure | Yes, writes summary |
| cache-TTL pruning | current prompt projection | No |

So when you see "tool result got shorter," first determine which type it is, and don't directly look for missing original text in the transcript.

---

## 4. Tool Mechanisms: Assembly, Batches, Approval, Sandbox

### 4.1 Assembly Chain

`assembleOpenClawCodingTools()` In `src/agents/agent-tools.ts:97`, it's a generator:

1. Calculate capability profile;
2. Calculate workspace/sandbox policy;
3. Add core coding tools;
4. Add OpenClaw tools;
5. Add plugin tools;
6. Add channel tools;
7. Do final authorization.

Core tools are in `src/agents/core-coding-tools.ts:202`.

### 4.2 Why tools have two context costs

In one request, the model sees at least:

- **Tool directory/description**: tool text in the system prompt;
- **Tool JSON schema**: function definitions in the provider request.

So "adding one more core tool" is not just adding one function; it permanently increases per-round context cost. This is why root `AGENTS.md` emphasizes **small core, capable plugins**.

### 4.3 Batch Execution

- Batch-level admission: `beforeToolBatch`;
- Parameter validation: `validateToolCallForBatchAdmission()`;
- Parallel/serial: per configuration and tool declaration;
- Failure: generate valid tool result, rather than leaving the call hanging.

### 4.4 before_tool_call Order

`src/agents/agent-tools.before-tool-call.policy.ts` File header:

```text
loop admission
→ owner probes
→ voice confirmation
→ trusted policies
→ approvals
→ normal hooks
→ final owner approval
```

Why the order cannot be changed:

- loop admission: first block repeated/dangerous loops;
- owner probe confirms the caller's identity;
- voice confirmation only applies to the voice surface;
- trusted policy is the host trusted policy;
- approval is truly 'asking people';
- A normal hook is a plugin extension point;
- Final owner approval is the last step for release.

### 4.5 Approval Mode

`resolveBeforeToolCallApprovalOutcome()` at `agent-tools.before-tool-call.approval.ts:470`:

| Mode | Behavior |
| --- | --- |
| `request` | Request Approval Immediately |
| `defer` | Deferred to execution boundary |
| `report` | Report only, do not block |
| `deny` | Direct Refusal |

Non-interactive channels may be directly denied. It's not 'if the channel is not supported, it's unsafe', but 'by default, do not allow it when you cannot ask someone'.

### 4.6 The sandbox is an execution boundary

`src/agents/sandbox/` Provides execution isolation. The system prompt will clearly distinguish:

- host workspace;
- sandbox workspace;
- Execute inside the container;
- The child agent does not get elevated/host access by default.

See `system-prompt.ts:487-501`, `776-789`.

Tool strategy determines 'whether it can be done,' while the sandbox determines 'where it can be done and what can be encountered.' The two cannot replace each other.

---

## 5. Model Mechanism: Parsing, Authentication, Candidates, Harness

### 5.1 Analysis

`resolveModelAsync()` at `src/agents/embedded-agent-runner/model.ts:84`:

- Analyze logic provider/model;
- Prepare auth storage and model registry;
- First, look at explicit/configuration models;
- Then look at the static catalog;
- Next, look at the provider dynamic catalog;
- Combine auth profile, route, and workspace.

Failure messages will distinguish situations such as 'legacy provider,' 'model not in catalog,' and 'model bound to a certain runtime.'

### 5.2 Candidate Chains

`resolveModelCandidateChain()` is in `src/agents/model-fallback-candidates.ts:155`.

Candidates are not added arbitrarily, but based on:

- Main model;
- fallback configuration;
- provider availability;
- auth profile;
- Runtime constraints

Generate an ordered chain.

### 5.3 failover decision

`resolveRunFailoverDecision()` at `src/agents/embedded-agent-runner/run/failover-policy.ts:115`:

- `rotate_profile`: Change certification with the same model;
- `fallback_model`: Change model;
- `surface_error`: Exposed upwards.

`runEmbeddedAgentEntry()` (`run-entry.ts:161`) only allows the finally accepted candidates to advance the session. The assistant error transcripts of failed candidates will be cleaned/isolated to prevent contamination of the final history.

### 5.4 Harness Selection

`selectAgentHarness()` is in `src/agents/harness/selection.ts:77`. It determines who will execute it:

- Built-in `openclaw` harness (`builtin-openclaw.ts:84`);
- `codex` External harness;
- `auto` Select by configuration/model.

`runAgentHarnessAttempt()` (`selection.ts:182`) is a unified attempt entry.

### 5.5 CLI backend

`runEmbeddedAgentViaCliBackendIfEligible()` is in `src/agents/embedded-agent-runner/cli-backend-dispatch.ts:21`.

Some provider/auth combinations require going through the CLI backend. In this case:

- Still goes through the same set of session admission, placement, and concurrency gate;
- But the actual model loop is handled by the external CLI;
- The capability of compaction/manual compaction may vary.

See the notes and calls in `run-orchestrator.ts:245`.

---

## 6. Extension Mechanisms: Plugin, MCP, Skills, Subagent

### 6.1 Native Plugins are capability registrations, not 'core modifications'

The ability table of `docs/plugins/architecture.md` includes:

- text inference;  
- CLI inference backend;  
- embeddings;  
- speech / realtime transcription / realtime voice;  
- media understanding;  
- image/music/video generation;  
- web fetch/search;  
- channel;  
- gateway discovery;  
- migration.  

Plugins can also register tools, hooks, commands, services, HTTP routes.  

Pipeline loading:  

1. manifest discovery;  
2. enablement validation;  
3. runtime loading;  
4. surface consumption.  

Native plugins are loaded within the process, **equivalent to arbitrary code execution**. Therefore, the trust boundary for plugins is not a 'sandbox', but 'whether you trust this piece of code'.  

### 6.2 Channel plugin  

`src/plugins/runtime/runtime-channel.ts:127` of `createRuntimeChannel()` provides `dispatchInbound` in `139-145`.  

`src/plugins/loader-channel-runtime.ts:219`'s `api.registerChannel(...)` registers channel capabilities into the runtime.  

So 'adding a new chat channel' is not about modifying Gateway's if/else, but registering a channel capability to translate inbound messages into a unified contract.  

### 6.3 MCP  

MCP is an external tool source, not a backdoor to bypass policies.  

- Configured in `mcp.servers`;  
- Transport supports Streamable HTTP, SSE, Stdio;  
- Even after connection, tools still follow tool profile and tool policy;  
- When the server is disconnected, the last successful tool directory is retained, but execution still reports unavailable;  
- Startup failures follow `30s → 10min` exponential backoff (`docs/tools/mcp.md`).  

Source directories: `src/mcp/`, `src/agents/agent-bundle-mcp-*`.  

### 6.4 Skills  

Skills are not tools themselves, but 'readable instructions/resource catalogs'.  

- `loadSkills()` is in `src/skills/loading/session.ts:191`;  
- `formatSkillsForPrompt()` is in `180`;  
- Whether skills enter the prompt depends on read capability: `system-prompt.ts:512-525`;  
- `skills_read` / `read` / CLI backend and other surfaces affect visibility.  

Skills can come from workspace, plugin, bundled, remote; `src/skills/security/` provides scanning/auditing.  

### 6.5 Subagent  

A Subagent is 'another session, another run', not a function call in the same loop.  

- Child sessions are by default like `agent:<agentId>:subagent:<uuid>`;  
- There is a depth policy;  
- By default, they do not have session/message management tools;  
- Supports announce callbacks, restart recovery, cascade stop;  
- When the parent run ends, the child session does not necessarily end.  

Source code: `src/agents/subagents/spawn/`, `completion/`, `registry/`.  

---  

## 7. Interface and Protocol: Gateway is the control plane  

### 7.1 Gateway startup  

`startGatewayServer()` in `src/gateway/server.ts:24`:  

1. Lazy load `server-start`;  
2. Initialize SQLite runtime;  
3. Prepare database schema contract;  
4. Acquire gateway lock;  
5. Enter `startGatewayServerCore()`.  

Default port `18789`, see `src/config/paths.ts:297`.  

### 7.2 WebSocket first frame  

`ConnectParamsSchema` in `packages/gateway-protocol/src/schema/frames.ts:31`:  

- Protocol version range;  
- Client information;  
- Role;  
- Scopes;  
- Device proof;  
- Auth token/password/deviceToken.  

After the server connection is established, it first sends `connect.challenge` with a random nonce, see `src/gateway/server/connection.ts:329-331`.  

Device proof verification in `src/gateway/server/ws-connection/connect-device-proof.ts:15`:  

- Public key-derived device id must match;  
- `signedAt` must be within allowed skew;  
- Nonce must match;  
- Signature must be valid.

Pairing approval is at `connect-device-pairing.ts`. 

### 7.3 Three types of frames

- `req`:`{ type, id, method, params }`(`frames.ts:187`)
- `res`:`{ type, id, ok, payload|error }`(`196`)
- `event`:`{ type, event, payload, seq?, stateVersion? }`(`205`)

`seq` Allows the client to discover event gaps; `stateVersion` Allows the client to check if the snapshot is expired. 

### 7.4 Permissions

Method authorization is not "just connected and activated." `src/gateway/server-methods/request-authorization.ts` and method descriptors jointly decide: 

- What scope the method requires; 
- Is it an operator; 
- Whether it is session owner; 
- Whether creating/cross-session creation is allowed. 

For example, `chat.send` requires `operator.write`, see `src/gateway/methods/core-descriptors.ts:382`. 

### 7.5 UI

- TUI: `src/cli/tui-cli.ts:88` Registered `tui`, aliases `terminal`/`chat`; 
- TUI body: `src/tui/tui.ts:604`; 
- Control UI: `ui/src/main.ts` browser entry; 
- Route: `ui/src/app-routes.ts:157`; 
- Chat page: `ui/src/pages/chat/chat-page.ts:61`. 

WebChat uses Gateway WS RPC: `chat.history`, `chat.send`, `chat.inject`, `chat.message.get`, and `chat.startup`. 

--- 

## 8. Design trade-offs: Why not a simpler architecture?

### 8.1 Single Gateway Owns Routing

Advantages: 

- All channels share session/run semantics; 
- Idempotency, permission, event, and restore are only implemented once; 
- UI and channels see the same status. 

Cost: 

- Gateway becomes a long lifecycle process; 
- Requires lock, schema migration, health check, and restart recovery; 
- Single points of failure must be resolved through recovery mechanisms. 

### 8.2 Writer fence instead of "last writes win" 

If you only overwrite by timestamp: 

- The old run may write the tool result after the new run; 
- Transcript will be intertwined; 
- Repeated execution may occur after recovery. 

Writer fence makes "takeover" an explicit event, and old runs must be terminated. 

### 8.3 Stabilizing Prompt Prefixes Instead of "Full Rearrangement Every Round" 

Advantages: 

- Improved provider prefix cache hits; 
- Lowering long-term token costs; 
- Make context changes explainable. 

Cost: 

- Dynamic information must be placed after the boundary; 
- When modifying prompt structures, consider cache keys; 
- You cannot arbitrarily insert specific session content into stable prefixes. 

### 8.4 Only Crop the Projection of the Tool Result

Advantages: 

- Does not compromise transcript recoverability; 
- After rebooting, you can re-derive from the original text; 
- Does not allow the compaction summary and tool results to be contaminated with each other. 

Cost: 

- Needs to maintain the projection key; 
- You must distinguish between "Disk History" and "View of This Request." 

### 8.5 Trust within the plugin process

Advantages: 

- Easy skill registration; 
- Deep integration of provider, channel, and tool; 
- No cross-process protocol overhead. 

Cost: 

- Malicious plugins are equivalent to arbitrary code execution; 
- Compatibility depends on SDK contracts and checks, not process isolation. 

--- 

## 9. Common misconceptions

1. **"Gateway is just a WebSocket server. "** 
   It also includes routing, permissions, powers, events, recovery, UI static resources, and session bindings. 

2. **"Session is a JSON file. "** 
   OpenClaw includes a Gateway state DB (schema 20) and an agent DB (schema 25), covering sessions, transcript archives, FTS, media, and more. 

3. **"The more tools, the stronger. "** 
   Tools increase the context costs of system prompt text and JSON schema, and expand the attack surface. 

4. **"Approval is a type of hook. "** 
   The approval chain precedes a regular hook and has the final owner approval. 

5. **"If MCP connects successfully, it bypasses the tool strategy. "** 
   No. MCP tools still run tool profile/tool policy. 

6. **"Subagent is a recursive call to the same Agent. "** 
   It is an independent session/run, with its own writer, lane, depth policy, and lifecycle. 

7. **"Failure in compaction means losing history. "** 
   `compactWithoutSummary()` Recent original texts will be retained, with clear records of the number omitted. 

8. **"TUI is another set of agents. "** 
   TUI is only the frontend; local mode reuses the same runtime, gateway mode reuses the same RPC. 

--- 

## 10. Self-assessment and practice

### Self-Test

1. What problems do the inner and outer layers of the Agent Loop solve? 
2. Why does a tool batch require `beforeToolBatch`, instead of just performing single-tool validation? 
3. Which field was written to CAS in writer fence? How to terminate the old writer? 
4. What do session lane and global lane respectively prevent? 
5. What inputs are included in the stable prefix of a system prompt? Why should the date be added as a postuff? 
6. Who owns compaction and cache-TTL pruning? 
7. Among the seven steps in before_tool_call, which step should not be placed after the hook? Why? 
8. After losing contact with the MCP server, why can I still see the tool directory but not run it? 
9. What does the child session key of a child agent look like? What happens when the parent run ends? 
10. What problems do Gateway's `seq` and `stateVersion` respectively solve? 

### Practice

- Draw all termination paths as state machines in `agent-loop.ts`. 
- Reproduce writer takeover once in `session-bootstrap.ts` to write the branch when CAS fails. 
- Compare transcripts before and after a single compaction with prompt projections before and after pruning. 
- Find a tool that traces from assembly to approval, then to sandbox execution. 
- Read `docs/plugins/architecture.md` to draw the registration chain for a provider plugin. 
- Manually make the MCP server inaccessible, observe 30-second retreat and tool directory retention behavior. 
- Modify a dynamic field in the system prompt to see if it breaks the stable prefix; specify which side it should be placed. 

--- 

### Self-test reference answers

1. **Inner layer** Solves "Current turn not yet finished": As long as there is a tool call or pending message, continue the model-to-tool loop. **Outer layer** solves "After the turn naturally ends, is there still a follow-up executed by the same logic"; If there is, continue without `agent_end`. 
2. Because batch-level policies need to answer questions that single tools cannot see: can entire batches run in parallel, does the batch include `sequential` tools, cumulative budget/permissions, duplicate or conflict calls, which unstarted calls after steering arrive should be skipped results, and whether batches have termination marks. Single tool validation cannot guarantee batch consistency. 
3. CAS writes `activeWriterRunId = new runId` after confirming `sessionId` remains unchanged; If the old writer exists and is not itself, calling `supersedeEmbeddedAgentRunByRunId()` causes the old run to terminate with `superseded`. 
4. **session lane** prevents transcript interleaved from concurrent writes within the same session; **global lane** prevents the entire process from being dragged down by infinite concurrency and constrains global resources, sub-agents, crons, and other cross-session loads. 
5. Stable prefixes include: workspace/runtime identity, tool directory and schema stable section, skills, bootstrap/context files, model aliases, sandbox/provider descriptions, and other content that does not change with each round. Date/time zone is a dynamic field that changes with runtime and must be placed in the variable suffix after the cache boundary; otherwise, the entire prefix will become invalid each time. 
6. **compaction** belongs to the Compaction module of harness/`packages/agent-core`; **cache-TTL Pruning** belongs to the tool-result truncation module of the embedded-agent runner. The former can overwrite transcripts, while the latter can only modify projections. 
7. **The approval chain cannot be placed after a regular hook**. `approvals` must be before `normal hooks`; Otherwise, the plugin hook can first modify parameters or create evidence before allowing approval to see the "washed" call. `final owner approval` is the last independent owner to release it, not the same as a regular hook. 
8. After losing contact, the tool directory/metadata obtained last time is retained; Execute the MCP connection that needs to be live. If the connection is unavailable, the tool may still be visible, but the call will return unavailable and reconnect with the undone button. You cannot use directory existence to prove it is usable. 
9. The default form of a child session is `agent:<agentId>:subagent:<uuid>`. Parent run termination does not necessarily end child; Child is an independent session/run, with its own writer, lane, depth policy, announcer, and resume lifecycle. 
10. `seq` Solve incremental event order and gap detection: If the client detects a jump number, it will resynchronize; `stateVersion` Resolve snapshot age and new status: If the snapshot version does not match the current server version, the old snapshot cannot be used to overwrite the incremental state. 

### Reference answers for practice

- **Terminate Path State Machine**: Draw at least six types `natural`, `abort`, `provider_error`, `tool_loop_terminate`, `strategy_stop`, `superseded`; for each type, indicate 'who generates it, whether it emits a terminal outcome, and whether a response still needs to settle'.
- **Writer CAS failure branch**: Reread the session; if `sessionId` has changed, return conflict/rebind, cannot write the old session; if it is just a concurrent claim, retry according to strategy or let the new run take over. The acceptance point is to never unconditionally overwrite `activeWriterRunId`.
- **Compaction vs pruning comparison**: After compaction, the transcript will have added summaries/reduced early original text; after pruning, the disk transcript remains completely unchanged, only the old tool result in the current prompt becomes a placeholder, and it can be reconstructed from the original text after restarting.
- **Full Tool Workflow**: Assemble profile → policy/approval → sandbox/executor; record denied, skipped, and successful outcomes, all generating a one-to-one result.
- **Provider plugin registration chain**: plugin registers provider capability/catalog → authentication and model metadata → API adapter → model parsing/candidate chain → failover; the acceptance point is that provider semantics are owned by the provider layer, and the core loop only consumes a unified contract.
- **MCP Unreachable Test**: Expected to first see the directory as readable, with execution unavailable; backoff starts at about 30 seconds, up to a maximum of 10 minutes; backoff is cleared after the server recovers or an explicit reload. Do not misinterpret 'directory still exists' as 'tool is executable'.
- **Dynamic prompt field**: After modification, compare `stablePrefixCacheKey` with the stable prefix byte; if both change, it indicates it was placed on the wrong side. Date, connection status, and session-specific prompts should be placed after the cache boundary, with tests added to prevent backflow.

*OpenClaw 2026.10.9 · Core Mechanism*
