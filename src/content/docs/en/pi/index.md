---
title: "Pi 1.3.0: Introduction and Overall Architecture"
description: "From entry, sessions, loops, tools to extensions, build a complete system map of Pi 1.3.0."
---

:::note[Independent Study Notes]
This is an independent study note compiled from the [Pi](https://github.com/earendil-works/pi) `v1.3.0`(commit `71023aec`) source code and public documentation, not the official documentation. This site does not contain upstream source code; Hereafter, `$PI_SRC` refers to your own local source directory. If you follow upstream development, prepare an independent checkout directory, which is recorded as `$PI_DEV`. 
::: 

> This document answers three questions: What is Pi? How is internal layering performed? What are the key design trade-offs? 
> Based on Learning Area version v1.3.0 (`71023aec`, released on 2026-10-15). All paths are relative to `$PI_SRC`. 
> Usage: Read the 'seven blocks' summary table starting with [Study Route](learning-path/); Each learning stage delves into one section. 

## 1. What is Pi?

README's original words: **"Pi is a minimal, extensible agent harness that you can make your own."** 

Breaking down this sentence word by word: 

- **Agent harness**: Pi is neither a model nor an editor. It is responsible for arranging "models, tools, contexts, and sessions" into a system that can work automatically—the model is the engine, and the Pi is the drivetrain and chassis. 
- **minimal (minimal core)**: The core remains small and stable. Even for core functions like MCP, tool search, and codemode, Pi is built into extended forms as much as possible (see `packages/coding-agent/src/extensions/` for codemode, MCP, tool-search, and llama). 
- **extensible**: Extensions are in-process TypeScript modules; Skills, prompt templates, and themes are loaded on demand; Can be packaged as Pi packages distributed via npm / git. 
- **make your own**: The official explicitly skips features like sub-agents and plan mode—not because they can't be done, but because these capabilities are better suited for you or the community to grow in your own way ("Adapt Pi to your workflows, not the other way around.")).  

**Five Usage Modes** (Same engine, same session mechanism, see Stage 7 for details): 

| Form | Entrance | Suitable |
| --- | --- | --- |
| Interaction mode | Direct terminal operation `pi` | Human-machine pairing: stream output, tool blocks, slash commands |
| print | `pi -p "task"` | Execute results in one go, script |
| JSON | `pi --mode json` | stdout outputs the complete event stream for program parsing |
| RPC | `pi --mode rpc` | stdin/stdout JSONL protocol, bidirectional control of external processes |
| SDK | TypeScript library (@earendil-works/pi-coding-agent) | Process embedding: Creating sessions, sending tasks, receiving events |

## 2. Component Panorama: Any agent consists of seven pieces

The summary table of the learning list is supplemented here with a column titled "Position in Pi": 

| Component | Question to answer | Corresponding to Pi | Stage |
| --- | --- | --- | --- |
| Loop | How to advance a round? When to adjust the model, execute tools, and stop? | `packages/agent` + coding-agent session orchestration | 2 |
| Context | What is sent to the model each time? How do you save, press, and retrieve it? | Session tree JSONL, compression, system prompts | 3 |
| Tools | What actions can the model do? How to execute, verify, and display? | `packages/coding-agent/src/core/tools` | 4 |
| Model Access | How to unify multiple vendors into a single interface? How to manage credentials? | `packages/ai` + Model Directory | 5 |
| Extensions | How do capabilities grow? How do you divide core and ecosystem tasks? | Extensions / Skills / MCP / codemode | 6 |
| Interface | How can the same engine serve people, scripts, and programs at the same time? | TUI / print / JSON / RPC / SDK | 7 |
| Engineering | How to Ensure Changes Are Reliable and Sustainable Evolution? | Testing (Faux Provider) / Check Pipeline / Release Process | 8 |

## 3. Layered Architecture: What exactly does each layer do?

First, remember a general principle: **Pi breaks down "interacting with people, assigning tasks, cycling models and tools, connecting model vendors" into different layers.** When changing interfaces, models, or adding tools, only the corresponding layer needs to be changed, no need to start over. 

### 3.1 Let's first look at the simplified diagram: tasks go down, events go up

```text
┌──────────────────────────────────────────────────────────────┐
│ Entrance Level: Interaction TUI / print / JSON / RPC / SDK                  │
│ Responsible for receiving input and displaying results; not responsible for deciding what the model should do │
└───────────────────────────┬──────────────────────────────────┘
                            │ ① Input: text, images, commands
┌───────────────────────────▼──────────────────────────────────┐
│ Application Layer: coding-agent (the product itself)                             │
│                                                              │
│ AgentSession   The "overall dispatch" of a mission                           │
│ Organizing input, verifying authentication, queuing, compressing, starting, and finishing │
│                                                              │
│ SessionManager Conversation "Ledger" │
│ Read and write JSONL conversation tree, reconstruct context according to active branches │
│                                                              │
│ Tools / Extensions / Skills & Prompt Templates / Model Selection & Credentials                │
└───────────────────────────┬──────────────────────────────────┘
                            │ ② Historical Messages + System Prompts + Tool Declaration
┌───────────────────────────▼──────────────────────────────────┐
│ Engine Layer                                                       │
│ agent: loop execution of 'request model → to execute tool → then request model again' │
│ AI: Unify the request formats and streaming responses from different vendors into a single internal format │
└───────────────────────────┬──────────────────────────────────┘
                            │ ③ Request in a unified format
┌───────────────────────────▼──────────────────────────────────┐
Model Supplier: Anthropic / OpenAI / Google / ...                  │
│ The actual place where answers are generated                                           │
└──────────────────────────────────────────────────────────────┘

The event returns in the opposite direction:
Model response snippets, tool start/end, message logging...
Ultimately, it is decided by the entry layer how to display, or it is handed over to an external program for processing.
```

Looking at this chart, you only need to grasp three things: 

1. **Downward**: A task is organized layer by layer into requests that the model can handle. 
2. **Upward**: State changes during execution are returned as "events," which both the interface and the program consume. 
3. **Besides**: The session ledger continuously records what happened and provides a history before the next request. 

### 3.2 What are the four floors responsible for?

| Layer | You can think of it as | Responsible | Not responsible |
| --- | --- | --- | --- |
| Entry layer | Frontend | Receive input, display streaming output, and tool progress | Decide how to cycle and compress history |
| Application layer | Project manager | Arrange a task properly: sessions, tools, extensions, resources, authentication | Which model is called specifically, and how the model runs internally |
| Engine layer | Execution team + translation | Advance loops, execution tools, unified model interfaces | What does the terminal look like, and which shortcut keys the user presses |
| Vendor | External expert | Generate text or tool calls based on request | Remember the previous request; Save Pi's session history |

The 'not responsible' in the table is very important. Whether the layers are clear mainly depends on the boundaries, not the number of terms. 

### 3.3 Application Layer: The Two Most Easily Confused Objects

Both belong to the application layer, `AgentSession` and `SessionManager` are often confused. They can be distinguished as follows: 

| Object | Like What | Specifically what is managed |
| --- | --- | --- |
| `AgentSession` | Dispatcher for a single task | Determine extension commands, process input, expand skills/templates, queue during streaming, check authentication, compress checks, trigger extension events, start and wrap up a single run |
| `SessionManager` | Archive Administrator | Append messages and states to JSONL; Maintain id/parentId trees; Identify active branches; Generate projections; Record reading/writing tags, model switching, etc. |

In short: **`AgentSession` Manage "how to run this mission," `SessionManager` Manage "how to store and retrieve what has happened."** 

The true "ask the model—run the tool—ask the model again" loop isn't in these two objects, but in the engine package `agent`. 

### 3.4 Engine Layer: Loops and Translation

- **`agent`: Loop engine.** It only cares about messages, turns, tool calls, and events, and doesn't know if the outside is a terminal, script, or another program. Because of this, the same engine can serve five different usage modes simultaneously. 
- **`ai`: Model adaptation layer.** Anthropic, OpenAI, and Google each have different authentication methods, request fields, and streaming event formats; `ai` These differences are stored in their own provider adapter, and only the unified format of text increments, thought increments, tool call increments, ends, and error events is handed over upward. 
- **Model Directory** is also provided by `ai`: context window, pricing, capability tags, etc. It means that "what models are available and what each can do" does not have to be hard-coded into the loop. 

If you're not familiar with `provider`: here you can think of it as 'an integration plugin from a specific model vendor.' Pi's business code only addresses the unified interface, not the full `if Anthropic ... else if OpenAI ...`. 

### 3.5 Entry Layer: Five doors, one kernel

Interactive TUI, `print`, JSON, RPC, and SDK may look very different, but they only do two things: 

1. Input is given to the same session system; 
2. Consume the same event stream and decide how to display or forward. 

Therefore, the behavior you see in the terminal and the behavior your script obtains via JSON/RPC/SDK come from the same engine and session mechanism. `print` Only the final answer is retained: JSON outputs the full event, RPC allows external processes to control the process bidirectionally, and the SDK embeds the session into the TypeScript program. This part will be expanded in Stage 7. 

### 3.6 Auxiliary Components Outside the Figure

| Component | Function | Note when needed |
| --- | --- | --- |
| `tui` | Terminal differential rendering | Interaction mode uses |
| `mcp` | Connecting to an external MCP tool server | External tool ecosystem |
| `codemode` | Run JS in the sandbox and complete complex operations through injected tools | Tool orchestration |
| `tool-search` | When there are many tools, find the right tool | Extended form built-in |
| `chord` → `durable` → `env` | Plugin host, persistent runtime, SSH remote execution | Platform-based runtime, independent evolution |
| `telemetry` / `evals` | Telemetry Data Formats, Evaluation Frameworks | Engineering and Testing |

These components are not the gateway to understanding the main chain. At first reading, just know they are "on-demand access" and don't let the package name interrupt the main line. 

### 3.7 Two rules running through the entire system

- **The session is the ledger.** The file is in `~/.pi/agent/sessions/--<working-directory>--/*.jsonl`; Inside is a tree that can be appended. The current end is called the leaf; tracing back from the leaf to the root is the 'active branch', and the next request history is derived from this branch. 
- **Permissions follow the operating system.** Pi does not implement a customized, fine-grained sandbox; Tools and extensions default to Pi processes have system permissions themselves. Make trust decisions before opening a project; When strong isolation is needed, put the entire Pi into the container, rather than just adding a false privilege to a tool. 

These two rules will reappear repeatedly in chapters four and five; just memorize one sentence each. 

## 4. The Complete Journey of a Request

This chapter actually walks through the diagrams from Chapter 3. You can skip the code name for now, as long as you can say "Who gave what to whom" at every step. 

### 4.1 Six words, clarify first

| Terminology | One-sentence explanation | The most easily misunderstood place |
| --- | --- | --- |
| Prompt | The task text you give Pi (possibly with images and file references) | It's just new input, not all the model sees this time |
| Run | From submitting this input until Pi confirms "there will be no more automatic work" the entire execution | A run usually contains multiple turn | files
| Turn | A full turn of "model responding to Pi's tool to execute its request" | When the model only talks and does not call the tool, it also counts as a turn |
| Context | This request actually sends everything to the model: history, system prompts, tool descriptions, current input, etc. | It is not equivalent to a session file; There are many things in the file that are out of context |
| Projection | The "model-visible dialogue history" organized by rules from the current activity branch | It is not a rewrite of the original file, but a view calculated on the spot each time; The full context must also include system prompts, tool declarations, and the current input |
| Event | Status notifications sent during execution, such as reply fragments, tool start/end, message placement | are not loggiveaways; interfaces and external programs rely on them to work |

First, remember the four words **run, turn, context, projection**, which will appear repeatedly later. 

### 4.2 From Enter to Answer: Viewing in Stages

#### Stage A: Entry layer receives input

You hit Enter in the input box. The interactive interface does only one thing: hand over text (and possibly images) to `AgentSession.prompt()`. It doesn't guess the model by itself, nor does it run the tool itself. 

#### Stage B: AgentSession performs a "pre-send check"

`prompt()` Like the main scheduler, process in order: 

1. **Extension Command**: If you enter an extension command starting with `/` and hit it, it will run directly without calling the model. 
2. **Input Processor**: Extensions can intercept, rewrite, or even cancel this input. 
3. **Skills and Prompt Templates**: Expand `/skill:...` or templates into actual prompt words. 
4. **Stream Queue**: If the previous reply was still streaming, this time the input will not be forced, but will be typed into the steer or follow-up queue. 
5. **Authentication Check**: Confirm that the model has been selected and that the provider has available credentials; Otherwise, an error will be reported and a login prompt. 

After all these checks are passed, we enter `_startRun()` / `_prepareRun()`], preparing to actually start a run. 

