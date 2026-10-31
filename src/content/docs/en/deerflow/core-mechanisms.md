---
title: "02 · Core Mechanism"
description: "Sort out the core mechanisms of context, tools, sandbox, model adaptation, extension, and persistence."
---

> Baseline: DeerFlow `v2.1.0` (`345f08be`). Path relative to `backend/`.
> This answer addresses seven questions: where the context comes from, how the tool works, where the actions are executed, how the model connects, how capabilities are extended, how sub-agents cooperate, and what prevents collapse in engineering.

## 1. First, look at the mechanism overview

```text
                    ┌──────── Context ────────┐
                    │ ThreadState.messages   │
                    │ summary / memory       │
                    │ checkpoint / journal   │
                    └───────────┬────────────┘
                                │
Model ◄── prompt/tools ◄── Middleware chain ──► Tool calls
  │                             │                   │
  │ reasoning / tokens          │ policy            ├─ built-in
  └─────────────────────────────┘                   ├─ sandbox
                                                    ├─ MCP
                                                    ├─ skills
                                                    └─ subagent
                                                          │
                                              Sandbox / remote services
```

The seven parts are not parallel modules, but three closed loops:

- **Reasoning loop**: model → tool call → observation → model;
- **Context loop**: message growth → compression/budget → checkpoint → next round;
- **Capability loop**: tool authorization → execution → result summary/error classification → audit and replay.

## 2. Context: the model does not see the "entire chat history"

### 2.1 Authoritative state at `ThreadState`

`agents/thread_state.py`'s `ThreadState` inherits LangGraph `AgentState`, the core field is `messages`, with other repair information such as `summary_text`.

In each round, the model sees a message view projected from the thread state, not the raw rows in the database. The projection process may go through:

```text
checkpoint recovery
  → Application message reducer / deduplication
  → Inject context such as uploads, date, project, etc.
  → Summary/Compress Old Messages
  → Budget trimming tool output
  → convert to provider messages
```

### 2.2 There are two channel modes for checkpoints

`runtime/checkpoint_mode.py` Clear definitions:

- `full`: Save complete channel values at each step;
- `delta`: Use LangGraph `DeltaChannel`, save sentinel written at each step, and snapshot according to frequency.

The mode is frozen at the process level and cannot be switched during runtime. `delta` can reduce the cost of repeated snapshots, but the full process reading delta threads will fail closed and must be migrated first. This indicates that the checkpoint format is also an engineering contract, not an internal implementation detail.

### 2.3 Compression and memory are two different pathways

| Mechanism | Scope | Trigger | Typical Implementation |
| --- | --- | --- | --- |
| summarization | Current conversation window | Automatic threshold / `/compact` | `SummarizationMiddleware` |
| tool output budget | Single tool result | Summarize/truncate when result is too long | `tool_output_budget_middleware` |
| memory | Cross-session facts/preferences | Retrieval or periodic update | `agents/memory/` |
| checkpoint | Single thread execution state | Each step / by frequency | LangGraph checkpointer |

In short: **Compression solves "can't fit in this round," memory solves "won't remember next round," checkpoint solves "where to continue after process restart."**

### 2.4 Why Tool Output Budget is needed

Tool output is the most uncontrollable source of context: a log file, a large table, or an API response can all overflow the window. The budget middleware will summarize/truncate the results before they enter the model, while keeping a traceable path or receipt. This way, the model receives a "summary sufficient for decision-making," not the "full text."

## 3. Tools: Three layers of filtering, two types of execution boundaries

### 3.1 Tools must pass three layers to go from "existent" to "callable"

```text
What candidates are there in the system?
  → apply_tool_authorization() Which actions are allowed for the current user/context
  → assemble_deferred_tools() Which ones were exposed this round, or discovered late
```

`assemble_deferred_tools` Solving tool explosion with tool search: The model first sees a small number of core tools and search entry points, and discovers MCP/extended tools as needed. The MCP routing middleware also provides hints and automatic promotion based on queries.  

### 3.2 Types of Tools

| Type | Example | Execution Location | Key Risks |
| --- | --- | --- | --- |
| built-in | `read_conversation`, todo, present_files | Within Gateway process | Accessing server data |
| sandbox | `bash`, `ls`, `read_file`, `write_file`, `str_replace` | sandbox provider | Command execution, file overrun |
| MCP | Tools exposed by external server | Remote MCP server | Network, credentials, protocol |
| skill | Reading/managing skill packages | File system/storage layer | Path, content review |
| subagent | `task`, batch task | Controlled sub-execution in the same Run | Concurrency, budget, recursion |

