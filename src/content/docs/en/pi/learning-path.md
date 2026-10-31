---
title: "Pi 1.3.0: Learning Path"
description: "The Pi learning path is organized into seven modules and ten stages, along with the completion criteria for each stage."
---

> **Course Objective**: It is not about memorizing the Pi API, nor reading every line of source code. Instead, it is about building a complete mental model that can be transferred to any Agent project—understanding why an Agent is layered this way, how context flows, how tools are executed safely, and how the system scales and evolves.
>
> **Who It's For**: Readers who know a bit of TypeScript, can run projects from the command line, but do not yet have a systematic understanding of Agents.
>
> **Source Code Directory**: `$PI_SRC`, fixed at v1.3.0 (`71023aec`).
> **Development Area**: `$PI_DEV`, used when following the upstream development line; stages 1–8 do not require changes here.
> **Overview**: First read [Introduction and Overall Architecture](../), use this checklist as a roadmap, then read the detailed explanations stage by stage.

---

## 1. Establish the Big Picture: What Exactly Is an Agent

In one sentence: **An Agent is a program that "makes decisions repeatedly".** It passes the user's goals, history, system prompts, and tool instructions to the model; the model decides whether to respond or call a tool; after the tool results return to the context, the model decides the next step, until the task is completed.

```text
User or program
   │
   ▼
Input Layer: TUI / print / JSON / RPC / SDK
   │ Input and Output
   ▼
Application Layer: Session orchestration, tools, extensions, resources, model selection
   Organize 'what to do this time' into a single run
   ▼
Engine Layer: Loop (Query Model ↔ Execute Tool)
   Uniformly formatted request
   ▼
Model suppliers: Anthropic / OpenAI / Google / ...
```

Next to it, there is also a continuously written **session ledger**. It records what has happened; before the next request, the system will reconstruct a "model-visible conversation history" from the currently active branch, which is called a projection.

### Seven Functional Blocks of an Agent

Any coding agent can be broken down into seven blocks. Learning Pi is to see how these seven blocks cooperate:

| Functional Block | Question to Answer | Main Location in Pi | Corresponding Stage |
| --- | --- | --- | --- |
| Loop | When to query the model, execute tools, continue or stop? | `packages/agent` | 2 |
| Context | What exactly is shown to the model each time? | Session tree, projection, compression, system prompts | 3 |
| Tools | What can the model do to the world? How to verify and execute? | `packages/coding-agent/src/core/tools` | 4 |
| Model Integration | How to unify APIs and credentials from different vendors? | `packages/ai` | 5 |
| Extensions | How do new capabilities grow without changing the core? | Extensions, skills, MCP, codemode | 6 |
| Interface | How can the same engine serve humans, scripts, and programs simultaneously? | TUI / print / JSON / RPC / SDK | 7 |
| Engineering | How to make changes reliable, testable, and publishable? | Testing, checks, build, release process | 8 |

### Three Continuous Threads Throughout the System

Besides the seven blocks, always keep these three questions in mind:

1. **How do events flow?** Model increments, tool states, and message logging all use events to notify the outside; the interface is just an event consumer.
2. **Where is the trust boundary?** Tools and extensions run with Pi process system permissions; project trust and containers determine "what it can touch."
3. **Where do costs come from?** History, tool results, and skill descriptions all occupy context; compression, truncation, and lazy loading all control cost and quality.

---

## 2. The Entire Course Revolves Around One Main Line: The Journey of a Single Request

Each following chapter breaks down a segment of this line:

```text
Input
  The entrance level is handed over to AgentSession
  Check commands, expand templates, queue, authenticate
  Prepare for a run: compression check, extension hooks, initial message
  → Agent Loop: Rebuild Context → Request Model → Execute Tool → Request Again
  → Message and tool results are written into the conversation tree
  → agent_end: End of inner loop
  → agent_settled: No automatic work, truly idle
```

You need to be able to answer four questions at any time: 

1. **Where does this request come from?** Interface, script, or external program? 
2. **What does the model see this time?** ** The content obtained from the current active branch after compression and projection. 
3. **What did the model do?** ** Just answer, or call the tool? How did the tool result return to context? 
4. **When does the system truly stop?** `agent_end` and `agent_settled` are not the same thing. 

Only by being able to explain each component along this line can you truly understand the Agent; Just remembering the file name doesn't count. 

--- 

## 3. How to learn: Follow the same five-step cycle in every chapter