#### Stage C: Prepare for this run

Do three things at this stage: 

- **Compression Check**: If the history is close to the model limit, first compress the old history with a summary. 
- **Trigger `before_agent_start`**: Extensions can be used here to supplement messages, adjust toolkits, or system prompts. 
- **Assemble Start Messages**: Organize the current input, pending next round messages, and extended injection messages, then hand them to the engine's `Agent`. 

Note: What is given to `Agent` here is "the message to be added this time," not the entire history. The complete history will be recalculated from the session ledger before the actual request is made. 

#### Stage D: Agent starts the loop

`Agent` Starts after receiving the start message `runLoop`. This loop has only one main thread:

```text
Ready to request → to request model →. Does the model need to call a tool?
                              Action: Execute the tool, record the results, return to 'Prepare Request'
                              Do not: end this round; if there is no follow-up work, end this run
```

"When the tool results return, it automatically asks the model again" is not a magic tool but the design of the loop itself. 

#### Phase E: Reconstruct the context of this event

This is the most important step in the entire chain to slow down. Before actually sending to the model, Pi does three things in order: 

1. **Find active branch**: Trace back from the current leaf along `parentId` to the root to obtain this conversation path. 
2. **Generate Projection**: Apply the latest compressed checkpoints and context editing on the branch to get "the dialogue history the model should see this time." 
3. **Data Format Transformation**: Convert the internal `AgentMessage[]` of Pi into `convertToLlm` to the `Message[]` required by the model interface, then form the request together with system prompts and tool declarations. 