### 3.3 Tool results also have "protocol"

DeerFlow does not return tool output to the model as-is. The middleware will:

- Label error types (rate limit, transient, permission, etc.);
- Provide `recoverable_by_model` and `recommended_next_action`;
- Convert large results into a synopsis;
- Generate receipts for files/references;
- Clean up dangling tool calls.

This way, the model receives a structured observation rather than an ambiguous string. In engineering terms, **tool error classification is core to Agent reliability, not an auxiliary function.**

## 4. Sandbox: Tool interfaces and execution boundaries must be separated

### 4.1 Virtual Path Contract

Within the sandbox, fixed virtual paths are used:

```text
/mnt/user-data/workspace   Temporary Workspace
/mnt/user-data/uploads     Upload File
/mnt/user-data/outputs     Final Deliverables
/mnt/skills                Skill Directory (usually read-only)
/mnt/acp-workspace         External ACP agent workspace
```

The tools only accept these logical paths, while the provider is responsible for mapping them to real host/container paths. `sandbox/tools.py` performs boundary checks, and `local_sandbox_provider.py` is responsible for per-thread mapping.

The benefits of this approach:

- The contract between prompts and tools remains stable, regardless of deployment path changes;
- There is a unified point for path traversal checks;
- Local mode and container mode share the same set of tool APIs.

### 4.2 Provider and Lease

`SandboxProvider` manages the acquisition, lookup, and release of sandboxes; `SandboxLeaseManager` manages active users of the same sandbox and determines the timing of its release.

Why is a lease needed? Because middleware might retain the sandbox ID, tool calls may finish asynchronously, and a Run cancellation could also occur after acquisition. The lease turns 'who is still using it' into a countable fact, preventing one user's completion from releasing a sandbox that another user is still executing.

### 4.3 Three lines of trust

```text
Model output ── is unreliable ──► Tool parameters ── must be verified ──► sandbox operation
Client input ─ is untrusted ──► RunContext ── whitelist ──► runtime
External MCP ── untrusted ──► tool result ── classification/summary ──► model context
```

Sandbox is not an excuse to 'let the model run freely.' It confines high-risk actions in a controllable environment, but the tool layer still needs to check paths, permissions, parameters, and outputs.

## 5. Model Integration: One Factory, Multiple Adapters

`models/factory.py::create_chat_model()` is the only entry point for model construction. Process:

```text
Read model profile
  → resolve provider class
  Merge per-agent overrides
  → handling thinking / reasoning_effort
  → Filter out fields that the provider does not recognize
  Additional tracing (determined by call point)
  → construct BaseChatModel
```

Key Design:

- **Whitelist at the order-receiving level, construction at the factory level**: allow first, then instantiate;
- **Model profile is data**: provider class, context window, pricing, and thinking capabilities are all expressed through configuration;
- **Provider adapter absorbs differences**: OpenAI-compatible, Codex, and other provider field differences do not pollute the Agent;
- **Tracing is only attached once at the root**: Lead Agent passes `attach_tracing=False`, avoiding dual spans in graph and model.

## 6. Extensions: Four Ways of "Long Capabilities"

| Extension Aspect | What It Solves | Entry Point |
| --- | --- | --- |
| Skills | Package methods, templates, scripts for Agents to use on demand | `skills/`, skill tools |
| MCP | Access external tools/resources/prompts | `mcp/` |
| Extensions | Inject middleware, tools, events during Agent build/runtime | `extensions/`, `deerflow_extension_api` |
| Channels | Connect IM/Webhook input to Run and return results | `app/channels/` |

### 6.1 Skills Are Not Tools

A Skill is more like a "loadable operation manual resource package." The model first discovers a skill, then reads `SKILL.md` or calls its scripts. Skills extend knowledge and processes, while tools extend actions.

### 6.2 MCP Has Both Synchronous Tools and Long Tasks

A standard MCP tool returns results in a single call; DeerFlow also has an MCP task system that persists remote long tasks, supporting notifications, callback, and recovery. `app/mcp_tasks/` is the app-side task notification layer, and `deerflow/mcp/tasks/` is the protocol-neutral task model.

### 6.3 Extensions Injection Has Order Constraints

