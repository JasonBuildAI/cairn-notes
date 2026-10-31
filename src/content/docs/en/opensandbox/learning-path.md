---
title: "OpenSandbox 1.1.1: Learning Path"
description: "8-week rhythm, four learning paths, outputs and passing criteria for each stage."
---

> **Course Objective**: The goal is not to memorize OpenSandbox's API or read every line of source code, but to build a complete mental model that can be transferred to any AI execution platform—understanding why untrusted code needs isolation, how environments are arranged and reclaimed, how commands are turned into verifiable evidence, and how networks and keys are constrained.
>
> **Who It's For**: Readers who know a bit of Python, can run projects from the command line, understand basic Docker concepts, but do not yet have a systematic understanding of AI execution infrastructure.
>
> **Source Code Directory**: `$OSB_SRC`, fixed at `release-1.1.1` (`531700ca`).
> **Overview**: First, read the [overall architecture](../architecture/), use this checklist as a roadmap, then read the detailed explanations in stages.

---

## 1. Establish the Big Picture First: What Exactly is OpenSandbox

In one sentence: **OpenSandbox is an infrastructure layer between AI applications and untrusted execution.** It does not perform agent orchestration for you but is responsible for executing the "actions the model wants to take" in a bounded, time-limited, and observable environment.

```text
The model decides to take an action
   │
   ▼
Application / Agent
   Management Request
   ▼
Lifecycle control plane: authentication, state machine, TTL, endpoint resolution
   │  Select Runtime
   ▼
Runtime: Docker / Kubernetes / FastSandbox
   │  Create
   ▼
Sandbox: User load + execd
   │ Execute request (bypass control plane)
   ▼
Command / File / Code / Terminal
   Exit the station
   ▼
egress sidecar → external service
```

Next to it, there is also a continuously generated **evidence stream**: states, SSE events, exit codes, logs, metrics, and audits. It determines whether you are truly successful.

### Eight Functional Blocks of an AI Execution Platform

Any AI execution platform can be broken down into eight blocks. Learning OpenSandbox is about seeing how these eight blocks interact:

| Functional Block | Question to Answer | Main Location in OpenSandbox | Corresponding Stage |
| --- | --- | --- | --- |
| Entry | Who uses the platform and how? | SDK, CLI, MCP | 6 |
| Contract | How do the client and backend decouple? | `specs/` | 1, 6 |
| Lifecycle | When are environments created, renewed, destroyed? | `server/` | 2 |
| Runtime | Where do the resources actually reside? | Docker, Kubernetes, FastSandbox | 4 |
| Execution | How do model actions occur? | `components/execd/` | 3 |
| Network | How does traffic flow in and out, and how is it restricted? | endpoint, ingress, egress | 5 |
| Security | How are untrusted code and secrets constrained? | isolated runtime, policies, Credential Vault, tenants | 4, 5, 8 |
| Engineering | How do you prove reliability, observability, and evolvability? | testing, diagnostics, metrics, release | 8 |

### Three Longitudinal Threads Across the Entire System

Beyond the eight blocks, always keep these three questions in mind:

1. **How does evidence flow?** States, SSE events, exit codes, logs, and metrics are the only basis for determining whether you have actually succeeded.
2. **Where is the trust boundary?** Users, models, tools, sandbox, host, external network—what can each control?
3. **What conditions are required for capabilities?** When seeing "supported," follow up with: which backend, what configuration, which version, which image.

---

## 2. The Whole Course Revolves Around a Single Main Line: The Life of a Sandbox Task

Each chapter that follows dissects a segment of this line:

```text
The model decides to perform an action
  Application initiates a creation request
  → Control plane authentication, verification, and runtime selection
  → Runtime-created container / Pod / Micro virtual machine
  → SDK pending status, parsing endpoint, health check
  The client directly calls execd to execute commands or operate files
  Sandbox outbound traffic goes through egress policies
  → returns to the application with SSE / file / exit code
  Renew, pause, snapshot, or destroy
  Status, logs, metrics, audit retention
```

