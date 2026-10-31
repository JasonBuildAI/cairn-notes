---
title: "OpenSandbox 1.1.1: Overall Architecture"
description: "From Intent to Evidence: OpenSandbox's Layered Architecture, Three Vertical Lines, and Key Design Trade-offs."
---

> This article answers three questions: What is OpenSandbox? How is it layered internally? How does an AI action move from generation to recycling—how does it pass through the system? 
> The textbook is based on `release-1.1.1` (submitted `531700ca`, released on 2026-10-09). All paths are relative to `$OSB_SRC`. 
> Usage: First read this article to establish the overall map, then use [learning route](../learning-path/) to arrange the rhythm; At each stage, only dig deep into one section of this main thread. 

## 1. First understand the problem, then understand the project

Once AI applications move from "chatting" to "doing things," they encounter a fundamental change: **Model output is no longer just text, but becomes action.** 

Actions may include: 

- Run model-generated Python, Shell, or Node.js code; 
- Read and write workspace files, modify repositories, generate reports; 
- Launch browser, desktop, or HTTP services; 
- Access package indexes, model APIs, databases, or object storage; 
- Run the task for a long time and restore context afterward. 

If these actions happen directly on your server, the risks arise immediately: 

1. **Unreliable Code**: The model may be written incorrectly, looped in a dead loop, deleted files, or exhausted memory. 
2. **Data Unreliable**: Webpages, documents, and tool results may all contain hidden prompt injections. 
3. **Unclear boundaries**: Processes and files in one session cannot contaminate another session. 
4. **Network Out of Control**: The model may send data to any address or download untrustworthy dependencies. 
5. **Resource Runaway**: Concurrent agents may simultaneously overwhelm the CPU, memory, and disk. 
6. **Operational Difficulties**: After a task fails, you need to be able to determine whether the problem lies with the model, tools, sandbox, or network. 

OpenSandbox's positioning can be summed up in one sentence from the README: 

> **Run AI agents in sandboxes on your own infrastructure.** 

It's not a model, not an Agent framework, nor an online IDE that only runs code. It provides the **infrastructure layer between AI applications and trustless execution**: creating isolated environments with unified APIs, then safely executing model actions through commands, files, and code interfaces. 

### It's not what it is

There are three misconceptions when starting out that must be eliminated first: 

| Misunderstanding | Actual Situation |
| --- | --- |
| "It orchestrates Agent for me" | No. It provides an execution environment; Loops, prompts, model selection, and tool scheduling are still handled by your Agent. |
| "It's just a Docker container" | No. It's a platform: control plane, data plane, network, runtime, SDK, and operations capabilities each have their own boundaries. |
| "Having an interface means it's available everywhere" | No. Abilities like pause recovery, snapshots, templates, and credential vaults depend on backend, configuration, and version

Remember the last point: **This course will repeatedly train you to distinguish three things: "the contract says it," "a certain SDK package is included," and "current backend support."** 

## 2. One Main Storyline: A Lifetime of Sandbox Missions

The entire book revolves around a single main thread. Think of it as an "assignment of work": it involves handing over an unreliable task to an isolated workspace, completing it, collecting evidence, returning the results, and finally returning the workspace.

```text
The model decides to 'run this piece of code'
        │
        ▼
Application / Agent
        │ ① Management requests: create, query, renew, pause, delete
        ▼
Lifecycle Server (Control Plane)
        ② Select runtime and convert to real resources
        ▼
Docker Container / Kubernetes Resource / FastSandbox Micro Virtual Machine
        │ ③ Run user workload inside + execd
        ▼
sandbox ───────────────────────────────┐
   │ ④ First parse the endpoint, then access it directly      │
   execd or the workload's own service
   │                                  │
   ⑤ Outbound traffic passes through the egress sidecar
   ▼                                  ▼
The result is returned with SSE / file / exit code      external service
        │
        ▼
Status, logs, metrics, and audit records are continuously generated
        │
        ▼
Renewal, suspension, snapshot, destruction: resources have a beginning and an end
```

