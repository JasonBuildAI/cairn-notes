---
title: "Hermes Agent Source Code Course · Introduction"
description: "The reading order, stage map, recommended pace, and completion standards for the ten source code stages."
---

> Baseline: Archive release `hermes-agent-0.22.5`, release version `v0.22.5`.
> The archive does not include `.git`, so this volume does not claim commit/tag; `version = "0.0.0"` in `pyproject.toml` is a build placeholder, not a release version.
> Paths are relative to `$HERMES_SRC`.
> Already have `00`~`03` as an overview; this volume dives into the real source code in stages 0~9.

## Why There Are Stage Volumes

The overview answers 'What layers does Hermes have,' while the stage volumes answer 'Where is the next statement, who owns the fact, and who takes over after a failure.' After reading the overview, you should already have the rough line below; the stage lessons are responsible for breaking each section into verifiable source code causality.

~~~text
Entry Submission
  → admission (long waiting in line)
  → durable turn lease (authorization for single writer)
  → turn context / system prompt
  → preflight compressed dam
  → Model Request / Streaming Response
  Tool round (persist first, then execute)
  → finalize / transcript
  → delivery / event replay
~~~

One-sentence main storyline:

**`submit → admission → lease → context → preflight → API/tool loop → finalize → delivery`.**

## Two Types of 'Overview', What to Read for Each

| Material | Suitable Answers |
| --- | --- |
| `overview.md` | Product positioning, process topology, catalog and terminology |
| `turn-lifecycle.md` | First gain an intuition of the complete lifecycle |
| `core-mechanisms.md` | Complete according to themes such as context, tools, models, persistence, etc. |
| `engineering.md` | Troubleshooting, recipe modification, failure matrix |
| Volume stages 0–9 | Establish ownership, state transitions, and recovery causality along the source code segment by segment |

## Fixed Follow-up Question for Each Article

1. What fact does this step hold?
2. Who is qualified to change this fact?
3. After failure, which persistence, event, or result field can prove which step was achieved?
4. Which side effects have already occurred and must never happen again due to a 'retry'?

## Stage Map

| Stage | Topic | Should be able to explain after completion |
| --- | --- | --- |
| 0 | [Environment and Source Code Map](../stage-0/) | Three hosts, four boundaries, core directories |
| 1 | [Frontend Admission and Lease](../stage-1/) | How input becomes a single writer's durable turn |
| 2 | [ConversationLoop](../stage-2/) | How a loop advances and exits |
| 3 | [Prompt, Context, and Compression](../stage-3/) | What the model actually sees, what compression changes |
| 4 | [Tools and PersistBeforeExecute](../stage-4/) | The persistence boundaries and side effects of tool invocation |
| 5 | [Provider, Credentials, and Fallback](../stage-5/) | Why changing the model requires rebuilding the context |
| 6 | [SessionDB and Recovery](../stage-6/) | transcript, schema, locks, and restart recovery |
| 7 | [Extended Platforms and Multi-Agent](../stage-7/) | Which layer is extended by plugin, cron, delegate, and channels |
| 8 | [Engineering Testing and Troubleshooting](../stage-8/) | Locate Fault Layers with Evidence |
| 9 | [Capstone Project](../stage-9/) | Complete a recoverable and auditable modification |

## Suggested Rhythm

- **The first time, only read the 'source code mainline' and 'observable links'**, do not memorize the fields.
- **Perform the experiment a second time**, observing at least one admission state, one prompt byte difference, or one failure branch.
- **Answer the self-test questions for the third time**, then go back to the source code to check, instead of only looking at the literal answers.
- Each time you complete one, add a sentence on the paper: 'The source of the fact is ____; the failed takeovers are ____; the irreversible side effects are ____.'

## Complete Volume Completion Standards

You should be able to independently explain without looking at the overview:

- Why does the classic CLI only submit and replay events, and on which host is the actual turn executed?
- `queued / started / unknown / terminal` The relationship with lease TTL, refresh, and loss;
- Why must a tool's call be persisted first before producing side effects;
- Why must the provider fallback return to preflight, instead of switching clients on the spot;
- Why compression protects the head and tail, keeps the middle summary, and may rotate the child session;
- What `SessionDB`'s transcript, admission, lease, and compression lock each prove;
- How the same Agent core can be reused by CLI, TUI, messaging platforms, cron, and sub-Agents.

> Starting from stage 0, first distinguish the four terms 'Entry/Host/Agent/Ledger'; all subsequent code will fall into one of these layers.