Middleware extensions cannot be simply appended because the middleware order determines the before/after model semantics. `extensions/stack.py` uses anchors, `@Next`/`@Prev`, and placement to combine and validate order. Extension authors must declare "relative to whom," rather than assuming their own position.

### 6.4 Channels Also Follow the Same Run Mainline

Channels like Discord, Slack, Feishu, and Telegram, upon receiving messages, do not implement a separate Agent but construct `RunCreateRequest`, eventually entering `start_run()`. The channel layer handles identity mapping, deduplication, reply routing, and media processing; execution still belongs to the Run system.

## 7. Multiple Agents: Controlled Concurrency Under the Same Run

Native sub-Agents in DeerFlow are executed through `task_tool` / `SubagentRuntime`:

```text
Lead Agent
  → task(description, subagent_type)
    → SubagentRuntime Allocation Capacity
      → SubagentExecutor Build child graph
        → Child graph uses an independent event namespace
          → is returned to Lead as ToolMessage
```

### 7.1 Three Restrictions

- `SubagentLimitMiddleware` Restrict concurrent task calls in a single response; 
- Run level `max_total` limits the number of general assignments; 
- `SubagentExecutionCapacity` Manage actual execution capacity across Runs. 

If the model generates 20 parallel subtasks at once, the middleware only retains the allowed quantity, and the remaining calls are removed and the reasons are recorded. The model cannot bypass the budget by "writing multiple tool calls." 

### 7.2 What do child agents share, and what do they don't?

Share: 

- Budget, logs, event bus, and final delivery for the same run; 
- Parent sandbox / project context (by policy); 
- Controlled result return channel. 

No sharing: 

- Permission to write directly to parent messages; 
- Permissions to arbitrarily generate unlimited child agents; 
- Independent user identities or cross-user data access rights. 

### 7.3 Why batch is a standalone mode

A large number of independent small tasks are suitable for explicit batch: persistently commit, query status, and cancel. Unlike models that write multiple `task` calls in one round, batch turns "batches" into server-manageable task sets rather than relying on prompt constraints for concurrency. 

## 8. Persistence: Three types of storage solve three different problems

| Storage | Content | Consistency Focus |
| --- | --- | --- |
| checkpoint | LangGraph State, Messages, Branch | Recoverable, Mode Compatible, Lease Fencing |
| RunStore | RunRecord, State, token, Power Keys | Atomic access, state condition updates, cross-worker |
| event store / journal | Process events, message flow, delivery receipt | Sequencing, deduplication, replayability, frontend consistency |

### 8.1 Why not merge them into one database table

Because their frequency of change, query patterns, and lifecycle differ: 

- Checkpoint can be written at every step and is strongly bound to the LangGraph format; 
- RunStore is the control plane, requiring condition updates and leases; 
- The event store is an append log that requires thread/run pagination and seqing. 

Merging couples format migration, cleanup strategies, and fault domains. Splitting requires accepting the cost of "multi-storage consistency" and handling it with receipt, seq, and idempotent write. 

### 8.2 The Relationship Between Journal and Event Store

`RunJournal` is the runtime event producer; `RunEventStore` is the persistence interface. When a job ends, it first flush journal, then writes delivery receipt, and finally sets the final state. This sequence ensures that "when the final state is visible, the process and delivery are basically traceable." 

## 9. Production reliability: five fences

1. **Admission fence**: Atom create + idempotent bond to prevent duplicate work orders; 
2. **Starting Barrier**:p ending→running barrier prevents agents from being constructed after cancellation; 
3. **Ownership fence**: lease + `ownership_lost`, anti-zombie worker coverage; 
4. **Delivery Fence**: Outputs scan + receipt to prevent "verbal success"; 
5. **Dependence Fence**: `app → deerflow` One-way dependency testing to prevent kernel contamination by product details. 

These five are not optional optimizations, but the main difference between DeerFlow and the "demo agent." 

## 10. Design choices

| Trade-offs | Choices | Cost |
| --- | --- | --- |
| Strong Control Plane vs. Simple Call | Create Run before Execution | Add an extra layer of state and storage |
| In-process SSE vs message queue | StreamBridge binds owner | Cross-worker requires join/read history |
| Unified Tool Contracts vs. Native Capabilities | Virtual Paths + Provider | Provider Implementation Is More Complex |
| Delayed Tool Discovery vs. Full Exposure | tool search | One more step to discover |
| Sub-agents Controlled Concurrency vs. Free Recursion | Middleware + capacity | Complex tasks may be throttled |
| Separate Storage vs Single Database | Checkpoint/Run/Event Separate | Cross-Storage Consistency Processing |