### Step 1: Answer the chapter questions in your own words

For example, the question in Stage 3 is not "What fields are in the session file?", but rather: 

> The model itself doesn't remember, so why can Pi still have continuous conversations? What exactly do you send it each time? 

Write down your intuitive answers first, then read the material. Reading with questions is much more effective than starting from a table of contents. 

### Step 2: Draw a diagram

Each chapter should produce at least one diagram: request stream, loop state machine, tree and projection, tool lifecycle, extension points, interface selection. Diagrams don't have to be beautiful, but they must let you understand relationships without looking at the code. 

### Step 3: Go to the code for verification

Only follow the paths related to this chapter; do not start reading through the repository's root directory. Each concept should be integrated into a specific object or function: 

- Loop: `runLoop`, `turn_start`, `turn_end`
- Context: session entry, active branch, compression, projection, `convertToLlm`
- Tools: tool definition, parameter validation, execution, result backfill
- Model: `Model`, `StreamFunction`, provider adapter
- Extensions: contribution points, event hooks, resource loading
- Interface: EventStream, JSONL, RPC, SDK

### Step 4: Do a small experiment

Each chapter must have an action that can be run or verified: use JSON to read an event once, write a minimal loop, derive context from the session tree once, write a tool, configure a model, write an extension, run an interface once, and modify a test. 

### Step 5: Talk back

Close the document and spend 3–5 minutes explaining to the "self three months from now." Parts that can't be explained clearly are the ones to go back and cover in the next round. 

**The enemy of learning isn't difficulty, but reading without verifying, memorizing only terms without building models, and following steps without asking why.** This course uses "questions → images → code → experiments → retelling" to repeatedly break down these three bad habits. 

--- 

## 4. Stage Approach: Each stage solves only one major problem

### Stage 0 · First, let the system really get running [Preparation]

**Question**: Can the source code version work fully on the local machine? 
**What you need to get**: Able to run interactive and non-interactive modes; Know the version, model data, and basic catalog. 
**Output**: One successful `-p` task, one successful interactive dialogue. 
**Why do it first**: Without real actions, all subsequent concepts become just theoretical talk. 

### Stage 1 · System Map: How a Request Passes Through Pi [Core]

**Question** What layers does: Pi have? Who gives input to whom? How do events return? 
**What you need to get**: Explain the "interface → AgentSession → loops → models/tools → session ledger in one graph." 
**Output**: Package dependency diagram + request sequence diagram + a JSON event observation record. 
**Key Differences**: `agent` is a loop engine, `coding-agent` is a complete product; `AgentSession` manages runtime, `SessionManager` manages the ledger. 

### Stage 2 · Cycle: How Agents Move from One Answer to Multiple Rounds of Action [Core]

**Question**: Where is the boundary of turn? Why does it automatically continue when there is a tool result? How do you handle interruptions and stops midway? 
**What you need to get**: Draw a loop state machine containing steer, follow-up, and abort; Write a minimal agent loop. 
**Output**: State machine diagrams + minimal loop code + two event trajectories to correspond. 
**Core Understanding**: Model requests are stateless; The tool result must return to context as a new message for the loop to have the "next step." 

### Stage 3 · Context: What exactly does the model see each time [Core]

**Question**: How to store conversations in a tree? What is the relationship between compression, projection, and model messages? 
**What you need to get**: Derive the context of the next request from a conversation tree and explain why the original text is compressed rather than deleted. 
**Output**: A derivation exercise for "Conversation Tree → Active Branch → Compression → Projection → Model Messages." 
**Key Differences**: Session trees store facts, compress a summary of records, and projection is a visual history temporarily generated for each request. 

### Stage 4 · Tools: How Models Affect the Real World [Core]

**Question**: How do tools expose, verify, execute, and backfill? How can a single tool call prevent the workspace from being destroyed? 
**What you need to get**: Clearly explain the tool lifecycle; Understand the division of labor between parameter validation, execution, output truncation, result backfilling, and human observability. 
**Outputs**: One customizable tool + a tool risk checklist. 
**Core Understanding**: Tools are the Agent's hands and feet, and also the biggest risk boundary; Errors should be backfillable results, not just conversation crashes. 

### Stage 5 · Model Integration: How to Turn Different Vendors into a Single Interface [Advanced]

