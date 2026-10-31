---
title: "Stage 1: How a Request Passes Through Pi"
description: "Follow a request through the entrance, conversation, models, and tools to build an end-to-end system map."
---

> **Position of this Stage**: Stage 0 can already run Pi. For now, do not dive into any modules; instead, build the entire map.  
> **Source Code Directory**: `$PI_SRC`. All paths below are relative to this directory.  
> **Read First**: [Introduction and Overall Architecture](../), Chapters 1 to 5. This document maps that overall diagram onto source code coordinates.

## 1. What this Stage is Actually Trying to Solve

Beginners often make the mistake of starting from the `packages/` directory and reading files one by one. Halfway through, they realize: loops, sessions, tools, model integration, and the interface are all entangled; they have seen each term, but cannot explain how they work together.

Stage 1 is not about building a "file memory," but about creating a **runtime map**:

1. Through which entry does a request come in?
2. Who does it pass by first, and who next?
3. How do the model and tools hand off to each other in the loop?
4. Where is what has happened stored?
5. How is the execution process observed by the interface and external programs?

After studying this chapter, you should be able to close your computer, draw the following mainline on a blank sheet, and explain what each part does:

```text
Input
  → Entrance Level
  → AgentSession: Organize this run
  → Agent Loop: Rebuild Context → Request Model → Execute Tool → Request Again
  Model Supplier
  → Event return, session persistence
  → agent_settled: truly free
```

Just remember one criterion: **When you see a module, first ask which part of the request journey it belongs to, rather than how many files it contains.**

---

## 2. First, get familiar with a few terms, or every subsequent step will be confusing

### 2.1 session, entry, branch, leaf

A Pi session is not an ordinary piece of text, but an append-only tree.

| Term | Plain explanation | Example |
| --- | --- | --- |
| Session | A complete record of a continuous conversation | A `.jsonl` session file |
| Entry | A single record in a session file | A user message, a tool result, a model switch |
| Branch | A continuous path from the root node to a certain node | The route "user asks → assistant answers → tool executes" |
| Leaf | The end of the currently active branch | The node where the next continuation of the conversation starts |

Key points:

- **A branch itself is continuous**: from the root along `parentId` all the way to the current leaf.
- **A tree can have multiple branches**: continuing from an old message with a new message does not overwrite the original subsequent content, but grows another route from the old node.
- The model only reads the **currently active branch** at a time, not all branches of the tree.

### 2.2 run, turn, event

| Term | Plain explanation | Boundary |
| --- | --- | --- |
| Run | Starts with an input and ends when the system confirms there is no further automatic work | Roughly corresponds to the beginning and end of `agent_start` / `agent_settled` |
| Turn | A single model reply and its required tool execution | `turn_start` / `turn_end` |
| Event | Status notifications during the run | Incremental text, tool start/end, message written to disk, etc. |

A run can contain multiple turns. A common reason is: the model first requests to read a file, after the tool returns results, the model may request again to give the final answer.

### 2.3 projection: foreshadowing for this stage

The model does not read session files directly. Before each request, Pi calculates a "model-visible conversation history" from the currently active branch, called a **projection**.

You can think of it as "a temporary working copy organized from the original ledger according to current rules". Why it doesn't just read files directly, how compression works, and how it participates will be fully explained in Stage 3.

---

## 3. 11 packages: first look at four types of uses, don't memorize the list yet

There are actually 11 packages in the repository. When first reading, don't spread your effort evenly, first group them by role:

```text
coding-agent
  ├─► agent ──► ai ──► telemetry
  ├─► ai
  ├─► codemode
  ├─► mcp
  └─► tui

durable ──► chord, ai, codemode
env     ──► chord, durable
evals   ──► ai, coding-agent
```

Arrows indicate that 'the package on the left depends on the package on the right.' `agent` only depends on `ai`, and does not depend on `coding-agent`, the interface, or the tools registry; this is exactly why the engine can be reused independently of the CLI.

### 3.1 Four Uses

