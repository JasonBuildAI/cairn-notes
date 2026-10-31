---
title: "Elective Area: In-depth as Needed"
description: "Code Interpreter, browser, storage mounting, K8s, and evaluation, among other extended routes."
---

> This guide is not an 'advanced must-read list,' but a **map of questions**: when you encounter scenarios not covered by the main storyline, you'll know which article to read, which prerequisite stage to fill in, and what minimal verification to perform.

## First, clarify: what counts as 'elective'

The main storyline (stages 0–9) answers 'the life of a single sandbox task.' Anything in the following three categories belongs in the elective section:

```text
1. Specific forms: code interpreter, browser, desktop, Windows sandbox
2. Specific platforms: Kubernetes/FastSandbox, AKS + Kata, node proxy
3. Specific ecosystem: Agent framework, coding CLI, evaluation tools, client pool
```

They are not 'harder,' but 'narrower.' **Without a mainline preface, reading electives directly will result in a bunch of commands, but you won't know which layer to look at when you fail.**

## How to read electives: a three-step method

```text
Step 1: Clearly write the question
        "I want to run Jupyter in the sandbox" "I want to mount an existing data disk"
        Instead of 'I want to look at this example'

Step 2: Do the smallest experiment
        Only keep the steps in the example that can prove this ability
        Delete model calls unrelated to the issue, UI, deployment

Step 3: Mark the boundaries
        Under what conditions can it be used? What form does it take when it fails? How are keys/network/cleanup handled?
```

A qualified elective note should at least include: **preconditions, minimal commands, expected results, failure modes, and points of connection with the main storyline.**

## Side Quest 1 · Execution and Interaction

| Problem to Solve | References | Preconditions | Output |
| --- | --- | --- | --- |
| Run code cells in the sandbox while retaining kernel state | `docs/examples/code-interpreter.md`, `docs/sdks/` | Stage 3 | A script capable of executing two cells consecutively and sharing variables |
| Interactive terminal needed | execd PTY interface (`/pty`) | Stage 3 | A minimal client that can create/read/write/close a PTY |
| Multi-step isolated execution | `docs/guides/isolation-sessions.md` | Stages 3, 5 | A record of "session lifecycle and cleanup" |
| Need to maintain shell state | execd `/session` | Stage 3 | Compare the behavior differences between "new command" and "same session" |

### Boundaries of Code Interpreter