Illustrated by a small image:

```text
Session file (complete ledger, append-only)
   Active branch (current path)
        Projection (after applying compression/editing, the dialogue history visible to the model)
             └─ convertToLlm (internal format → model format)
                  └─ System prompt + Tool declaration + Current input
                       └─ Send to the model
```

Difference between the two terms:

- **Projection** determines "which content is retained, which is replaced by summaries, and which is edited," dealing with content-level organization;
- **`convertToLlm`** is only responsible for "translating data from Pi's format to the model API's format," and does not decide historical content.

#### Stage F: Calling the model, generating and displaying simultaneously

The engine selects a provider through `ai`, and sends a request with authentication information and model parameters. The response does not wait until everything is generated to return, but is streamed as events:

- Text start / text increment / text end;
- Thought start / thought increment / thought end;
- Tool call parameter increments;
- Complete message and errors.

The interface sees `message_update` to refresh in real-time. When a complete message finishes, `message_end` triggers saving: the message is appended to the session JSONL.

#### Stage G: If there is a tool call, start another round

A model's reply may contain only text, or it may simultaneously include one or more tool calls. If there is a tool call:

1. The engine validates and executes the tool;
2. The tool result becomes a `toolResult` message, appended to the context and saved;
3. Loop back to Stage E, recalculating the context from the session ledger;
4. The model sees the tool result and decides whether to continue calling tools or give the final answer.