| Role | Package | One-line Understanding |
| --- | --- | --- |
| Product Application | `coding-agent` | Assembles loops, sessions, tools, extensions, and interfaces into a usable Pi |
| Engine | `agent`, `ai` | `agent` handles loops; `ai` handles unified model access |
| Support | `tui`, `mcp`, `codemode`, `chord`, `durable`, `env`, `telemetry` | Responsible for interface, external tools, sandbox, runtime, and observation capabilities respectively |
| Development Tools | `evals` | Evaluation during development, not involved in main product runtime |

### 3.2 Main Dependencies

| Package | Internal Dependencies | Purpose |
| --- | --- | --- |
| `ai` | `telemetry` | Multi-vendor model access, streaming events, authentication, model catalog |
| `agent` | `ai` | General loop, deliberately does not depend on UI |
| `coding-agent` | `agent`, `ai`, `codemode`, `mcp`, `tui` | Complete CLI product |
| `durable` | `chord`, `ai`, `codemode` | Persistent runtime |
| `env` | `chord`, `durable` | Remote execution environment |
| `evals` | `ai`, `coding-agent` (development dependencies) | Development-time evaluation tools |
| `chord`, `codemode`, `mcp`, `telemetry`, `tui` | No internal dependencies | Leaf packages / basic components |

Just remember two directions:

1. **Trunk downward**: `coding-agent → agent → ai → telemetry`. The engine does not know about `coding-agent`, so it can be reused independently of the CLI.
2. **Capabilities outward**: `codemode`, `mcp`, `tui` are components connected by the application layer as needed, not functions hardcoded inside the loop.

### 3.3 The Two Most Easily Confused Objects

`AgentSession` and `SessionManager` are both in the application layer, but their responsibilities are completely different:

| Object | Like | Manages |
| --- | --- | --- |
| `AgentSession` | Project manager for a single task | Input processing, command judgment, template expansion, queuing, authentication, compression checks, starting/finishing a run |
| `SessionManager` | Archivist | Read/write JSONL, maintain `id`/`parentId` trees, find active branches, generate projections, record model switching and other states |

In one sentence: **`AgentSession` manages "how this run goes," `SessionManager` manages "what happened and how to retrieve it next time."**

The real loop is not in `AgentSession`, but in `packages/agent`.

---

## 4. The Complete Journey of a Request

This section is the core of the chapter. Follow the story first; don't rush to look at the code.

### 4.1 Entry Layer Receives Input

You press Enter in the interactive interface, and the interface hands the text (and possibly images) to:

```text
AgentSession.prompt(text)
```

The interface is not responsible for deciding which model to use, nor does it execute tools by itself. It is only responsible for input, display, and handing events over to the user.

### 4.2 AgentSession Conducts Pre-send Checks

`prompt()` Acts like the chief scheduler, handling in order:

1. **Extension Commands**: If the input starts with `/` and matches an extension command, it is executed directly without calling the model.
2. **Input Processors**: Extensions can intercept, rewrite, or cancel the input.
3. **Skills and Prompt Templates**: Expand `/skill:...` or templates into actual prompts.
4. **Streaming Queue**: If the previous response is still being output, this input will enter the steer or follow-up queue based on its type.
5. **Authentication Checks**: Confirm the selected model and that the provider has available credentials.

Only after passing these checks does it proceed to `_startRun()` / `_prepareRun()`.

### 4.3 Preparing This Run

The preparation phase mainly does three things:

- If the history is near the model limit, perform compression checks first;
- Trigger `before_agent_start` extension events;
- Assemble the new messages for this run and hand them to the engine's `Agent`.

Note: What is handed to `Agent` here is not the 'entire conversation history,' but the initial new messages for this run. The portion of the conversation history in the full context will be re-projected from the session ledger before actually sending the request; system prompts and tool declarations are assembled separately.

### 4.4 Agent Start Loop

After `Agent` receives the initial messages, it starts `runLoop`. The main thread of the loop can be summarized as:

```text
Preparing to request → to request model →. Are there any tool calls?
                          ├─ Have: execution tools, record results, return to 'prepare request'
                          └─ None: End this round; if there is no follow-up work, end this run
```

This is the whole secret of 'automatically continuing after tool invocation': the tool itself does not call the model again; rather, the loop treats the tool's output as the input for the next request.

### 4.5 Before sending a request: reconstructing context

Before each request, Pi prepares the context according to the same set of steps:

