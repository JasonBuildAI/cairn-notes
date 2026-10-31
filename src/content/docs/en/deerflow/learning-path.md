---
title: "DeerFlow Source Code Course · Introduction"
description: "The reading order, stage map, recommended pace, and completion standards for the ten source code stages."
---

> Baseline: `deer-flow-2.1`, tag `v2.1.0`, commit `345f08be00c8a9495079b732a39b46aa9af1584e`
> Path relative to `$DEERFLOW_SRC`.
> Already `00`~`03` are overviews; this volume is an in-depth source code course, unpacked layer by layer according to stages 0~9.

## Why have staged volumes

Overview answers "what the system is composed of," while staged volumes answer "how the code proceeds next, who owns the facts, and where to recover after failure." The two are not substitutes:

| Reading | Suitable problem to solve |
| --- | --- |
| `overview.md` | First time knowing the directories, objects, and boundaries |
| `run-lifecycle.md` | First get an intuition of the complete lifecycle |
| `core-mechanisms.md`, `engineering.md` | Fill in context, tools, models, and engineering by topic |
| Stages 0–9 of this volume | Build verifiable causal relationships along the main source code chain step by step |

## One major thread running through the whole volume

~~~text
Stage 0: Understanding the Directory, Configuration, and Trust Boundaries
  ↓
Stage 1  HTTP ingress → pending → running → terminal
  ↓
Stage 2 Assembly LangGraph: Model + Tool + Middleware
  ↓
Stage 3  Decide what the model sees in this round
  ↓
Stage 4: Decide what the model can do and where to do it
  ↓
Stage 5: Decide which model to call, and which set of credentials and reasoning parameters to use
  ↓
Stage 6: Record, Restore, Audit, and Verify Delivery
  ↓
Stage 7: Connect the same engine to multiple channels, multiple Agent, expansion and scheduling
  ↓
Stage 8: Use testing, boundaries, and troubleshooting to guard the first seven layers
  ↓
Stage 9  Complete an end-to-end transformation by yourself
~~~

One Sentence Main Line:

**`start_run → pending → try_start/running → make_lead_agent → astream → journal/checkpoint → delivery receipt → terminal`.**

## Fixed Reading Method for Each Section

For each section, try to answer four questions:

1. What fact does this step possess?
2. Who has the authority to modify this fact?
3. In case of failure, which journal, checkpoint, or receipt can prove which step was accomplished?
4. Which already occurred side effects must never be redone?

## Stage Map

| Stage | Topic | What to Know Before Entering | What You Should Be Able to Do After Completion |
| --- | --- | --- | --- |
| 0 | [Environment and Source Map](../stage-0/) | Basic Python/Node | Explain harness/app boundaries and port responsibilities |
| 1 | [Entry and Run Lifecycle](../stage-1/) | HTTP, Asynchronous Tasks | Draw pending→running→terminal |
| 2 | [Agent Assembly and LangGraph Loop](../stage-2/) | Basic Concepts of LangGraph | Describe the assembly order of middleware |
| 3 | [Context and Memory](../stage-3/) | Tokens and Message Formats | Distinguish between prompt, checkpoint, memory |
| 4 | [Tools and Sandbox](../stage-4/) | Tool Invocation Protocol | Track a tool execution to the isolated environment |
| 5 | [Model Access and Provider Adaptation](../stage-5/) | Provider API | Explain whitelist, inference levels, and adapter |
| 6 | [Persistence and Recovery](../stage-6/) | State Machines, Transactions | Determine which step to complete from the journal |
| 7 | [Extension Channels and Multi-Agent](../stage-7/) | Plugins/Message Channels | Reuse the same Run entry port to extend ingress |
| 8 | [Engineering and Troubleshooting](../stage-8/) | Testing, Logging | Use tests and evidence to locate the layer of failure |
| 9 | [Capstone Project](../stage-9/) | Previous nine stages | Complete an auditable source code modification |

## Suggested Pace

- **First Pass**: Only read the "Source Code Main Line" and "Observable Chains" to establish causality.
- **Second Pass**: Perform experiments for each section, observe at least one state, one event, or one failure branch.
- **Third Pass**: Answer self-test questions and verify with source code coordinates instead of memorizing conclusions.
- After completing each stage, note on paper: "The fact source for this step is ____, the recovery point on failure is ____." 

## Completion Criteria for the Entire Course

You should be able to independently explain without looking at the overview:

- Why `start_run()` is the only entry port and why `try_start()` requires another state transition;
- Which items in Agent assembly are "configuration" and which can only be injected by the server;
- The differences among context, checkpoint, journal, and memory as four types of "memory";
- Why tools must pass through middleware and sandbox instead of calling the host shell directly;
- Which layer handles run interruption, lease loss, delivery failure, and process restart;
- Why channels, scheduled tasks, and sub-agents share the same Run semantics.

> Do not rush to read every branch of the worker at Stage 0. First, establish a coordinate system of "who owns the facts."