This main storyline has three key actions, and each subsequent phase involves breaking down one segment: 

1. **Arrangement**: The control plane turns "I want an environment" into a real resource within runtime. 
2. **Usage**: After the client parses the endpoint, it interacts directly with the data plane without pushing execution traffic back to the control plane. 
3. **Wrap-up**: TTL, explicit destruction, pause snapshots, and audit records to prevent resource leaks and explain processes. 

Breaking down the main storyline into problems is the book's ten stages: 

| Issues in the main line | Corresponding stage |
| --- | --- |
| Can the system really start running first? | 0 |
| Which layers and APIs does a task go through? | 1 |
| How is the environment created, renewed, suspended, and destroyed? | 2 |
| How can commands, files, and code become verifiable actions? | 3 |
| How does the same contract end up in Docker, Kubernetes, and microvirtual machines? | 4 |
| How to Enter, Out, and Limit Traffic, and How to Keep Keys from Entering the Sandbox? | 5 |
| What is the relationship between SDK, CLI, MCP, and public deeds? | 6 |
| How to connect the sandbox into the Agent's loops and tools? | 7 |
| How can a system be testable, observable, and live-ready? | 8 |
| Can you independently create a complete restricted execution application? | 9 |

### Three vertical lines running through the entire book

Besides the main storyline, there are three other questions to keep in mind: 

1. **How does evidence flow?** Status, SSE events, exit codes, logs, and metrics are the only basis for determining whether the application has truly succeeded. 
2. **Where are the boundaries of trust?** Users, models, tools, sandboxes, hosts, and external networks—each can control what and cannot control. 
3. **What conditions does capability depend on?** When you see "Support," ask further: which backend, what configuration, what version, which image. 

## 3. Eight Components: Eight Questions Every AI Execution Platform Must Answer

Don't set your learning objective as "remember the directory name" first. The table of contents will change, but the following judgment framework won't: 

| Component | Question to answer | Correspondence in OpenSandbox | Stage |
| --- | --- | --- | --- |
| Entry | How do people and programs use the platform? | Python/JS/Go/Kotlin/C# SDK, `osb` CLI, MCP | 6 |
| Contract | Why isn't the client locked by a backend? | `specs/` under OpenAPI | 1, 6 |
| Lifecycle | When is the environment created, when does it expire, and when is it destroyed? | `server/` (FastAPI Control Plane) | 2 |
| Runtime | Does the environment actually run on containers, pods, or micro-virtual machines? | Docker, Kubernetes, FastSandbox | 4 |
| Execution | How does the model action actually happen? | `components/execd/` | 3 |
| Network | How does traffic enter, how does it leave, and how is it restricted? | endpoint, `components/ingress/`, `components/egress/` | 5 |
| Security | How are untrusted code and keys constrained? | Isolation runtime, resource limits, network policies, Credential Vault, tenants | 4, 5, 8 |
| Engineering | How can it be proven to be reliable, observable, and evolvable? | Testing, diagnostics, metrics, release, and supply chain validation | 8 |

In short: **entry initiation, contract constraints, control plane arrangements, runtime implementation, data plane execution, network plane governance, security side coverage, and engineering side verification.** 

## 4. Layered Architecture: What exactly does each layer do?

First, remember a general principle: **OpenSandbox splits the "management environment" and the "usage environment" into two paths.** When changing runtimes, clients, or network policies, only change the corresponding layer, no need to start over. 

### 4.1 Let's first look at the simplified diagram: arrange downward, execute bypass, and return evidence