1. Trace back from the current leaf along `parentId` to find the active branch;
2. Apply the latest compressed checkpoint and context edits to generate a projection;
3. Convert the internal `AgentMessage[]` via `convertToLlm` into the model message format;
4. Add system prompts and tool declarations, and pass it to the model adaptation layer.

This chain of transformations must be distinguished clearly:

```text
Session File (Full Ledger)
  Active branch (current path)
       Projection (dialog history visible to the model)
            └─ convertToLlm (internal format → model format)
                 Send to provider
```

- **Projection** is about selecting content: what to keep, what to replace with a summary, and what to edit;
- **`convertToLlm`** is about reformatting: translating internal Pi messages into the message format required by the model interface.

### 4.6 Calling the Model and Streaming Responses

`agent` hands the unified format request to `ai`. `ai` sends an HTTP request according to the provider's protocol and converts the vendor's streaming data into internal events:

- Text start, text increment, text end;
- Thought increments;
- Tool call parameter increments;
- Complete message, errors, and aborts.

`message_update` is displayed in real time in the interface; the complete message is finalized and appended to the session ledger at `message_end`.

### 4.7 Tool Results Returning to Context

If the model's reply includes a tool call:

1. The engine verifies the parameters and executes the tool;
2. The results are written back to the context and session tree as `toolResult` messages;
3. Loops back to "rebuilding the context";
4. The model sees the tool results and decides the next action.

For example:

```text
User: Fix the login page error
  The model requires reading auth.ts
  → The tool returns the file content
  → The model requires searching for call points
  → The tool returns search results
  → The model requires code modification
  → Tool returns modification results
  The model provides the final explanation
```

A single user input may correspond to multiple model requests and multiple tool executions; they belong to the same run but are divided into multiple turns.

### 4.8 `agent_end` Why it is still not completely finished

Ordinary steering/follow-up will first be processed internally at the `runLoop` level; `agent_end` is only issued when there are no tool calls and no pending messages. However, the session layer may still:

- Automatically retry failed requests;
- Compress and restore when the context exceeds limits;
- Queue new work in the `agent_end` processor.

Only `agent_settled` indicates "there is no work that will continue automatically, Pi is truly idle." Interactive interfaces usually only fully return control to you at this time.

---

## 5. Observing the entire chain with an event stream

### 5.1 Running a JSON event stream

Execute in the learning area:

```powershell
cd $PI_SRC
.\pi-test.ps1 --mode json "Read the first 20 lines of package.json" > events.jsonl
```

You will see a sequence of events, rather than just the final response.

### 5.2 Key Events to Focus On

| Event | Description |
| --- | --- |
| `agent_start` | A run begins |
| `turn_start` | A turn of "model response → tool execution" begins |
| `message_start` | A message starts |
| `message_update` | Streaming increments (text, thoughts, tool parameters) |
| `message_end` | Complete message finalized, usually triggers persistence |
| `tool_execution_start/update/end` | Tool starts, outputs while executing, ends |
| `turn_end` | Current turn wraps up |
| `agent_end` | Underlying loop ends; ordinary follow-ups are processed, but session layer may still retry or recover automatically |
| `agent_settled` | Session layer confirms it is truly idle |

### 5.3 A Key Understanding: Events Are Not "Log Extras"

The event stream is the main observation interface exposed by the system:

- TUI uses it for real-time rendering;
- JSON mode outputs it as-is;
- RPC forwards it to external processes;
- SDK allows the host program to subscribe;
- When debugging an agent, it illustrates "what the system actually did" better than the final response.

So don't think of events as "logs printed along the way." They are part of the architecture.

---

## 6. Three Easily Confused Object Conversions

### 6.1 Session Entry → AgentMessage

A session file contains many entries, but not every entry becomes a model message. `label`, `usage`, `model_change` only affect state or UI, and during projection it is decided whether they generate messages.

### 6.2 AgentMessage → Projection

A projection is the "model-visible conversation history" derived from an active branch; it applies compression and context edits but does not rewrite the original entries. It is computed temporarily on each request and is not persisted separately.

### 6.3 Projection → convertToLlm → Message

This step only performs format conversion and does not decide content selection. `AgentMessage[]` is Pi's internal unified representation, `Message[]` is the format required by the model adaptation layer.