**Question**: Who absorbs the protocol differences among OpenAI, Anthropic, and Google? Where do model capabilities, pricing, and credentials come from? 
**What you need to get**: Clearly define the provider → model directory → authentication → unify the relationship between streaming events; Be able to configure a custom model or provider. 
**Output**: One "Vendor Event → Unified Event" comparison table + one custom provider configuration. 
**Core Understanding**: Protocols do not equal vendors; Many vendors can reuse the same API protocol, so loops should not know vendor details. 

### Stage 6 · Expansion: How abilities can grow without changing the core [Advanced]

**Question**: At which layer do tools, commands, renderers, skills, MCP, and codemode each expand? When should you go to the core, and when should you expand? 
**What you need to get**: Able to select extension points as needed; Understand skill loading on demand, MCP external tools, and the positioning of codemode sandboxes. 
**Output**: An extension or skill, and explain why it shouldn't directly modify the core. 
**Core Understanding**: Core stability, capabilities growing outward; Expansion is not an "additional feature," but part of the product architecture. 

### Stage 7 · Interface: How the Same Engine Serves People, Scripts, and Programs [Advanced]

**Question**: What are the differences between TUI, print, JSON, RPC, and SDK? When should you use which one? 
**What you need to get**: Be able to select based on "human view, script takes results, program sees process, program bidirectional control, and process embedding." 
**Output**: One JSON event handling script + one SDK or RPC minimal client. 
**Core Understanding**: The engine does not depend on the interface; All forms share the same set of sessions and events, only the input and output methods differ. 

### Stage 8 · Engineering: How to Make Changes Trustworthy and Sustainable [Core]

**Question**: How can an Agent project be tested, inspected, and released to ensure changes do not break existing behavior? 
**What you need to get**: Understanding faux providers, test isolation, `npm run check` levels, and release boundaries. 
**Output**: A single specification change with testing, or a reproducible validation record. 
**Core Understanding**: The Agent's output is uncertain, but the engineering system must be determined; Testing should replace the model with a controllable dummy implementation. 

### Stage 9 · Comprehensive Rebuild: Assemble the Seven Pieces into Your Own Agent [Practical]

**Question**: If you design an Agent from scratch, how would you combine loops, context, tools, models, interfaces, and engineering? 
**What You Want to Get**: No longer relying on Pi's filenames, able to independently draw your own designs and interpret trade-offs. 
**Output**: One mini agent + one design specification + one reproducible end-to-end request tracking. 
**Core Insights**: True mastery is not about "understanding Pi," but about being able to transfer the same structure to another project. 

--- 

## 5. Recommended Rhythm and Route

The full route is recommended for 6–8 weeks, with 8–10 hours per week. Time is an estimate, not a measure; Being able to explain and verify is more important than rushing progress. 

| Weekly | Main Line | Stage |
| --- | --- | --- |
| Week 1 | Run → System Map → Loop | 0, 1, 2 |
| Week 2 | Loop Wrap → Context | 2, 3 |
| Week 3 | Tools | 4 |
| Week 4 | Model Integration → Extension | 5, 6 |
| Week 5 | Interfaces and Integration | 7 |
| Weeks 5–6 (Intermitted) | Engineering | 8 |
| Weeks 6–8 | Comprehensive Practical Practice and Graduation Acceptance | 9 |

### Three Ways to Walk

- **Minimum Route**: 0 → 1 → 2 → 3 → 4 → 8 → 9. First, gain the ability to independently write the minimum Agent. 
- **Complete Route**: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Suitable for those who want to systematically master platform-based capabilities. 
- **Productive Route**: Strengthen 4, 6, and 8 on top of the complete route, and read the telemetry, durable, and env sections in the elective area. 

If time is limited, don't skip the "understanding + small experiments" in stages 1–4; You can temporarily skip digging deep into the TUI internals, chords, and durables. 

--- 

## 6. Final Capstone Project: Be a Mini Agent

The core of Stage 9 is not to do a few scattered problems, but to reassemble the previous knowledge. The minimum requirements are as follows: 

- [ ] A loop: supports model response, tool calls, tool results return to context, natural stops, and abortions; 
- [ ] A session record: can save at least messages, tool results, and one compressed summary; Able to explain tree/branch/activity paths; 
- [ ] Once-in-context projection: Generates model messages from active paths, retains the original text after compression; 
- [ ] Two tools: one read-only tool, one that may cause side effects, and a check sum and risk description; 
- [ ] One model adaptation: at least one provider is integrated to handle streaming text and errors; 
- [ ] An interface: CLI or JSON event output, at least allowing external observation of the execution process; 
- [ ] A trace record: exports a complete sequence of events for a request, explaining the message, tool, and reason for stopping; 
- [ ] A set of tests: using a sham model to test loops, tools, and error paths; 
- [ ] A design note: Draw seven structural blocks and explain three key trade-offs. 