```text
┌──────────────────────────────────────────────────────────────┐
│ Usage layer: SDK / CLI / MCP / Agent framework                         │
│ Responsible for initiating management requests, parsing endpoints, and consuming execution results │
└───────────────┬──────────────────────────────┬───────────────┘
                │ ① Management Request                    │ ③ Execution Request
                ▼                              ▼
┌───────────────────────────────┐   ┌───────────────────────────┐
│ Lifecycle control plane (server)       │   │ Data plane (execd / workload) │
│ authentication, verification, state machine, TTL, │ │ commands, files, code, PTY, │
│ Endpoint parsing, snapshot metadata           │   │ Metrics                       │
└───────────────┬───────────────┘   └────────────▲──────────────┘
                │ ② Select and drive runtime               │ ④ Endpoint is parsed by the control plane
                ▼                                 │
┌───────────────────────────────┐                 │
│ Runtime: Docker / Kubernetes    │─────────────────┘
│ / FastSandbox                 │  Real Resources and Endpoints
└───────────────┬───────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────┐
│ Networking and Security: ingress (incoming) / egress sidecar (outgoing) / credentials     │
└──────────────────────────────────────────────────────────────┘

Evidence returns in the opposite direction: status, SSE events, exit codes, logs, metrics, audits.
```

Looking at this chart, you only need to grasp three things: 

1. **Management is infrequent**: create, query, renew, pause, delete, and control the interface. 
2. **Execution is high-frequency, long-connected**: commands and files go directly to the data plane, while the control plane only tells you "where to go." 
3. **Next to it is an evidence stream**: status, events, and logs determine whether you truly succeed. 

### 4.2 What are each level responsible for, and what is not?

| layer | You can think of it as | Responsible | Not responsible |
| --- | --- | --- | --- |
| Usage Layer | Frontend | Initiate requests, parse endpoints, display or forward results | Decide how resources are created and how state machines advance |
| Contract layer | Contract | Fixed public fields, endpoints, errors, and state semantics | Specify how a backend must implement |
| Control Plane | Scheduling Center | Authentication, Validation, Lifecycle, Endpoint Parsing, Snapshot Metadata | Carrying command streams, saving all sandbox facts |
| Runtime | Host | Provide containers, pods, or microvirtual machines to maintain the real state | Define user-visible APIs |
| Data Plane | Foreman | Execute commands, files, and code within the sandbox, returning stream evidence | Manage the sandbox's life and death, and decide network policies |
| Network Interface | Gatekeeper and Visitor Channels | Inbound Routes, Outbound Policies, Credential Injection | Process Isolation for Sandbox Replacement |
| Engineering Aspect | Quality Inspection and Archives Room | Testing, Diagnosis, Indicators, Release Validation | Changing Business Semantics |

The "not responsible" in the table is very important. Whether the layers are clear mainly depends on the boundaries, not the number of terms. 

### 4.3 Three Pairs of the Most Confusingly Confused Objects

| Object pair | Like something | A one-sentence difference |
| --- | --- | --- |
| Lifecycle Server vs Runtime | Scheduling Center vs Actual Workroom | Server arranges the environment, and runtime has the true state of the environment
| execd vs User Load | Foreman vs Worker | execd provides an execution API, and the user payload is the program that is actually being run
| Endpoint vs Address | Front-end Pass vs. Specific Door | Endpoints are resolved by the server according to deployment topology; clients should not manually configure IP and port |

Another pair of concepts will recur in Stage 2: 

- **Sandbox (Remote Resources)**: Containers, Pods, or microvirtual machines that can be created, paused, or destroyed. 
- **`Sandbox` Object (Local Handle)**: The client object in the SDK, holding the ID, connection configuration, endpoint cache, and service adapter. `close()` It is the one that closes, not necessarily the remote resource. 

### 4.4 Why is the server more reliable if it doesn't store all sandbox records? 

This is the most common misunderstanding for beginners. Intuitively, "the platform should have a database that records all sandboxes." OpenSandbox is the opposite: 

- Docker containers, Kubernetes resources, and FastSandbox CR are the real sources of runtime facts; 
- The server only maintains what it owns: snapshot metadata, template directories, etc.; 
- When querying the sandbox, the server reads the state from runtime and then converts it to the state of the public API. 

The benefit of this approach is: runtime failures don't cause the control plane to have a copy that "looks correct but is actually expired"; after the server restarts, the fact can be rediscovered from the runtime. The trade-off is: every query must interact with the runtime, and state transitions must handle "runtime temporarily unreachable." 