In short: **The projection determines "what to send" in the conversation history, system prompts and tool declarations are assembled separately; `convertToLlm` determines "in what format it is sent."**

---

## 7. Two Diagrams You Are Recommended to Draw Yourself

### Diagram 1: Package Dependency Graph

Draw according to the four groups: "product, engine, support, development tools," not by the number of files.

#### Reference Answer

Arrow `A ──► B` indicates that A depends on B.

```text
[Product Layer]
coding-agent
  ├─► agent
  ├─► ai
  ├─► codemode
  ├─► mcp
  └─► tui

[Engine Layer]
agent ──► ai ──► telemetry

Support Layer
durable ──► chord, ai, codemode
env     ──► chord, durable

chord, telemetry, tui, mcp, codemode: no internal dependencies

[Development Tools]
evals ──► ai, coding-agent (development dependency)
```

Looking at the four groups together, the main line is:

```text
coding-agent ──► agent ──► ai ──► telemetry
```

After finishing the drawing, check the following four points:

- `agent` should only depend on `ai`, and must not depend on `coding-agent` or `tui`; otherwise, the loop engine cannot be reused independently.
- `coding-agent` directly depends on `agent`, `ai`, `codemode`, `mcp`, `tui`, and it is the finished product that assembles these components.
- `durable` and `env` belong to platform support and are not part of the main "user message → model → tool" chain.
- `evals` is a development tool, not part of the product operation chain.

### Figure 2: Request Sequence Diagram

At minimum, depict:

```text
Interface → AgentSession.prompt
     Check before sending
     → _prepareRun
     → Agent.runLoop
     → Projection  + convertToLlm
     → ai / provider
     Tool Execution
     → message_end Place the disk
     → agent_end / agent_settled
```

#### Reference Answer

```text
Interface (TUI / print / JSON / RPC / SDK)
  │ User input
  ▼
AgentSession.prompt(input)
  ├─ Extended command? ── is ──► execute immediately, do not enter the model
  ├─ Input Processor: Intercept / Rewrite / Cancel
  ├─ Skills and Tips Template Expand
  ├─ Streamlined Queuing: steer / follow-up
  └─ Certification Check: Model and Credentials
  ▼
AgentSession._prepareRun()
  Compress if necessary
  ├─ before_agent_start
  └─ Generate the starting message for this addition
  ▼
Agent.runLoop()
  ├─ agent_start
  ├─ turn_start
  ├─ Find the active branch from the current leaf (SessionManager)
  ├─ Generate projection: apply compression and context_edit
  ├─ convertToLlm:AgentMessage[] → Message[]
  ├─ Assembly Request: System Prompt + Tool Declaration + Current Input
  ├─ ai / provider: streaming return
  │    └─ message_update / text_delta → Interface
  ├─ message_end: Assistant message written to disk
  Is there a tool to call?
  │ ├─ is: validate → execute → toolResult write to disk → next turn
  │    └─ No: check steer / follow-up
  └─ No tools and no queued work → agent_end
  ▼
Finishing up
  Automatic Retry
  Compression Recovery
  └─ Processing agent_end new jobs queued by the processor
  ▼
((Truly free))
```

Read along this chart: 

1. `AgentSession` Organize "User Input" into "Start message for this run". 
2. `AgentSession` does not save the entire history; The true history is found by `SessionManager` along `leaf` of the activity and then generated as a projection. 
3. `Agent` After receiving the projection in each round, a request is sent via `ai`; When the model requests a tool, the tool result is placed on the disk and used as input for the next round. 
4. `agent_end` only indicates that the underlying loop has ended; `agent_settled` only indicates that subsequent tasks such as automatic retry and compression recovery have also disappeared. 

After drawing, close the document and point to the diagram to explain each input and output step to pass. 

--- 

## 8. Common Misconceptions