If you can complete this design without looking at the Pi source code and explain why each component exists, the goal of this course is achieved. 

--- 

## 7. Core Terms Cheat Sheet

| Terminology | One-sentence explanation |
| --- | --- |
| Agent | A program where the model repeatedly makes decisions, calls tools, and maintains context
| Run | A full execution segment from a single input until the system confirms it does not work automatically
| Turn | A model response and the required tool execution are a round of |
| Session | A persistent record of a sustainable conversation is essentially an entry tree |
| Entry | A record in a session file has `id` and `parentId` |
| Branch | A continuous path from the root node to a leaf; A session can have multiple | entries
| Leaf | At the end of the current activity branch, decide where to continue next |
| Projection | Dialogue history calculated from activity branches, visible to the model |
| Compaction | Summarizing old history into a summary and appending it to the tree |
| Context | This request is to send the full content of the model |
| Tool call | Model requests execute a tool and its parameters |
| Provider | Implementation of integration for a model vendor or a certain model service |
| Extension | Modules that register tools, commands, hooks, rendering, and other capabilities within the process
| Event | Status notifications during execution, such as incremental text, tool start/end, message placement |

--- 

## 8. Document Map

| Document | Function |
| --- | --- |
| [Introduction and Overall Architecture](../) | Overview of the first reading: seven blocks, layering, requesting journeys, design trade-offs |
| [Stage 0](../stage-0/) | Environment Setup and Two Basic Uses |
| [Stage 1](../stage-1/) | Package dependencies, entity words, and requests throughout the entire lifecycle |
| [Stage 2](../stage-2/) | Loop, turn, steering / follow-up / abort, minimum loop |
| [Stage 3](../stage-3/) | Session tree, projection, compression, system prompts, branch |
| [Stage 4](../stage-4/) | Tool lifecycle, security, truncation, backfill, custom tool |
| [Stage 5](../stage-5/) | Model access, provider, credentials, model directory |
| [Stage 6](../stage-6/) | Extensions, skills, MCP, codemode, packaging |
| [Stage 7](../stage-7/) | TUI, print, JSON, RPC, SDK, and integration |
| [Stage 8](../stage-8/) | Testing, inspecting pipelines, building, and releasing |
| [Stage 9](../stage-9/) | Complete mini agent, testing, design specifications, and graduation acceptance |
| [Elective Section](../electives/) | On-demand entry for Telemetry, Durable, Env, Chord, and Evals |

**Usage Order**: Read the overview twice → Current stage checklist → Detailed explanation of the stage → Experiment → Return to the master diagram to rewrite. Do not read all source code in the document directory order. 

--- 

## 9. Environment and Common Commands

The source directory is fixed at `$PI_SRC`. In PowerShell:

```powershell
cd $PI_SRC
npm install --ignore-scripts
npm run hydrate:model-data
.\pi-test.ps1 --version
.\pi-test.ps1 -p "Summarize the directory structure of this repository"
.\pi-test.ps1
```

When observing the stream of events:

```powershell
.\pi-test.ps1 --mode json "Read the first 20 lines of package.json"
```

When JSONL events are needed, prioritize redirecting them to a file and then parsing line by line; do not use ordinary text logs to pollute the stdout event stream.

---

## 10. Learning Progress Table

- [ ] Stage 0: Able to run in two forms, know the learning zone version
- [ ] Stage 1: Able to draw system diagrams and request sequence diagrams off the cuff
- [ ] Stage 2: Able to write the minimal loop and explain the three ports
- [ ] Stage 3: Able to derive a model context once from the session tree
- [ ] Stage 4: Able to write and validate a custom tool
- [ ] Stage 5: Able to configure a model adapter and explain unified events
- [ ] Stage 6: Able to write an extension or skill and explain its boundaries
- [ ] Stage 7: Able to select and run one form of external integration
- [ ] Stage 8: Able to complete a specification change with tests
- [ ] Stage 9: Able to independently design and explain a mini agent

---

*Rewritten based on Pi v1.3.0 (`71023aec`, 2026-10-15) · Learning zone path has been adjusted according to the current directory*