### 4.5 Two rules running through the entire system

- **Control plane arrangement, data plane execution.** Creating a sandbox and running commands are two different types of traffic; By default, execution does not go through the lifecycle server. 
- **Security is off by default, capabilities are enabled explicitly.** API Key, resource cap, default outbound policy, access token, and strong isolation runtime all require explicit configuration; More relaxed modes must be enabled by humans, not by default. 

These two rules will reappear in chapters two, three, and five; just memorize one sentence each. 

## 5. The Complete Journey of a Sandbox Mission

This chapter actually walks through the diagrams from Chapter 2. You can skip the code name for now, as long as you can say "who gave what to whom" at every step. 

### 5.1 Eight words, clarify first

| Terminology | One-sentence explanation | The most easily misunderstood place |
| --- | --- | --- |
| Sandbox | An isolated execution environment, possibly hosted by containers, pods, or microvirtual machines | It is not the Python object in the SDK |
| Lifecycle | Create, query, renew, pause, restore, and destroy all these management actions | It is not equivalent to "executing commands" |
| Endpoint | The address, protocol, and request header accessible by a sandbox port in the current deployment | It is not a fixed IP, nor should the client guess |
| execd | Execution daemon inside the sandbox, providing commands, files, code, and other API | It is not the user program itself |
| Runtime | The real backend for creating resources: Docker, Kubernetes, FastSandbox | It's not as simple as a `runtime.type` string |
| TTL | The absolute expiration time of the sandbox | It's not "how long after the last event" |
| Snapshot | Restorable checkpoints saved during pause | By default, it only saves the root file system and does not save runtime |
| Template | FastSandbox Pre-built Immutable Workload Definition | It is not a temporary image parameter passed every time it is created

First, remember the five words **Sandbox, Endpoint, execd, Runtime, TTL**, which will appear repeatedly later. 

### 5.2 From "The Model Wants to Do Something" to "Obtain Evidence": Viewing in Stages

#### Stage A: Application initiation and creation

The Agent decides that an environment is needed to run the code. Application call:

```python
sandbox = await Sandbox.create(
    "python:3.12",
    timeout=timedelta(minutes=10),
    resource={"cpu": "500m", "memory": "512Mi"},
)
```

The SDK turns it into `POST /v1/sandboxes`, with the image, TTL, resources, metadata, and possibly network policies and credential proxy settings. 

#### Stage B: Control Plane Performs "Pre-Acceptance Checks"

The lifecycle server processes in sequence:

1. **Authentication**: Check `OPEN-SANDBOX-API-KEY` (or the identity parsed by the tenant provider).
2. **Validation**: Verify if the image, TTL, resources, ports, and policies meet the contract.
3. **Select Runtime**: Based on `runtime.type` and request characteristics, decide whether to hand over to Docker, Kubernetes, or FastSandbox.
4. **Submit to Runtime**: Create the container, write `BatchSandbox` CR, or submit a template sandbox request.
5. **Return Acceptance Result**: It might be `Pending`, or it might have already `Running`.

Key Insight: **HTTP creation is asynchronous.** The server does not need to wait for the image to be pulled or the Pod to be scheduled before returning; the SDK's `create()` appears synchronous because it polls the status, endpoint publishing, and health checks for you.

#### Stage C: Runtime Actually Creates the Resources

- **Docker**: Create the container, inject or start execd, map ports.
- **Kubernetes**: Write `BatchSandbox`, the controller creates the Pod; execd exists as an init container or built into the image.
- **FastSandbox**: Assign pre-warmed micro VMs based on already built templates; FastPath/Fastlet handles control and execution.

The result at this step is not an abstract object but real resources: containers, Pods, CRs, micro VMs. You can see it using `docker ps` or `kubectl get`.

#### Stage D: Wait for Readiness and Publish Endpoint

The state goes from `Pending` to `Running`. The SDK typically:

1. Polls `GET /v1/sandboxes/{id}` until the state is available;
2. Parses `GET /v1/sandboxes/{id}/endpoints/44772` to get the address and request headers of execd;
3. Requests execd's `/ping` for a health check;
4. Returns a usable `Sandbox` handle.