You need to be able to answer four questions at any time: 

1. **Where did this move come from?** SDK, CLI, MCP, or the Agent framework? 
2. **Where is the environment?** Which runtime, which backend, and what is the current state? 
3. **How to execute the action?** Which endpoint to take, which identity to use, and how to output and return? 
4. **When will the system truly end?** Will `close()`, `kill()`, TTL expire, or will it pause to a snapshot? 

Only by being able to explain each component along this line can you truly understand; Just remembering the file name doesn't count. 

--- 

## 3. How to learn: Follow the same five-step cycle in every chapter

### Step 1: Answer the chapter questions in your own words

For example, the question in Stage 3 is not "What routes does execd have?", but rather: 

> After the model says "run this code," how does the system make the application believe it really ran and succeeded? 

Write down your intuitive answers first, then read the material. Reading with questions is much more effective than starting from a table of contents. 

### Step 2: Draw a diagram

Each chapter should produce at least one graph: request stream, lifecycle state machine, execution sequence, runtime link, network path, tool loop. The diagram doesn't have to be beautiful, but it must let you tell the relationships without looking at the code. 

### Step 3: Go to the code for verification

Only follow the paths related to this chapter; do not start reading through the repository's root directory. Each concept should be integrated into a specific object or function: 

- Lifecycle: `Sandbox.create`, `SandboxService`, `runtime.type`, TTL
- Run: `commands.run`, `RunCommandOpts`, execd `/command`, SSE
- Runtime: `BatchSandbox`, `Pool`, `SandboxSnapshot`, FastSandbox routes
- Network: `networkPolicy`, endpoint resolution, egress policy, Credential Vault
- Interfaces: `specs/`, adapter, CLI commands, MCP tools
- Engineering: testing, diagnostics, metrics, and release validation

### Step 4: Do a small experiment

Each chapter should have a run-on or verifiable action: create and destroy a sandbox, observe once `Pending`, run a streaming command, write a package with TTL, draw a network strategy, read an adapter, write a tool, and perform fault injection. 

### Step 5: Talk back

Close the document and spend 3–5 minutes explaining to the "self three months from now." Parts that can't be explained clearly are the ones to go back and cover in the next round. 

**The enemy of learning isn't difficulty, but reading without verifying, memorizing only terms without building models, and following steps without asking why.** This course uses "questions → images → code → experiments → retelling" to repeatedly break down these three bad habits. 

--- 

## 4. Stage Approach: Each stage solves only one major problem

### Stage 0 · First, make the smallest closed loop really start running [Preparation]

**Question**: Can the source code server, Docker, SDK, and first sandbox work fully on the local machine? 
**What you need to get**: the ability to create, execute, read output, and destroy it; Have seen one authentication failure; Know the runtime and API key in server configuration. 
**Output**: One successful minimum script + one intentional failure record. 
**Why do it first**: Without real actions, all subsequent concepts become just theoretical talk. 

### Stage 1 · System Map: How to Cross the Platform in a Single Mission [Core]

**Question**: What layers does OpenSandbox have? Who gives input to whom? Why are creation and execution two paths? 
**What you need to get**: Be able to clearly explain "using layer → control plane → runtime → data plane → network plane" in one graph, and mark evidence return. 
**Outputs**: Architecture diagram + create a timing diagram + execute a sequence diagram + a list of failure points. 
**Key Differences**: Lifecycle servers are the control plane, execd is the data plane; Endpoint resolution is a contract, not an address guess. 

### Stage 2 · Life Cycle: The Environment from Birth to Death [Core]

**Question**: When does a sandbox become truly usable? When TTL expires, processes crash, or users cancel, who recovers remote resources? 
**What you need to get**: Able to draw state machines; Able to explain asynchronous creation, absolute TTL, renewal semantics, pause/resume, and snapshot boundaries. 
**Output**: A package that can destroy remote resources on all three paths: success, exception, and cancel. 
**Core Understanding**: The essence of lifecycle management is ownership management; `close()`, `kill()`, `destroy()` are not the same thing. 