For example, if you ask it to fix a login bug, multiple rounds may actually occur:

```text
User: Fix the login page error
  The model needs to read the file
  → Pi Read file, return content
  → The model needs to search for call points
  → Pi Search, return results
  The model's code needs to be changed
  → Pi modified, return result
  The model provides the final explanation (no more tool calls)
```

This is why a single user input may correspond to many model requests and tool executions. They all belong to the same run, but are divided into multiple turns.

#### Stage H: `agent_end` does not mean 'completely finished'

Ordinary steering/follow-up will first be processed internally in `runLoop`; only when there are no tool calls or pending messages, `agent_end` will be issued. But this does not necessarily mean it is idle, because the session layer may still:

- Automatically retry a failed request once;
- Compress and retry when the context limit is exceeded;
- Queue new work in `agent_end` processors.

Only when `agent_settled` occurs does it mean 'Pi no longer has any work that will continue automatically, and is now truly idle.' The interactive interface usually returns full control to you only at this point.

### 4.3 Compressing the entire process into a timing diagram

```text
You press Enter
  │
  ▼
Entrance layer → AgentSession.prompt()
          ├─ Extended command? ────────────── is ──► Execute immediately, terminate
          │
          ├─ Input Processing / Template Expansion / Queuing / Authentication
          ▼
       _prepareRun()
          Compress if necessary
          ├─ before_agent_start Extended Event
          └─ Assembly start message
          │
          ▼
       Agent.runLoop ◄──────────────────────────────┐
          │                                          │
          ▼                                          │
       Generate projection from active branch │
          │                                          │
          ▼                                          │
       convertToLlm → System Prompt + Tool Declaration → Request Model │
          │                                          │
          ▼                                          │
       Does the model response ── involve tool invocation? ── is ──► executing the tool ─────┘
          │
          No
          ▼
       agent_end
          │
          ├─ Automatic Retry / Compression Recovery / agent_end New Job? ── is ──► Continue Running
          │
          No
          ▼
       ((Truly free))
```