"Creation return" does not mean "the server has completed all work in one step," much less "the business process is ready." These three things must be considered separately.

#### Stage E: Parse Endpoint, Not Guess Address

The client does not assume "Docker is localhost:some port" or "Kubernetes is Pod IP." It calls:

```text
GET /v1/sandboxes/{sandboxId}/endpoints/{port}
```

The server returns direct connection addresses, gateway addresses, or server proxy addresses according to the current deployment topology, along with the necessary request headers. **The addresses are results, not assumptions.** This rule allows the same set of SDKs to serve Docker, Kubernetes, and gateway deployments simultaneously.

#### Stage F: Execute commands, collecting results while running

```text
SDK → POST {execdEndpoint}/command
execd verification request, start process
  → SSE Continuously sending stdout / stderr / result / complete
  → SDK aggregated into Execution objects
```

Streaming output means that the client cannot just wait for the final JSON: it has to handle chunks, line endings, error events, and connection interruptions. A non-zero exit code, execd error, and transport disconnection are three different types of failures.

#### Stage G: Outbound traffic goes through the egress sidecar

If declared at creation `networkPolicy`, the platform attaches an egress sidecar to the sandbox. It shares the network namespace with the sandbox, so each outbound packet goes through the policy engine:

- The DNS layer allows or denies by domain name;
- `dns+nft` mode imposes default denial at the packet layer;
- Matching HTTPS requests can have credentials injected by the sidecar, so real keys do not enter the sandbox.

Sandboxes without declared policies at creation usually cannot have a sidecar added later. **Outbound control is determined at creation, not wished into existence during runtime.**

#### Stage H: Cleanup, pause, or resume

After the task is completed, the application should explicitly destroy it:

```text
destroy() → kill() (terminate remote) + close() (release local connection)
```

If it is just `close()`, the remote sandbox may still exist, continuing to consume resources and incur costs. For long tasks, you can also:

- Use `renew()` to extend the absolute expiration time;
- On supported backends, `pause()` to commit the root filesystem as a snapshot;
- Use `resume()` to restore with the same sandbox ID, though usually not restoring runtime memory.

#### Phase I: Evidence Feedback

The entire process continually generates evidence:

- **States**: `Pending`, `Running`, `Pausing`, `Paused`, `Stopping`, `Terminated`, `Failed`, as well as `reason` / `message`;
- **Execution events**: stdout/stderr fragments, results, completions, errors;
- **File artifacts**: output files, logs, charts;
- **Metrics**: CPU, memory, creation latency, failure rate;
- **Audit**: who created what when, executed what, and why it was destroyed.

Good infrastructure is not about "never failing," but about "knowing why it failed and where to check".

### 5.3 Compressing the entire process into a sequence diagram

```text
Application / Agent
  │
  ├─① Sandbox.create(...)
  │     └─► POST /v1/sandboxes
  │           ├─ Authentication / Verification / Select runtime
  │           ├─ Docker Container / BatchSandbox / FastVM
  │ └─ 202 + sandboxId (possibly Pending)
  │
  ② Polling Status and Endpoint
  │     ├─ GET /v1/sandboxes/{id}
  │     └─ GET /v1/sandboxes/{id}/endpoints/44772
  │           └─ { url, protocol, headers }
  │
  ③ Health Check
  │     └─ GET {execd}/ping
  │
  ④ Execute
  │     └─ POST {execd}/command
  │           └─ SSE:stdout / stderr / result / complete
  │
  ⑤ Exit the station (if there is a strategy)
  │     └─ Sandbox → egress sidecar → External service
  │
  ⑥ Finishing
        ├─ destroy() / kill() / close()
        ├─ or pause() → snapshot → resume()
        Status, logs, metrics, audit retention
```

In short, remember: **Control plane arranges the environment, endpoints point out execution paths, execd exeCDs execute actions, egress holds boundaries, and states and events prove results.** 