### Stage 3 · Execution: The Model's Hands and Feet [Core]

**Question**: How can commands, files, and code become verifiable, restrictable, and returnable actions? 
**What you need to get**: Able to handle streaming output, timeouts, nonzero exit codes, stderr, large files, and connection failures. 
**Output**: A command tool layer with timeouts, truncations, and structured returns. 
**Core Understanding**: `execution.text` Not all evidence; Successful transmission does not equal command success. 

### Stage 4 · Runtime: Same contract, different destinations [Advanced]

**Question**: How does the same creation request end up in Docker containers, Kubernetes Pods, or FastSandbox microvirtual machines? What have pooling and snapshots changed? 
**What you need to get**: Able to draw the links of server → CRD → controller → Pod → execd; Able to explain the responsibilities and boundaries of Pool, Snapshot, and Template. 
**Output**: One runtime selection table + one Pool/snapshot fault description. 
**Core Understanding**: Runtime neutrality does not equal capability; "Interface support" must include backend and configuration conditions. 

### Stage 5 · Network and Credentials: Enable Communication Where It Needs to Be Connected and Cut Off Where It Needs to Be Cut [Advanced]

**Question**: How can external access to the sandbox? Which external targets can the sandbox access? How can the key avoid entering an untrusted process? 
**What you need to get**: Design outbound policies for default rejection, explain ingress routing and error semantics, and explain the injection principles and failure boundaries of Credential Vault. 
**Output**: One-page network policy design + one allow or deny validation. 
**Core Understanding**: Restricting DNS only does not mean only allowing domain names; A credential safe is not about "encrypting keys and then placing them in a sandbox." 

### Stage 6 · Interfaces and Contracts: Multiple Entry Points of the Same Ability [Advanced]

**Question**: What is the relationship between the five language SDKs, `osb` CLI, MCP, and the four OpenAPI contracts? Who should we trust when behavior is inconsistent? 
**What you need to get**: Able to draw a hierarchical diagram of "contract → generating API → adapter → high-level SDK → CLI/MCP"; Able to track an SDK call to HTTP. 
**Output**: One interface selection table + one contract-controlled experiment. 
**Core Understanding**: Contracts are the source, SDKs are consumers; Code generation, handwriting adaptation, and language convenience interfaces cannot replace each other. 

### Stage 7 · Agent Integration: Turning the Sandbox into a Controlled Tool [Core of AI Applications]

**Question**: How can the model safely "write → run→ see results → fix," instead of becoming uncontrollable automatic scripts? 
**What you need to get**: the ability to design a small number of clear tools, budgets, and stopping conditions; the ability to handle context truncation, misclassification, and prompt injection. 
**Output**: A minimal agent with tool contracts, step-by-step budgets, and complete trajectories. 
**Core Insights**: Models can make suggestions, and approval rules must be executed by code, policies, and runtime. 

### Stage 8 · Engineering: From "Able to Run" to "Dare to Go Live" [Core]

**Question**: How can you prove that the system is secure, observable, testable, publishable, and rollback-free? 
**What you need to get**: Ability to complete threat modeling, key classification, resource budgeting, test pyramids, metrics, and release validation. 
**Output**: A 5–8 page production-ready review. 
**Core Understanding**: The sandbox is only an execution boundary, not a complete business security model; Testing must prove behavior, not just "can start." 

### Stage 9 · Comprehensive Practice: Building a Complete Restricted Execution Application [Practical]

**Question**: Can eight abilities be combined into a product that can be demonstrated, explained, and reviewed? 
**What You Need to Get**: No more relying on tutorials, able to independently design lifecycles, tools, networks, observations, and failure paths. 
**Output**: One data analysis and report Agent + architecture diagram + threat model + test record + cost comparison + review. 
**Core Understanding**: True mastery is not about "knowing how to use APIs," but about being able to place uncertain model behaviors within defined engineering boundaries. 

--- 