Remember in one sentence: **`AgentSession` Arrange a single input as a run; `runLoop` Each round asks the model from the session ledger reconstructing the context; If the model needs a tool, run it and then continue asking until it stops working automatically, then stops at `agent_settled`.** 

### 4.4 Four Common Misconceptions

| Easy to understand like this | More accurate understanding |
| --- | --- |
| "There are 100,000 words in the session file, and the model receives 100,000 words each time." | No. The model only receives the projected conversation history, plus system prompts, tool statements, etc.; The compressed old content is replaced by a summary, while the original text remains in the file. |
| "Compression means deleting old messages." | Not deleting. Compression only adds a summary checkpoint, which is used in subsequent projections to replace old messages; The original entry remains, and can still be traced back afterward. |
| "When you see `agent_end`, you can continue inputting it." | This is the end of the underlying loop, not the entire system being idle; The real idle signal is `agent_settled`. |
| "The model remembers the previous round." | Pi must resend the current context to the model each time; The model itself does not store this session; the ledger and projection are handled by Pi

For complete details, see [Stage 1](stage-1/) (request journey, event correspondence), [Stage 2](stage-2/) (loop state machine, three ports), and [Stage 3](stage-3/) (session tree, compression and projection, system prompts). 

## Five and Six Key Design Trade-offs

Many of Pi's designs may seem like "detours" at first glance, but they're actually solving a specific problem. Each choice below is explained in the same order: **What happens if you don't do it→ What does Pi do→ What do you get, what do you have to give**. 

### 5.1 Small core, abilities placed in expansions

**Trouble**: If every new feature is crammed into the core, the core will become harder to read, harder to change, and harder to test. 

**Method**: The core retains only what is missing and cannot work: loops, sessions, tool interfaces, model integration. Capabilities like MCP, tool search, and codemode are accessed as extensions or built-in modules and can be enabled as needed. 

**Result**: Small core, replaceable and composable capabilities. The trade-off is that the extension mechanism itself must be thoroughly designed; When reading source code, distinguish between the "core" and the "built-in extensions with the product." 

You can think of it as the operating system kernel and applications: the kernel doesn't have to have all the software built-in, but it must provide stable processes, files, and network interfaces. 

### 5.2 Conversations are trees, not just chat records

**Trouble**: If chat history is only an array from start to finish, it will be awkward to go back to old messages, restart, preserve the original text for compression, or view a branch; Overwriting old records directly may also damage history. 

**Method**: Each entry has `id` and `parentId`, forming a tree with only additions. The leaf you are currently in determines the active branch; Continuing chat from the old location means new branches grow within the same file. Summary and context editing also add a record each, without overwriting the original message. 

