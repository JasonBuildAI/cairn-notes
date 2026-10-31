---
title: "Elective Area: In-depth as Needed"
description: "On-demand in-depth expansion routes: multiple models, remote sessions, plugins, and more complex integrations."
---

> Elective section corresponding to [Learning Path](../learning-path/) (as needed). This document is a supplementary guide and does not replace the judgment criteria in the checklist.  
> Prerequisite: Best results are achieved after completing stages 0–9; it can also be used as a dictionary—jump to the corresponding subsection when learning the related module.  
> Source code directory: `$PI_SRC`. All paths in the text are relative to this directory.  

## Why there is an elective section

After finishing the seven main blocks (Loop / Context / Tools / Models / Extensions / Interface / Engineering), you can already read, modify, and expand; the elective section consists of five "scale-up" cards, with the common point being: **they are not necessary to build an Agent, but are needed when turning an Agent into a platform/product.**

| Topic | In one sentence | What problem it solves | Interface with main path | When it's worth diving deep |
| --- | --- | --- | --- | --- |
| telemetry | Telemetry contract | Makes loops, tool, and model calls observable (time cost, causality, metrics) without tying to any monitoring backend | Stage 2 loops, Stage 7 event stream | When integrating Pi into a company monitoring system |
| durable | Persistent runtime | Resumes from breakpoints after a process crash, instead of rerunning the whole cycle | Stage 2 loop recovery, Stage 3 session persistence | When doing long tasks / background agents |
| env | Remote execution environment | Tools execute on another machine (via SSH), with storage and credentials remaining local | Stage 4 tool execution gate | When local machine cannot run it or isolation is required |
| chord | Plugin host | Cross-process objects, hot reload, and authority separation by principal | Stage 6 extension host, Stage 3 state reconstruction | When building IDE-level / multi-end collaborative applications |
| evals | Evaluation framework | Answers "Does the documentation/change improve the agent?" via controlled experiments | Stage 8 testing philosophy | When wanting to quantify product quality |

Judgment criteria (following the checklist): First see whether the target position or project requires it, then decide on investment; if not needed, just remember "what it is   entry point"—this document serves this purpose. If you decide to study it, the recommended order of investment is:

```
From shallow to deep (time invested):
telemetry ── evals ── env ── durable ── chord
 Contract Observation     Behavior Verification    Execution Location    Crash Recovery    Host Model
```

The first three pieces only add 'Observation and Verification' and are untouched during operation; durable and chord are the foundation during operation, placed later. 

## How to pronounce 'five yuan'

### 1 · Telemetry—Read it first (30–60 minutes)

**What is it**: a set of telemetry interfaces not bound to the monitoring vendor (`TelemetryContext` / `TelemetrySpan`, callback API), plus event data structures, serializable schemas, and derivation types. The only built-in values are `NOOP_TELEMETRY_CONTEXT` (the default value that does nothing) and `InMemoryTelemetryContext` (reference implementation). **Does not include** exporters, global span states, and does not rely on any backend—connecting OpenTelemetry, Sentry, or its own logs, with the application writing its own adapter. 

**Why Design It This Way**: The library author doesn't choose backend for you, nor does 'monitoring whether it connects' affect package behavior—observation points are made into explicit incoming context: no transmission means NOOP, zero cost, zero dependency. 

**Introduction and Reading**: 

- `packages/telemetry/README.md`—Read in directory order: Concepts → Core Context API → Adapter Contract → No-op → In-Memory; 
- Minimal validation (recommended, lowest cost): Replace NOOP with `InMemoryTelemetryContext`, run a Stage 2 loop once, print the span—you'll see a hierarchy of 'one model request' and 'one tool execution.' 

**Relationship with the Main Storyline**: In stage 2, the 'coordinator' is responsible for event propagation, and telemetry is a universal interface for the same thing; The mini agent in stage 9 also uses similar event observation. To further explore telemetry propagation, span links, and metrics, first master this contract. 

### 2 · Evals—half a day to one day

**What is it**:P the behavioral-level evaluation framework for the I coding agent, built on `vitest-evals`. Two types of evaluations: 

- `*.docs.eval.ts`: Document Enhancement Experiment—Run the same use case in isolated containers with no documentation (without_docs) and documentation (with_docs), reporting lift; 
- The rest `*.eval.ts`: Host review, run directly on Vitest on the local machine. 

The runner code is used in `src/`:`cli.ts` (coordinated control), `docker.ts` (builds two images, runs the isolated branch), `plan.ts` (unfolds the task), `report.ts` (pairs and calculates lift), `harness.ts` (adapter). 

**Why It's Interesting**: It turns 'Is the document actually useful?' into a measurable controlled experiment—this is the previous level of Stage 8, 'How to Write Tests': upgrading from unit behavior to system behavior. 

**Entry and Reading**: `packages/evals/README.md` Full text (not long)→ Read again `src/report.ts` to see how lift pairs and calculates. `eval:docs` Requires Docker and consumes hash power/tokens; the first time is recommended to read only and not run, or choose a single use case. 

### 3 · ENV — half a day to one day

**What is**: The remote execution environment for Pi Durable. Two parts: 

- `pi-env`(Rust,`daemon/`): A daemon deployed remotely, using the stdin/stdout frame protocol for file operations and commands (`docs/protocol.md`); 
- `RemoteExecutionEnv`: Local side client, resulting semantics aligned with local `NodeExecutionEnv` (`docs/semantics.md`), only incorrect text may differ. 