## 5. Recommended Rhythm and Route

The full route is recommended for 8 weeks, with 8–12 hours per week. Time is an estimate, not a measure; Being able to explain and verify is more important than rushing progress. 

| Weekly | Main Line | Stage |
| --- | --- | --- |
| Week 1 | Run → System Map | 0, 1 |
| Week 2 | Lifecycle | 2 |
| Week 3 | Execution and Documentation | 3 |
| Week 4 | Runtime and Deployment | 4 |
| Week 5 | Networks and Credentials | 5 |
| Week 6 | Interface and Agent Integration | 6, 7 |
| Week 7 | Engineering and Production | 8 |
| Week 8 | Capstone Project and Review | 9 |

### Four ways to walk

- **Minimum Routes**: 0 → 1 → 2 → 3 → 7 → 8 → 9. First, create a secure small agent, then add the runtime and network. 
- **Complete Route**: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Suitable for those who want to systematically master platform capabilities. 
- **AI Application Developer Pathway**: 0 → 1 → 2 → 3 → 5 → 6 → 7 → 8 → 9. Focus on tools, networks, context, and production; Stage 4 Reads the concepts first. 
- **Platform/Infrastructure Routes**: 0 → 1 → 2 → 3 → 4 → 5 → 8 → Elective Areas. Focus on runtime, pooling, snapshots, multi-tenancy, and publishing. 

If time is limited, don't skip the "Understanding + Small Experiments" in Stages 1–3; You can temporarily hold off on digging into FastSandbox, Windows Guest, and node-agent. 

### Three milestones

1. **Weekend 1**: Clearly explain "why creation and execution are two paths," and use raw HTTP to process creation, endpoint parsing, and deletion in one go. 
2. **Weekend 4**: Able to independently write sandbox tool layers with TTL, exception cleanup, and output truncation. 
3. **Weekend 8**: Deliver an AI application with secure boundaries, observability, and reproducibility, and honestly label unverified capabilities. 

--- 

## 6. Final Capstone Project: A Restricted Execution Agent

The core of Stage 9 is not to do a few scattered problems, but to reassemble the previous knowledge. The minimum requirements are as follows: 

- [ ] **Lifecycle**: with TTL, exception cleanup, state query, and idempotent destruction; 
- [ ] **Tool Layer**: At least four tools (write file, read file, run command, column/retrieve product), return in a unified structure; 
- [ ] **Network Boundaries**: The default outbound policy is rejected, allowing only domain names required for the task; 
- [ ] **Key boundaries**: The real key does not enter the sandbox environment, files, logs, or model context; 
- [ ] **Agent Loop**: includes number of turns, number of tool calls, time budget, and a clear stop reason; 
- [ ] **Observation**: request_id, sandbox_id, tool calls, exit codes, time-consuming can be strung together; 
- [ ] **Test**: At least override timeout, nonzero exit code, 429, cleanup failure, and prompt injection; 
- [ ] **Report**: Traceable products, numbers not fabricated by models; 
- [ ] **Review**: One page of architecture diagram, one page of threat model, one page of cost/latency comparison. 

If you can complete the design without watching the tutorial and explain why each part exists, the goal of this course is achieved. 

--- 

## 7. Core Terms Cheat Sheet

| Term | One-sentence explanation |
| --- | --- |
| Sandbox | An isolated execution environment, hosted by a container, Pod, or microVM |
| Lifecycle | The set of management actions: create, query, renew, pause, resume, destroy |
| Endpoint | The address, protocol, and request headers through which a sandbox port is accessible under the current deployment |
| execd | The execution daemon inside the sandbox, providing APIs for commands, files, code, PTY, and metrics |
| Runtime | The backend that actually creates resources: Docker, Kubernetes, FastSandbox |
| TTL | The absolute expiration time of the sandbox, not idle timeout |
| Renew | Sets the expiration time to 'current time + specified duration', not cumulative |
| Pause / Resume | Pause and save a recoverable checkpoint; resuming usually does not retain running memory |
| Snapshot | Checkpoint of the root filesystem or (optionally) VM state |
| Template | A pre-built immutable workload definition in FastSandbox |
| Pool | Pre-warmed Pod capacity pool to reduce allocation latency |
| BatchSandbox | CRD in Kubernetes describing one or more sandboxes |
| Egress | The policy enforcement point for outbound sandbox traffic |
| Ingress | The inbound gateway for external access to sandbox services |
| Credential Vault | Mechanism to keep real credentials in a sidecar and inject them per target |
| Isolated Session | Independent namespace session in the sandbox based on bubblewrap |
| Contract | Public OpenAPI contract in `specs/` |