**Result**: Backtracking, branching, and playback are possible; There is no need to rewrite existing history when writing. The trade-off is that "reading history" cannot be read directly from the array; it must first find the active branch before generating the projection. 

### 5.3 Model Requests Are Stateless, and Context Rebuilds Each Time

**Trouble**: The model does not save the entire session for Pi; and Pi compresses and edits in history. If you mix the "original record" with the "actual content sent this time," it becomes very difficult to determine what to send next. 

**Method**: Completely separate the two. Before each request, Pi calculates a projection from the active branch: applying the latest compression checkpoint and context edit, then converting it into a model message through `convertToLlm`. Compression and editing only record the "how to modify" and do not override the original message. 

**Result**: Any request can be re-derived from the session file, and after compression, it can still be returned to the original text; The trade-off is that each request must recalculate the projection, and the related logic must be highly reliable. 

### 5.4 Using Event Streams as Unified Interfaces

**Trouble**: Terminal interfaces, scripts, and external programs all want to know what the agent is doing. If each interface writes its own call logic, it will result in five sets of behaviors and five sets of bugs. 

**Approach**: The engine sends all state changes as events; Various interfaces are just consumers of events. TUI is responsible for drawing, `print` only outputs the final result, JSON writes the full event as JSONL, RPC forwards it to external processes, and SDK lets the TypeScript program subscribe directly. 

**Result**: One core service in multiple forms; during debugging, you can directly look at the original event flow to know which step is executed. The trade-off is that event formats must be stable, and consumers must correctly handle increments, ends, and errors. 

### 5.5 Translating Different Model Vendors into the Same Interface

**Trouble**: Anthropic, OpenAI, and Google all have different authentication methods, request fields, streaming protocols, and tool call formats. If you write vendor branches everywhere in the loop, adding a new model can affect the whole system. 

**Method**: `ai` Internally provide a provider adapter to unify requests and responses into a single set of internal events. The model directory also records context window, price, capability, and other information; directory data is maintained separately from the code skeleton to avoid large amounts of irrelevant changes caused by frequently changing data. 

**Result**: Adding a provider only needs to change the access layer; loops and interfaces are unaffected. The trade-off is that the adaptation layer must handle the boundaries of each provider; Some vendors have unique capabilities that require capability marking or degradation strategies. 

### 5.6 Leave the Security Boundary to the Operating System and Containers

**Trouble**: The tool can read files, run commands, and extend to execute in-process code. Writing your own "permission sandbox" sounds safe, but in reality, it easily leaves loopholes and gives a false sense of security. 

**Method**: Pi Do not build a fine-grained permission sandbox yourself. Tools and extensions directly use the Pi process's operating system permissions; When opening a project, make a trust decision first; When strong isolation is required, place the entire Pi in a container (Gondolin extension, whole-process Docker, OpenShell policy sandbox). 

**Result**: The permission model is simple, predictable, and auditable. The trade-off is that default permissions are very large: do not run tools arbitrarily in untrusted warehouses; high-risk tasks should be placed in containers. 

### 5.7 Connect the six choices

- Small core + expansion: The system can grow, but the core doesn't have to expand with it. 
- Tree ledger: History can be reviewed and branched, no need to keep just one line. 
- Each projection: compression and editing do not destroy the original, and requested content can always be rederived. 
- Event Flow: The same engine can serve people, scripts, and external programs. 
- Provider adaptation: Changing models does not require changing loops or interfaces. 
- Operating system/container: Security boundaries are simple and clear, no "fake sandbox" is created. 

These six are not isolated designs but work together: **The tree ledger stores facts, the projection generates the current view, the event stream delegates the process externally, the provider adaptation connects different models, and the small kernel and operating system permissions determine the system's boundaries.** 

## 6. Quick Package Searches and Dependencies

One-sentence responsibilities for the 11 packages (Stage 0 self-check answer sheet, with dependency notes added here): 