**Security details worth a glance**: The first connection requires manual verification of the host key fingerprint and writing to the known_hosts; Daemon is named SHA-256 and verifies before each startup—capabilities like "remote execution"—trust building itself is part of the design. 

**Relationship with the Main Storyline**: Among the eight checkpoints in Stage 4, there is one 'execution' stage; env turns 'where to execute' into a replaceable layer—once again proving that 'engines only recognize interfaces': change execution positions, no loops, no tool definitions. 

### 4 · durable — 1–2 days (marked as Experimental)

**What is it**: When running a persistent agent, the key design points are in one sentence: **Submit first, then display** — Dialogue, model turns, tool calls, and custom states are stored first before being visible to the public; If a process dies midway, reopening storage will continue from the breakpoint. It is built on `packages/ai` (model access) and `chord` (document state)—exactly the other two sections in the optional section. 

**Compared to Stage 2**: You've learned the loop's retries and recovery boundaries; durable is the extreme form of this line—not 'retrying the current request,' but 'continuing unfinished rounds after reboot.' 

**Entry and Reading**: `packages/durable/README.md` (Quick Start → Concepts → Persist and Resume) → `packages/durable/docs/spec.md` as a reference manual. Note the Experimental declaration at the beginning of the README: the API changes without notice; The source directory is fixed to v1.3.0, and the snapshot is read. 

### 5 · CHOR — 1–2 days (the deepest section in the elective area)

**What is**: Splitting an application into "objects" and running it across processes (server, worker, browser tabs), supporting hot reloading. Five concepts:

- **Object**: State + code at an address, created as needed, persists if referenced;
- **Reference**: What you get is a reference, not the object itself; works across processes and hot reloads;
- **Principal**: Each object knows its owner—owner and guest see different objects and different methods;
- **State**: Observable JSON, remote viewers first receive a snapshot, then deltas;
- **Hot Reload**: The running task completes old code, state is preserved, incompatible changes migrate at safe points.

Contracts are TypeBox schemas at runtime, and hosts communicate using JSON frames (memory / Node IPC / WebSocket).

**Why it's worth reading last**: It pushes stage 6 "extending the host" to the infrastructure level—hot reload, cross-process, decentralization; the idea from stage 3 of "rebuilding state from records" becomes a general snapshot + incremental replication mechanism here.

**Entry points and reading order**: `packages/chord/docs/tutorial.md` → `guide.md` → `spec.md`; use the README's Entry points table as an index.

## Caching and Diagnostics (production toolbox)

Even if not working on a platform, you should know these names—they are ready handles for two types of issues: "cost" and "stability":

| Tool | Location (v1.3.0) | What it does | When to recall it |
| --- | --- | --- | --- |
| cache warmer | `packages/coding-agent/src/core/cache-warmer.ts` | Keeps the prompt cache warm, reducing cost from cache misses; controlled by `cacheWarming` (off / streaming / idle, idle also warms between tasks) | Long sessions, repeatedly running the same project, cost-conscious situations |
| cache stats | `packages/coding-agent/src/core/cache-stats.ts` | Statistics and display of cache hits/misses; `showCacheMissNotices` controls whether to notify on misses | When you want to know "why this run was expensive" |
| crash log | `packages/coding-agent/src/core/crash-log.ts` | Records crashes (`recordCrash`), supports matching crash stack fragments with installed extensions (to locate suspicious extensions); interactive startup will alert about unhandled previous crashes | When a session terminates unexpectedly |
| diagnostics | `packages/coding-agent/src/core/diagnostics.ts` | Defines types for resource conflicts and diagnostics (`ResourceDiagnostic` / `ResourceCollision`)—used to report when resources with the same name come from different sources | When skills/commands/templates seem to overwrite each other |
| settings diagnostics | `packages/coding-agent/src/core/settings-diagnostics.ts` | Summarizes and deduplicates configuration-level issues (`collectSettingsDiagnostics` / `deduplicateDiagnostics`) | When suspecting misconfigured or ignored settings |

These are not "stages" and do not need to be scheduled; refer back to this table when encountering the corresponding symptoms.

## Self-check for completion (elective section)

- [ ] Can explain what problems each of the five blocks solves and which mainline stage they connect to;
- [ ] Choose at least one block to perform a "minimal verification" (telemetry or evals recommended, lowest cost);
- [ ] For blocks not chosen, can say in one sentence "why not studying it now".

## Quick FAQ

| Question | Answer |
| --- | --- |
| Are these five blocks difficult? | The entry points are all in each package's README, very straightforward; if you don't understand, just remember "what it is + entry", not a failure. |
| Will they change what I've learned? | No, they amplify: telemetry/evals just add observation and verification; env/durable changes "where it runs, how to recover"; chord goes deepest, altering the host model. |
| Must I finish all of them first? | No. The checklist's criterion is "see if it's needed first"; the order in this file is for sorting if you decide to study. |
| What if the version changes? | Use learning area v1.3.0 snapshot as the reference; durable is Experimental, check each package's CHANGELOG when upgrading. |

## After completion

- Return to the [learning path](../learning-path/) elective section and mark your checklist according to the criteria (study / defer).
- At this point, the full set of materials is complete: **Checklist (outline) → Architecture overview (panorama) → Stages 0–9 (layered close reading) → This guide (read deeply as needed)**. Subsequent learning follows stage 9: read source → do experiments → reread documentation → implement again.

---

*Accompanied by [learning path](../learning-path/) elective section · 2026-10-19 · Based on v1.3.0 (`71023aec`)*
