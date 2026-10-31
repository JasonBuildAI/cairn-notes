---
title: "OpenSandbox 1.1.1 Learning Zone"
description: "Follow the lifecycle of a sandbox task to understand the control plane, runtime, execution layer, and evidence chain."
---

:::note[Independent Study Notes]
These are independent study notes based on the source code and public documentation of [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox) `release-1.1.1` (commit `531700ca`), not official documentation. This site does not include upstream source code; `$OSB_SRC` refers to your own local source code directory below.
:::

> This course teaches only one thing: **a single sandbox task, from intent to evidence, who is involved in the middle.**
> The goal is not to memorize the API, but to build a set of judgment skills — when you see the word "support," first ask: in which runtime, what configuration, what version, at what cost.

## Versions and Sources

| Item | Content |
| --- | --- |
| Textbook Target | OpenSandbox official stable version |
| Version Tag | `release-1.1.1` |
| Commit | `531700ca18a7fa5fab6a2f25d6dc68a76eddab12` |
| Release Date | 2026-10-09 |
| Source Code Access | [Official release](https://github.com/opensandbox-group/OpenSandbox/releases/tag/release-1.1.1), please check out by yourself; this site does not distribute source code |
| Official Repository | <https://github.com/opensandbox-group/OpenSandbox> |
| Official Release Page | <https://github.com/opensandbox-group/OpenSandbox/releases/tag/release-1.1.1> |

These notes are cross-checked with the official `release-1.1.1` source code and public documentation. The public repository only contains study notes, not upstream source code, the `.git` directory, or local backups.

## Problems this course aims to solve

For an AI application to make the model "actually do things," at least four questions need to be answered:

```text
1. Where should the code run so that it doesn't harm the host machine?
2. After running, how are commands, files, and outputs reliably collected?
3. How does it connect to the network and obtain credentials without sending out data or keys?
4. When the model decides the next step by itself, who ensures that it doesn't go out of control, costs are manageable, and actions can be traced afterward?
```

OpenSandbox answers these four questions with a layered design. This course follows the **lifecycle of a single sandbox task**, breaking down, running through, and then recombining this design.

## A Main Thread

```text
Create Intent
  -> Control plane handling (authentication, TTL, status)
    -> Runtime deployment (container / Pod / micro virtual machine)
      -> Endpoint resolution (the address is not guessed)
        -> Execute (execd: command, file, stream)
          -> Network and Credentials (Let the connections pass, let the disconnections disconnect)
            -> Evidence feedback (exit code, stderr, output)
              -> TTL / Pause / Destroy
```

At each stage, only answer one fork on this chain. The stages are not a 'stacking of knowledge points,' but **an unfolding of the same task at different levels**.

## How to Learn: Five-Step Cycle

Each chapter follows the same cycle, without skipping steps:

```text
1. Question: If I were the designer, how would I solve it?
2. Draw a diagram: depict the inputs, outputs, and failure points of this layer
3. Code Reading: Only read files that can answer questions, without reading aimlessly.
4. Experiment: Run a minimal verification and record both successful and failed outcomes
5. Retell: Recite without looking at the materials, and state two boundaries
```

The standard for 'having learned' is not 'being able to run through it', but: **being able to explain why it is designed this way and being able to point out under what conditions it fails.**

## Stage Map

| Stage | Solve Only One Major Problem | Output | Type |
| --- | --- | --- | --- |
| [Stage 0](stage-0/) | Can the smallest closed loop really run? | One successful script   One failed record | Preparation |
| [Stage 1](stage-1/) | How does a mission pass through the platform? | Architecture Diagram   Create/Execute Sequence Diagram   Failure Point List | Core |
| [Stage 2](stage-2/) | Environment from creation to destruction, who is responsible? | Encapsulation that can clean up on success/exception/cancellation | Core |
| [Stage 3](stage-3/) | How do commands, documents, and code become verifiable actions? | Tool layer with timeout, truncation, and structured returns | Core |
| [Stage 4](stage-4/) | How does the same contract end up on Docker/K8s/FastSandbox? | Runtime Capability Matrix   Decision Tree Selection | Advanced |
| [Stage 5](stage-5/) | How to allow what should be allowed, block what should be blocked, and prevent keys from being taken? | One-page network strategy design   Allow/Deny verification | Advanced |
| [Stage 6](stage-6/) | What is the relationship between SDK, CLI, MCP, and contracts? | Entry selection table   Contract change sequence | Advanced |
| [Stage 7](stage-7/) | After giving the sandbox to the model, how to avoid losing control? | Tool contracts   Budget   Minimal Agent Loop | Core of AI Applications |
| [Stage 8](stage-8/) | How dare we go online? | Production Readiness Review   Fault Stratification Process | Core |
| [Stage 9](stage-9/) | Can you independently deliver a complete system? | Data Analysis and Reporting Agent Evidence Package | Practical |

Two supporting articles:

- [Introduction and Overall Architecture](architecture/): First establish the overall diagram, then proceed to Stage 0.
- [Learning Checklist](learning-path/): 8-week rhythm, four types of walks, milestones, and glossary.

Horizontal Expansion Reading [Elective Area Guide](electives/): Code Interpreter, Browser/Desktop, Storage Mounting, K8s/FastSandbox, Agent Framework and Coding CLI, Evaluation.

## Eight Components

No matter how the directory changes, any AI execution platform must answer these eight questions:

| Component | Question to Answer | Corresponding in OpenSandbox | Stage |
| --- | --- | --- | --- |
| Entry | How do people and programs use the platform? | Python/JS/Go/Kotlin/C# SDK, `osb` CLI, MCP | 6 |
| Contract | Why is the client not locked by a certain backend? | OpenAPI under `specs/` | 1, 6 |
| Lifecycle | When is the environment created, expired, and destroyed? | `server/` Control Plane | 2 |
| Runtime | Does the environment run in a container, Pod, or micro-VM? | Docker, Kubernetes, FastSandbox | 4 |
| Execution | How does the model action really happen? | `components/execd/` | 3 |
| Network | How does traffic enter, exit, and get restricted? | endpoint, ingress, egress | 5 |
| Security | How are untrusted code and keys constrained? | Isolated runtime, resource limits, network policies, Vault, tenants | 4, 5, 8 |
| Engineering | How to prove reliability, observability, and evolvability? | Testing, diagnostics, metrics, release validation | 8 |

Put it in one sentence: **Initiated at the entry, constrained by contracts, arranged by the control plane, implemented at runtime, executed by the data plane, governed by the network plane, backed by the security plane, and verified by the engineering plane.**

## Three Vertical Lines

These three lines appear repeatedly in every chapter, don't treat them as 'appendices':

| Vertical Line | Question | Typical Points |
| --- | --- | --- |
| Evidence stream | Why is this conclusion credible? | exit_code, stderr, files, conditions, logs, trace |
| Trust Boundaries | Who is untrustworthy? Where are the keys? | Sandbox content, egress, Credential Vault, tenant isolation |
| Capability Requirements | What prerequisites does 'support' need? | runtime, configuration, version, image, Pool/template constraints |

## Recommended Rhythm

| Week | Content | What should be deliverable by the weekend |
| --- | --- | --- |
| Week 1 | Stage 0–1 | Can run through; can draw the end-to-end link |
| Week 2 | Stage 2 | A lifecycle encapsulation that can be cleaned up by all three paths |
| Week 3 | Stage 3 | A secure command/file tool layer |
| Week 4 | Stage 4 | A runtime capability matrix and selection rationale |
| Week 5 | Stage 5 | One-Page Default Denial Network and Credential Design |
| Week 6 | Stages 6–7 | Entrance Selection   A Controlled Minimal Agent |
| Week 7 | Stage 8 | Production Readiness Review and Failure Drill Records |
| Week 8 | Stage 9 | Capstone Project   Evidence Package   Review |

If time is tight, you can follow the 'shortest closed loop' (0→1→2→3→9); for the platform direction, you can also study 4, 5, 8; for the Agent direction, you can also study 5, 6, 7.

## Document Map

| File | Questions Answered |
| --- | --- |
| [Overall Architecture](architecture/) | What is OpenSandbox? Layers, mainline, seven design trade-offs |
| [Learning Path](learning-path/) | How to learn in 8 weeks? What is produced at each stage? How to know you have learned it? |
| [Stage 0](stage-0/) | How to run the source code version, Docker, server, and the first sandbox? |
| [Stage 1](stage-1/) | System map: How does a single task traverse the control plane, runtime, and data plane? |
| [Stage 2](stage-2/) | Lifecycle, TTL, pause and resume, snapshot and cleanup semantics |
| [Stage 3](stage-3/) | execd: commands, sessions, files, PTY, Code Interpreter |
| [Stage 4](stage-4/) | Runtime: Docker/K8s/FastSandbox, Pool, templates, isolation levels |
| [Stage 5](stage-5/) | Network and credentials: endpoints, ingress, egress, Vault |
| [Stage 6](stage-6/) | Contracts, five types of SDKs, CLI, MCP, and change ordering |
| [Stage 7](stage-7/) | Agent integration: topology, tools, budgeting, injection, observability |
| [Stage 8](stage-8/) | Engineering and production: multi-tenancy, testing, metrics, release, rollback |
| [Stage 9](stage-9/) | Graduation project: data analysis and reporting Agent |
| [Electives](electives/) | On-demand deep dive paths outside the mainline |

## Content Structure

```text
Cairn Notes · OpenSandbox Study Area
Overview and Phase Map
Core Ten Stages 0–9
Elective Area
```

## Environment Reminder

- Stages 0–3 require an available Docker daemon; on Windows, use Docker Desktop with Linux containers (depends on WSL2).
- The server and examples primarily use Python 3.10; other language SDKs require corresponding toolchains.
- Kubernetes, FastSandbox, Pool, Snapshots, and Credential Vault all have backend and configuration prerequisites; the presence of an interface should not be taken as "the environment is available." 
- **When the author wrote these notes, Helm was not installed and the Docker daemon was not running**, so experiments involving Kubernetes deployment, Pool, Snapshots, etc., were not actually performed; the text has been annotated with "requires cluster / unverified" where appropriate. When reading, differentiate between "command exists" and "verified on this machine."
- The material is cross-checked against version 1.1.1 source code and official documentation; actual execution depends on your current configuration and backend capabilities.

## Learning Agreement

Finishing reading does not equal mastery. At the end of each stage, you should at least be able to:

- Explain without reference materials what problem this module solves and its boundaries.
- Draw a sequence diagram of a single call and identify points of failure.
- Write a minimal runnable example or provide justified pseudocode.
- State two common misuses and their consequences.
- Honestly mark what you have verified and what you have not.

Ultimately, you should have four capabilities simultaneously: **productizing model abilities, engineering tool boundaries, making risk governance explicit, and making system behavior observable.** OpenSandbox is a high-quality example for training these four capabilities.

Start from [Stage 0](stage-0/).