### 5.4 Four Common Misconceptions

| Easy to understand like this | More accurate understanding |
| --- | --- |
| "`Sandbox.create()` returned, so the creation is synchronous." | No. HTTP creation is asynchronous; The SDK is just waiting for endpoint publishing and health checks for you
| "Executing commands also goes through the lifecycle server." | By default, it does not run. Executes the execd endpoint parsed; The server proxy is just a safety net for compatibility. |
| "`close()` will delete the sandbox." | No. `close()` Release local connection; `kill()` Terminate the remote; `destroy()` Do both. |
| "The sandbox has isolation, so the network is naturally secure." | No. Isolation limits the impact on the host machine; Outbound leaks still require egress policies and credential isolation

For complete details, see [Stage 1](../stage-1/) (Request Journey and Failure Points), 'Stage 2 Detailed' (Lifecycle), and 'Stage 3 Detailed' (Execution Data Plane). 

## Six or Seven Key Design Trade-offs

Many OpenSandbox designs may seem a bit "detoured" at first glance, but they're actually solving a specific problem. Each choice below is explained in the same order: **What happens if you don't do it → What does it do→ What do you get and what you have to pay for?** 

### 6.1 Protocol First, Not SDK First

**Trouble**: Five languages, one CLI, one MCP server—if you customize each behavior, you'll quickly get five sets of semantics and five sets of bugs. 

**Practice**: Public behavior is first defined in `specs/`. The SDK is the consumer of the contract, not the contract itself. When reading the SDK, first ask "Which API does it ultimately call?" Otherwise, it can easily be obscured by language encapsulation. 

**Result**: Cross-language behavior can be aligned, and the backend can be replaced. The trade-off is that when reading code, you must distinguish between 'code generation,' 'handwriting adaptation layer,' and 'language habit encapsulation.' 

### 6.2 Separation of Control Plane and Data Plane

**Trouble**: Creating a sandbox involves low-frequency, slow operations; Executing commands may be high-frequency, long-connected, and continuously streamed. If everything goes to the server, the control plane becomes bandwidth and connection bottlenecks, and the fault areas will be mixed together. 

**Approach**: The lifecycle API is only responsible for scheduling and parsing; Executing traffic goes directly through execd. The server proxy only serves as a compatible path when direct connection is not possible. 

**Result**: The control plane and data plane can be independently scaled, evolved, and fault-troubled independently. The trade-off is that the client must correctly handle endpoint resolution and stream connections. 

### 6.3 Lifecycle Asynchronization, TTL is Absolute Time

**Troublesome**:P OD scheduling, image pulls, and micro-virtual machine startups can all be very slow; If "idle timeout" is used, server restarts or runtime jitter can quietly alter sandbox lifespan, which audits cannot explain. 

**Method**: Create and return `Pending`; Expiration time is an absolute point in time. The renewal semantics are "how many more years from now" is "how much longer to give from now," not "accumulate over the original expiration time." 

**Result**: Slow creation does not take up HTTP requests; lifespan can be calculated from creation time. The trade-off is that clients must learn polling, waiting, and renewal budgeting. 

### 6.4 Endpoint resolution is a public contract

**Troublesome**:D ocker uses port mapping, Kubernetes uses Pod/Service/gateway, FastSandbox uses FastPath; If the client tries to assemble the address themselves, a different deployment will become invalid. 

**Method**: `GET /sandboxes/{id}/endpoints/{port}` Return the address, protocol, and necessary request headers. Use the client as is, without inference. 

**Result**: The same SDK adapts to multiple topologies. The trade-off is that endpoint resolution itself becomes a step requiring authentication, authorization, and troubleshooting. 

### 6.5 Runtime Neutral, but Capabilities Have a Matrix

**Trouble**: If the API is bound to Docker, you won't be able to access Kubernetes; If you pretend all backends are completely equipped, you'll mistakenly write 'interface exists' as 'capability available.' 

**Method**: The unified concepts are resources, timeouts, endpoints, policies, etc.; Specifically, creating pods, hanging rolls, snapshots, and micro-virtual machines is implemented by the backend. The textbook clearly marks the capability boundaries. 