## 11. Common misconceptions

| Misconceptions | Correct understanding |
| --- | --- |
| `messages` is the complete history | It may have been compressed, projected, or budget-cropped |
| Skill is another tool | Skill is a knowledge and process package, usually read/executed via the tool
| Sandbox automatically ensures security | It provides isolation, but paths/permissions/parameters still require tool-level validation |
| Subagent is an independent product instance | It operates under the same Run control plane but is limited by budget and capacity |
| Checkpoint can replace Event Store | One is a restore state, one is a record of the process and delivery |
| The more tools you have, the stronger the model | Having too many tools increases token costs and misselection, requiring authorization and delayed discovery |

## 12. Self-assessment questions

1. What is the boundary between `ThreadState.messages`, checkpoint, and memory? 
2. Why do tools go through three layers of "Available → Authorized → Assembled"? 
3. What engineering problems does the sandbox virtual path solve? What is the provider responsible for? 
4. Why can't child agents bypass `SubagentLimitMiddleware`? 
5. What questions are RunStore, Checkpoint, and Event Store best suited to answer? 
6. If the MCP server returns a large JSON, what protections does the system have? 
7. Why does Middleware Extension Need anchor/sequential checksum? 

### Reference answers

1. `ThreadState.messages` is the message state/projection given to the model in the current graph; checkpoint is the persistent recovery point for the graph state; memory is the long-term facts and preferences for cross-session retrieval. Current window, recoverable execution state, and cross-session memory are three different lifecycles. 
2. "Usable" answers whether there are candidates in the system; "Authorized" answers whether the current user, project, and context allow use; "Assembled" answers whether the current round is actually exposed to the model. After separation, unauthorized tools are neither crammed into the prompt nor can the deferred/tool search control the tool directory size. 
3. Virtual paths assign tool contracts to stable namespaces such as `/mnt/user-data/...`, perform unified path traversal and out-of-bounds checks, and allow local/container providers to share the same tool API; providers are responsible for mapping these logical paths to the real execution environment, acquiring/releasing sandboxes, and managing concurrent users by the lease. 
4. Because the constraint occurs at the middleware/tool execution layer of the Agent diagram, not prompt suggestion. Even if the model generates 20 `task` calls, `SubagentLimitMiddleware` will still trim the over-call before execution, and the Run level `max_total` and capacity manager further limit total and true concurrency; Model output cannot bypass server fences. 
5. **RunStore** answers "Did this run get an order, and what are the status/owner/idempotency keys?" **checkpoint** answers "Where did the graph run and how is it restored?" **Event Store/Journal** answers "What happened during the process, how is the review/audit, and what is the delivery voucher?" 
6. At least go through: MCP result normalization and error classification → size/protocol limitations → tool output budget summary or truncation → receipt/recall references → final context budget. Huge JSONS cannot be stuffed back into the model as is; If necessary, only the synopsis and read paths are returned. 
7. Because middleware's before/after semantics are determined by relative order. Extension: If append arbitrarily, it may run to authentication or tool error handling, clarification, summarization, or before or after sub-agent restrictions, changing security boundaries and caching behavior; anchor, `@Next`/`@Prev` and placement checks allow combinations to definitive, detectable conflicts and fail closed on illegal topologies. 

## 13. Code map

```text
agents/thread_state.py                          ThreadState / delta schema
agents/middlewares/summarization_middleware.py Summary and Compression
agents/middlewares/tool_output_budget_middleware.py
                                                Tool Output Budget
agents/middlewares/subagent_limit_middleware.py child Agent concurrency/total
tools/tools.py                                  Tool Catalog and Assembly
tools/builtins/                                 Built-in Tools
sandbox/sandbox_provider.py                     provider interface
Virtual Path and Tool Implementation
sandbox/lease.py                                sandbox user lease
models/factory.py                               create_chat_model
mcp/                                             MCP Client and long tasks
skills/                                          Skill Packages and Review
extensions/                                      Extension Injection and Sorting
subagents/                                       runtime/executor/batch/capacity
Process Events and Delivery Facts
runtime/checkpoint_mode.py                       full/delta checkpoint
app/channels/ IM Channel Access
```

The next article shifts from 'understanding' to 'being able to modify': how to locate a fault, conduct source code experiments, assess change risks, and provide a graduation exercise.