| Package | In a word: Responsibility | Internal dependency |
| --- | --- | --- |
| agent(pi-agent-core) | Universal Agent Runtime: Tool Call Loops and State Management, Decoupled from UI/Model | ai |
| ai | Unified Multi-Vendor LLM API: Streaming Event Normalization + Model Directory + Authentication | telemetry |
| coding-agent | Complete CLI Application: Sessions, Tools, Patterns, Interface Assembly | agent, ai, codemode, mcp, tui |
| tui | Terminal UI Library: Differential Rendering | None |
| mcp | Standalone MCP client (external tool protocol) | None |
| codemode | Sandbox JS runtime: The only capability is to call the injected tool | None |
| chord | Plugin hosts: hot overload, contract, copy state, JSON-RPC | None |
| durable | Persistent Dialogue/Task/Document Runtime | chord, ai, codemode |
| env | Remote execution environment (SSH-deployed daemon + client) | chord, durable |
| telemetry | Common format for telemetry data: unified event and indicator structure, not tied to any particular vendor | None |
| evals | Evaluation Framework (Development Tool) | ai, coding-agent |

Backbone: `coding-agent → agent → ai → telemetry`. For the complete dependency diagram, see [Stage 1](stage-1/) Section 3.2. For drawing exercises, see Chapter 7. 

## 7. Document Map

| Document (`packages/coding-agent/docs/`) | Content | Corresponding Stage |
| --- | --- | --- |
| how-pi-works.md | Official Mental Model (Section 6: loop / context / sessions / interfaces / extensions / trust) | 1–3 Essential Reading for Beginners |
| session-format.md | Session Tree JSONL Format: entry Type, Branch, Compression, Editing | 3 |
| cli.md / json.md / rpc.md / sdk.md / usage.md | Five Interfaces and Their Uses | 7 |
| extensions.md / skills.md / prompt-templates.md / themes.md / packages.md | Expansion and Resource System | 6 |
| Others (models, containerization, security, etc.) | View as needed | 5 / 8 |
| examples/sdk/01–14 | Teaching programming examples, from basic to advanced | 7, 9 |
| Warehouse Roots CONTRIBUTING.md, AGENTS.md,  pi/skills/ | Development Rules and Release Process | 8 |

**Supporting Chapters** (can continue reading in the sidebar): 

| Chapter | Content | Corresponding Stage |
| --- | --- | --- |
| [Study Route](learning-path/) | Route Outline: Seven frameworks, phased routes, customs clearance standards (including complete documentation map) | General Outline |
| [Stage 0](stage-0/) | Environment Setup and Two Basic Uses | 0 |
| [Stage 1](stage-1/) | End-to-End Lifecycle of a Request | 1 |
| [Stage 2](stage-2/) | agent loops and event flows | 2 |
| [Stage 3](stage-3/) | Session Trees, Context Assembly, and Compression | 3 |
| [Stage 4](stage-4/) | Tool Pipeline Eight Passes | 4 |
| [Stage 5](stage-5/) | Model Access and Credential System | 5 |
| [Stage 6](stage-6/) | Extensions, Skills, MCP, codemode | 6 |
| [Stage 7](stage-7/) | Five Interface Forms and Integration | 7 |
| [Stage 8](stage-8/) | Engineering, Testing, and Release | 8 |
| [Stage 9](stage-9/) | Complete Mini Agent, Testing, and Graduation Acceptance | 9 |
| [Elective Section](electives/) | Elective Area Five Blocks (Telemetry / Durable / ENV / Chord / Evals) and Cache Diagnostics, In-Depth on Demand | Elective |

Stages 1–9 are organized according to the same learning rhythm: first explain the problem, then the concepts and flow, then provide the code location or small experiments, and finally conclude with common misconceptions and self-checks; Stage 0 follows the installation steps. When solving problems, use detailed explanations; official docs are used for comparison. 

## 8. Learning Area Information

- Source code baseline: v1.3.0 (`71023aec`, released on 2026-10-15); please check out the corresponding version from the official repository.  
- Development area: `$PI_DEV`—main repository; if you want to follow the upstream development line, start working here. The main content and experiments of this course are based on the learning area fixed at v1.3.0.  
- Reference examples: online documentation https://pi.dev/docs/latest; the practical entry point is `pi-test.ps1` (source code run directly, but needs building).  

---

*Compiled along with the [learning path](learning-path/) · 2026-10-19 · Based on v1.3.0 (`71023aec`)*