| Misconceptions | Correct understanding |
| --- | --- |
| `agent` is the entire Pi | `agent` is just a loop engine; The complete product is `coding-agent` |
| `AgentSession` is the session file | `AgentSession` manages this run; `SessionManager` manages the persistent ledger |
| A user message corresponds to only one model request | When a tool call is used, a single input may trigger multiple requests and multiple turn | instances
| `agent_end` means the final end | Ordinary follow-up has already been processed in the underlying loop; Afterwards, there may be autoretrys, compressed recovery, or tasks that are queued by the `agent_end` processor, see `agent_settled` |
| The session file is the model context | The model only reads the dialogue history projected by the active branch, not the entire tree or the original file |
| Events are just logs | Events are common interfaces for TUI, JSON, RPC, SDK, and debugging |
| Projection rewrites the original history | Projection is a temporary view, and the original entry remains unchanged |

--- 

## 9. Self-inspection during customs clearance

Close the document, answer it yourself, then look it up later: 

1. What are the backbone dependencies of `coding-agent`, `agent`, and `ai`? What are they each responsible for? 
2. What is the difference between `AgentSession` and `SessionManager`? 
3. From the entry point to the first model request, which objects does a user message go through? 
4. Why does the tool automatically start the next round after the result returns? What are the stopping conditions? 
5. What is the difference between `agent_end` and `agent_settled`? 
6. What are projection and `convertToLlm` doing respectively? 

### Reference answers

1. **Backbone and Responsibilities**: `coding-agent → agent → ai → telemetry`. `coding-agent` is the complete product, responsible for input, sessions, tools, extensions, and interfaces; `agent` is the general-purpose loop engine; `ai` is responsible for unifying model protocols and streaming events from different vendors; `telemetry` provides the format for observing data. `coding-agent` also directly depends on `ai`, `codemode`, `mcp`, `tui`, `evals` is the development tool. 

2. **Division of labor between two objects**: `AgentSession` Like a project manager running once, responsible for receiving input, processing extension commands, expanding templates, queuing, checking authentication, triggering compression, starting and finishing; `SessionManager` Like an archive administrator, responsible for reading and writing JSONL, maintaining `id`/`parentId` trees, finding current active branches, generating projections, and recording model switches. The former decides "how to run this time," while the latter decides "what happened and how to retrieve next time." 

3. **First Model Request Path**: Interface call `AgentSession.prompt()` → Check before sending → `_prepareRun()` → `Agent.runLoop()` → `SessionManager` Find the active branch and generate a projection → `convertToLlm()` → Add system prompts and tool declarations → `ai` → provider to send the request. 

4. **Why AutoNext Round**: The tool result is not the endpoint but a new `toolResult` message written back to context; When the loop sees the tool still working, it carries it into the next round. The stop condition is "no tool call, no pending steering / follow-up," or explicit termination, error, or abortion. Normal follow-up processes first within the underlying loop before `agent_end`; The session layer may also retry or compress recovery. 

5. **Boundary of Two End Signals**: `agent_end` indicates that the underlying `runLoop` has finished, but the session layer may still need to automatically retry, compress recovery, or handle new tasks scheduled by the `agent_end` processor; `agent_settled` means "no tasks will continue automatically," and the interface is truly free. 

6. **Projection and Format Conversion**: Projection is responsible for selecting and organizing the "model-visible dialogue history" from the active branch, applying compression and `context_edit` but not rewriting the original entry; `convertToLlm` only translates this internal `AgentMessage[]` into the provider's required `Message[]`, without determining the historical content. System prompts, tool declarations, and current inputs are also assembled together outside the projection. It can be recorded as: **Projection is editing, `convertToLlm` is translation.** 

**One-Minute Recap Version**: User input is first handed over to `AgentSession` and organized into a run; `Agent` Each round takes the current active branch from `SessionManager` and generates a projection, which is then combined with `convertToLlm` with system prompts and tool declarations to form a request and handed over to `ai`; When the model needs a tool, it executes and writes back the result until it stops working automatically, then issues `agent_end`. After the session layer is finished, it reaches `agent_settled`. 

Recommended outputs:

- [ ] A package dependency diagram;
- [ ] A request sequence diagram;
- [ ] A JSON event stream that can highlight at least 5 types of events and explain their order;
- [ ] Explain in 3 minutes, without notes, "how a request traverses through Pi." 

The next stop is Stage 2: separately break down the "loop" in this main thread to see how run, turn, steering, follow-up, and abort form an interruptible state machine.

---

*Supporting [learning path](../learning-path/) Stage 1 · Based on v1.3.0 (`71023aec`)*