**Result**: The same contract covers both single-player and cluster systems. The trade-off is that developers must ask "Which backend, what configuration, what version?" 

### 6.6 Security is off by default; failure means rejection

**Trouble**: Once untrusted code obtains the network and key, isolation is reduced to just half of "protecting the host machine"; And "misconfigured but seemingly running" is more dangerous than outright failure. 

**Method**: API Key, resource cap, cap dropping, `no_new_privs`, default denial outbound policy, access token, and strong isolation runtime all need to be explicitly enabled. If the egress sidecar cannot install rules, exit instead of silently allowing it. 

**Result**: Security posture is predictable and auditable. The trade-off is a larger initial configuration, and the boundaries of each switch must be understood. 

### 6.7 Status and evidence must be explainable

**Trouble**: Distributed systems will definitely fail. If only "Creation failed" is returned, users and operations cannot determine whether it is capacity, image, permissions, or network issues. 

**Practice**: Status is not just a word, but also `reason`, `message`, and transition time; Execution has error types; Network policy failure explicitly causes errors; Diagnostic API provides logs and events. 

**Result**: Failures can be pinpointed, retried, and audited. The trade-off is that the client must distinguish between "retryable" and "non-retryable" errors, and not treat all errors as the same type. 

### 6.8 Connect the seven choices

- Protocol First: Five types of entry points speak the same language. 
- Control/Data Separation: Scheduling and execution are optimized separately. 
- Asynchronous + absolute TTL: slow creation without delaying requests, lifetime auditable. 
- Endpoint contract: The client does not guess the topology. 
- Runtime neutral: One API covers multiple infrastructures. 
- Security default denial: Untrusted actions have boundaries. 
- Evidence explainable: failure can be pinpointed. 

They are not designed in isolation but work together: **contracts define behavior, control planes allocate resources, runtime provides isolation, data planes execute actions, network plane traffic management, and evidence flows link all links together.** 

## 7. Source Code Directory: Look at the boundaries first, then the details

| Path | One-sentence Responsibility | Recommended Reading Order |
| --- | --- | --- |
| `specs/` | Public Protocol: Lifecycle, Execution, Outbound, Diagnostics | First look at the interface and model name, no need to memorize fields |
| `server/` | FastAPI lifecycle control surface | `api/lifecycle.py` → `services/sandbox_service.py` → specific runtime |
| `components/execd/` | Execute daemon in sandbox | `main.go` → `pkg/web/router.go` → Command/File/Code implementation |
| `components/egress/` | Egress strategy, DNS/nft, credential proxy | First look at strategy patterns and credential vault |
| `components/ingress/` | Kubernetes inbound reverse proxy | Header/URI routing and error semantics |
| `components/nodeagent/` | Optional node proxy and audit collection | Read on demand, not the main chain entry |
| `kubernetes/` | Operator, CRD, Controller, Task Execution | `BatchSandbox`, `Pool`, `SandboxSnapshot` |
| `manifests/charts/` | Helm charts | Follow the order base → controller → ingress → server |
| `sdks/sandbox/python/` | Python high-level encapsulation | `sandbox.py` → `services/` → `adapters/` → `api/` |
| `sdks/code-interpreter/` | Stateful code interpreter | See context and Jupyter kernel |
| `sdks/mcp/` | MCP Tool Server | View Tool Schema and Lifecycle |
| `cli/` | `osb` Command | View command organization and output format |
| `examples/` | Runnable integrated example | Select read by scenario |
| `tests/` | Cross-Language End-to-End Verification | Learning Contract-Driven Testing |

### The Three-Pass Method for Reading Source Code

**First pass: only draw the boundaries.** Identify 'who calls whom' without going into the implementation. For example, the SDK's `Sandbox` calls the service interface, the adapter then calls the HTTP client; the server API calls the service interface, and the service calls Docker/K8s.