---

## 8. Documentation Map

| Document | Purpose |
| --- | --- |
| [Overall Architecture](../architecture/) | Overview to read first: mainline, eight components, layers, request journey, design trade-offs |
| [Stage 0](../stage-0/) | Environment setup and minimal closed loop |
| [Stage 1](../stage-1/) | System map, three types of APIs, creation and execution pipelines |
| [Stage 2](../stage-2/) | Lifecycle, TTL, pause/resume, snapshot, cleanup semantics |
| [Stage 3](../stage-3/) | execd, commands, streaming output, files, sessions, code context |
| [Stage 4](../stage-4/) | Docker, Kubernetes, Pool, Snapshot, FastSandbox, isolated runtimes |
| [Stage 5](../stage-5/) | Endpoints, ingress, egress, Credential Vault, secure access |
| [Stage 6](../stage-6/) | Contracts, multi-language SDKs, CLI, MCP |
| [Stage 7](../stage-7/) | Tool contracts, Agent loop, context, prompt injection |
| [Stage 8](../stage-8/) | Threat model, testing, observability, multi-tenancy, release validation |
| [Stage 9](../stage-9/) | Graduation project, milestones, acceptance and defense |
| [Electives](../electives/) | Code Interpreter, browser, storage, Windows, isolated sessions, etc. |

**Usage order**: Read the overview twice → check current phase list → phase details → do experiments → return to overall map and retell. Do not blindly read all source code in document directory order.

---

## 9. Environment and Common Commands

The source code directory is fixed at `$OSB_SRC`. In PowerShell:

```powershell
cd $OSB_SRC

# Version and Source Code Status
git describe --tags --always
docker version

# Python Environment (source code installation, aligned with the textbook)
uv venv .venv
.\.venv\Scripts\Activate.ps1
uv pip install -e .\server -e .\sdks\sandbox\python

# Generate Docker runtime configuration and start the server
opensandbox-server init-config "$HOME\.sandbox.toml" --example docker
opensandbox-server

# Verify
curl.exe http://127.0.0.1:8080/health
curl.exe -H "OPEN-SANDBOX-API-KEY: dev-secret" http://127.0.0.1:8080/version
```

When observing the raw API, prioritize using `curl.exe` or PowerShell's `Invoke-RestMethod`; do not let the SDK's abstraction hide status codes, request headers, and error bodies.

---

## 10. Learning Progress Schedule

- [ ] Stage 0: Able to run through create, execute, destroy, and have seen a 401 once
- [ ] Stage 1: Able to draw system diagrams and creation/execution sequence diagrams without notes
- [ ] Stage 2: Able to write lifecycle encapsulation with three-path cleanup
- [ ] Stage 3: Able to write command-line tools with timeout, truncation, and structured results
- [ ] Stage 4: Able to explain the responsibilities and capability boundaries of Docker/K8s/FastSandbox
- [ ] Stage 5: Able to design and validate a default-deny network policy
- [ ] Stage 6: Able to trace an SDK call to a public contract
- [ ] Stage 7: Able to create an Agent with budget, stopping conditions, and traces
- [ ] Stage 8: Able to complete a production-ready review
- [ ] Stage 9: Able to independently deliver and defend a constrained execution application

---

*Rewritten based on OpenSandbox `release-1.1.1` (`531700ca`, 2026-10-09) · 2026-10-30*