It is an **independent SDK package** (Python / JavaScript / C#), not a method of `Sandbox`:

- Must wrap an existing `Sandbox`.
- The image must include a Jupyter runtime; a standard `python:3.12` is insufficient.
- The default health check verifies both execd and Jupyter; it only returns ready if both are ready.
- `.aclose()` only releases the interpreter client and **does not destroy the sandbox**.

If any of these four conditions are not met, it will appear as "created successfully but execution failed." Check the image first, then the health check, and finally the lifecycle.

### Current Status of PTY

PTY exists at the execd API layer (`POST/GET/DELETE /pty`, `/pty/{id}/ws`), but it is not in the public execd spec, and the Python SDK does not expose it. This means:

- You can call it directly via API, but need to handle the WebSocket yourself.
- Do not include it in the documentation as "SDK supported."
- Re-verify the interface shape after version upgrades.

## Side Quest 2 · Interface and Desktop

| Problem to Solve | References | Preconditions | Output |
| --- | --- | --- | --- |
| Enable Agent to operate webpages | `docs/examples/playwright.md`, `chrome.md` | Stages 3, 5 | A closed loop of "open page → screenshot → assert" |
| Need full desktop | `docs/examples/desktop.md` | Stages 3, 5 | A desktop screenshot and port exposure instructions |
| Run IDE in sandbox | `docs/examples/vscode.md` | Stages 2, 5 | An accessible IDE endpoint |
| Windows sandbox | `docs/guides/windows-sandbox.md`, `docs/examples/windows.md` | Stage 4 | A record of Windows image/runtime conditions |

### Common Challenges of This Side Quest

```text
1. Large image, slow startup -> TTL Needs to be re-estimated with ready waiting
2. Multiple ports -> Endpoint parsing cannot remember just one port
3. Heavy graphical/browser dependency -> Resource limitations prevent directly copying python:3.12
4. Inbound access is complex -> Must go through gateway/proxy, cannot assume direct connection
```

Browsers and desktop scenarios have an additional layer of security concern: **page content is untrusted input**. The injection defense in Stage 7 also applies here, and even more importantly—the browser brings external content directly into the execution environment. 

## Branch 3 · Storage and Data

| Problem to solve | Reading | Prerequisite | Output |
| --- | --- | --- | --- |
| Mount host directories | `docs/examples/host-volume-mount.md` | Stage 4 | A record of 'read/write permissions and cleanup' |
| Using PVC/object storage under Docker | `docs/examples/docker-pvc-volume-mount.md`, `docs/examples/docker-ossfs-volume-mount.md` | Stage 4 | Mount success and failure scenarios |
| Using PVC under Kubernetes | `kubernetes-pvc-volume-mount.md` | Stage 4 | Pod mounting and reclamation validation |
| Synchronization with remote storage | `rclone-volume-mount.md` | Stage 4, 5 | One-time sync and credential handling instructions |

### Three questions that must be answered

1. **Does snapshot cover it?** The answer depends on the volume type; do not infer 'snapshot contains it' from 'file still exists'.
2. **Can pool mode be used?** Pool pods are pre-created; volumes must be fixed with templates and cannot be injected per request.
3. **Who is responsible for cleanup?** Mounted data usually lasts longer than sandbox lifespan; destroying the sandbox does not equal deleting the data.

If you can't answer these three questions, do not mount in production.

## Branch 4 · Platform and Operations

| Problem to solve | Reading | Prerequisite | Output |
| --- | --- | --- | --- |
| Deploy on Kubernetes | `docs/deployment/index.md` | Stage 4 | A diagram of components/ports/namespaces |
| Reduce creation latency with FastSandbox | `docs/architecture/fast-sandbox/` | Stage 4 | Template build and creation timeline |
| Use Kata on AKS | `docs/examples/aks-kata.md` | Stage 4, 8 | RuntimeClass verification record |
| Node-side capabilities | `docs/guides/node-agent.md` | Stage 4 | Responsibilities boundary of node-agent |
| Pod supply failure recovery | `docs/guides/pod-recovery.md` | Stage 4, 8 | Recovery behavior for bad images/scheduling failures |
| Pause/resume performance | `docs/guides/kubernetes-resume-benchmark.md` | Stage 4 | A set of recovery time data |
| QEMU VMState snapshot | `docs/guides/qemu-vmstate-snapshots.md` | Stage 4 | Conditions and limitations for 'memory retention' |
| Multi-tenancy | `docs/guides/multi-tenancy.md` | Stage 8 | Tenant/namespace/quota table |
| Telemetry | `docs/guides/telemetry.md` | Stage 8 | Metrics and trace catalog |

### How to read FastSandbox

Do not start reading from the component list. First, answer three questions:

```text
1. Is the shape of my workload fixed? (Only fixed workloads are suitable for templates)
2. Is my bottleneck the creation latency, or the image size/network?
3. Can I accept the template being immutable and without a sandbox side Vault?
```

Answer "Yes/Can" to all three, then read about template construction and FastPath routing; otherwise, first optimize the image and Pool.

### Two Pitfalls of Pause and Resume

- **rootfs snapshot does not retain memory**: After recovery, the process restarts and variables are lost.
- **Recovery creates a new ID**: Do not use the old ID for polling, nor treat the old endpoint cache as valid.

## Side Branch 5 · Ecosystem and Evaluation

| Problem to Solve | What to Read | Prerequisite | Output |
| --- | --- | --- | --- |
| Use ADK to create a tool-like Agent | `docs/examples/google-adk.md` | Stage 7 | Minimal closed loop of the three tools |
| Orchestrate with LangGraph | `docs/examples/langgraph.md` | Stage 7 | Graph stopping condition |
| Use Microsoft Agent Framework | `docs/examples/microsoft-agent-framework.md` | Stage 7 | Tool registration and call record |
| Multiple Agents / Deep Tasks | `docs/examples/deep-agents.md`, `docs/examples/deer-flow.md` | Stage 7 | Task decomposition and budget |
| Sandbox the coding CLI | `docs/examples/codex-cli.md`, `docs/examples/claude-code.md`, `docs/examples/gemini-cli.md`, `docs/examples/opencode.md`, `docs/examples/qwen-code.md`, `docs/examples/kimi-cli.md`, `docs/examples/github-copilot-cli-sandbox.md` | Stage 7 | Record of keys/network/cleanup three things |
| Batch evaluation | `harbor-evaluation.md` | Stages 7, 8 | One reproducible evaluation run |
| Apply patches | `apply-patch.md` | Stages 3, 7 | Patch application and failure rollback |
| Client connection pool | `docs/examples/client-pool-schedule.md`, `docs/guides/client-pool.md` | Stages 2, 8 | Latency and cleanup data after pooling |

### Read an Agent example and always check six things

```text
1. Topology: Agent Is it outside or in the sandbox?
2. Keys: Where are the model key and data key respectively?
3. Network: Which targets does the sandbox allow access to?
4. Tools: What capabilities are exposed, and what structure is returned?
5. Budget: Are there limits on steps/time/output?
6. Cleanup: Who is responsible for destruction, and does the exceptional path cover it?
```

Out of the six questions, two can't be answered, so this example can only be used as a "demonstration" and not as a "reference implementation".

## Three Role Paths

### Application Developer

```text
Stage 0–3 → Stage 6 (SDK/CLI) → Elective 1 (Code Interpreter / Conversation)
```

Goal: Be able to embed a sandbox into an existing application and know which layer to check when it fails.

### Agent Engineer

```text
Stage 0–7 → Stage 8 (Budget/Observable) → Elective 5 (Framework and CLI)
```

Objective: Able to design tool contracts, control costs, handle injections and retries.

### Platform/Operations

```text
Stages 1, 2, 4, 5 → Stage 8 → Elective 4 (K8s/FastSandbox/Multi-tenant/Telemetry)
```

Goal: Be able to deploy, scale, troubleshoot, and roll back, and be able to explain the conditions for each capability.

## The connection between electives and the main track

```text
Main Line Stage 3 (Execution)
   ├─ Elective 1: Code Interpreter / PTY / Conversation
   └─ Elective 2: Browser / Desktop / IDE

Main Line Stage 4 (Runtime)
   Elective 3: Storage Mounting
   └─ Elective 4: K8s / FastSandbox / AKS / Snapshot

Main Stage 5 (Network and Credentials)
   └─ Elective 2, 4: Inbound Exposure, Vault Acceptance, Upstream Agent

Main Story Stage 7 (Agent)
   └─ Elective 5: Framework, Coding CLI, Evaluation

Main Story Stage 8 (Engineering)
   └─ Electives 4 and 5: Multi-tenancy, Telemetry, Connection Pool
```

## Common Misconceptions

| Misconception | Correction |
| --- | --- |
| "Electives are advanced, so they should be learned first" | Electives are narrower in scope; without mainline prerequisites, they often become mere command copying |
| "If an example runs, it means the skill is usable" | Examples usually omit quotas, cleanup, and failure paths |
| "Code Interpreter is just a Sandbox with an added method" | It's an independent package, requiring a Jupyter image and additional health checks |
| "PTY is available in the SDK" | It exists at the API layer, but the public spec/SDK may not include it; confirm before use |
| "Mounting data means its inclusion in snapshots" | Depends on the volume type; rootfs snapshots don't cover all storage |
| "Template sandboxes have the same capabilities as regular sandboxes" | Templates are immutable and don't have a sandbox-side Vault |
| "Putting the encoding CLI into a sandbox makes it safe" | Keys, outbound connections, and cleanup still need separate design |

## After Completion

The correct way to use the elective area is to **enter with a specific question and leave with a documented boundary record**.

If you have already completed your graduation project, it is recommended to continue in this order:

1. Choose a branch that is closest to your work and conduct a minimal experiment.
2. Take note of the "conditions not clearly documented" discovered during the experiment.
3. Go back to the corresponding phase in the mainline and reinterpret it using that framework.
4. If you find something valuable, organize it into an example or documentation improvement and submit it according to the community process.

At this point, you are no longer just "finishing a course"; you are capable of proposing informed improvements to the system.