**Second pass: Follow only the main path.** Choose 'Create Sandbox' or 'Run Command', follow the call stack to the end, and record the input, output, and errors at each level.

**Third pass: Only ask about failures.** Timeout, authentication failure, endpoint unreachable, non-zero command exit code, and connection interruption—at which layer are these handled? This reveals the design quality even more than the normal path.

## 8. Version Boundaries: 1.1.1 Facts You Must Know

The textbook will not write 'interface exists' as 'available everywhere.' Please remember the following boundaries:

1. **Docker is suitable for local and single-machine use**; Kubernetes is the one with Operators, pooling, and large-scale orchestration.
2. **Pause/Resume and snapshots depend on the backend and configuration**; not all runtimes are equivalent, and rootfs snapshots do not retain runtime memory by default.
3. **The template relies on Kubernetes FastSandbox integration**; the Docker reference service will reject template management.
4. **Credential vault depends on the egress sidecar**; the template sandbox does not have a sandbox-side vault; after pausing, the vault state in memory will be lost and needs to be re-injected.
5. **Code Interpreter requires a dedicated image**; a standard minimal image does not equate to support for Jupyter code context.
6. **Running locally on Windows depends on Docker Desktop's Linux containers and WSL2**; Windows container configuration is another path.
7. **A resource pool is for capacity optimization**, it does not make 'creation' itself a free operation; Pods that already exist in the pool cannot have network policies and volumes injected into each request at will.
8. **Multi-tenancy is Kubernetes namespace isolation**, the Docker backend cannot treat `[tenants]` configuration as a security boundary.

These boundaries are not defects, but the normal 'capability matrix' of the infrastructure system. Excellent developers confirm the boundaries first before writing code.

## 9. Why it is suitable for learning AI application engineering

OpenSandbox has brought the few most easily ambiguous issues in AI applications to the surface:

- Where does the code generated by the model get executed?
- How to stream the tool output to the Agent?
- How are sessions isolated from each other?
- How to restrict external networks?
- How can the key avoid entering the sandbox?
- How to resume a long task?
- How to optimize delays and costs?
- How to observe and locate failures?

Answer these questions one by one clearly, and what you gain is not just the knowledge of OpenSandbox, but a set of engineering judgment skills that can be transferred to any Agent platform.

## 10. Self-Check After Reading This Article

Answer first without looking at the materials, then compare with the answer:

1. **What are the control plane and data plane of OpenSandbox responsible for, respectively?**
   The control plane is responsible for authentication, verification, lifecycle, endpoint resolution, and snapshot metadata; the data plane is responsible for executing commands, files, and code in the sandbox and returning streamed evidence.

2. **Why does an execution request by default not go through the lifecycle server?**
   Execution is the path with high frequency, long connections, and large amounts of data; the control plane is responsible for low-frequency management. Separating them can prevent the control plane from becoming a bandwidth and connection bottleneck, and also make the fault domain clearer.

3. **Why might creating a sandbox return `Pending`? And why does the SDK often appear to return synchronously?**
   Creating, scheduling, pulling images, and starting execd at runtime can all be slow; HTTP is handled first. The SDK polls status and endpoints internally within `create()` and performs health checks, so it appears synchronous.

4. **Why must endpoint resolution belong to a public contract?**
   Different deployment topologies have different reachable addresses (Docker port mapping, Pod/Service, gateway, proxy); only the server knows the current topology, and client guessing addresses will fail when the deployment changes.

5. **Give three capabilities where the interface exists but the current backend may not support it.**
   Pause/resume and snapshots, template sandbox, credential vault, Code Interpreter, multi-tenancy, etc., all depend on the backend, configuration, or image; you can choose any three and explain the conditions.

6. **What are the differences between `close()`, `kill()`, `destroy()`?**
   `close()` releases the local connection; `kill()` terminates the remote sandbox; `destroy()` first kills then closes.

If you can answer more than five, proceed to arrange the pace in the 'Learning Checklist'.

---

*Accompanying [learning path](../learning-path/) written · 2026-10-30 · based on release-1.1.1 (`531700ca`)*
