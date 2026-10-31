---
title: "Stage 4: Runtime and Isolation"
description: "Docker, Kubernetes, FastSandbox: three footholds of the same contract."
---

> Response for this stage: Why can the same creation request produce "almost" the same behavior on Docker containers, Kubernetes Pods, and FastSandbox micro-VMs? Which differences are by design, and which differences are due to the current backend conditions?
> Estimated 4–5 days. The core outputs are a **capability matrix**, a **decision tree for choices**, and an explanation that can clarify "why memory is gone after pausing," "why the Pool returns 429," and "why gVisor cannot be configured with egress."

## Why this step is needed

By the end of Stage 3, you can already see "execution" as a stable chain: client → execd → process → output. That chain is stable because the contract of execd does not care what environment it runs in.

But as soon as you look one layer deeper, problems immediately arise:

```text
The same segment of Python code
  -> Create on the development machine, start the container in 100 milliseconds, memory still remains after pause
  -> Created on Kubernetes, may need to wait for scheduling, pulling the image, Pool allocation
  -> Change to FastSandbox, even the image in the request cannot be changed
```

If you don't understand what the next layer is doing, you might mistake three completely normal phenomena for bugs:

- "Yesterday I could pause and then continue running, but today after resuming, all variables are gone."
- "The pool clearly has Pods, so why does a creation request return 429?"
- "The documentation says it supports gVisor, so why doesn't the network policy take effect after I configure it?"
- "The same image, why is it `host` network locally, but needs to go through a gateway in the cluster?"

The judgment to establish at this stage is: **uniform interface does not equal equivalent capabilities; equivalent capabilities also do not equal the same cost.**

First, remember the difference between these three terms; everything later revolves around them:

| Term | Question it answers | Common misunderstanding |
| --- | --- | --- |
| runtime | Who creates the sandbox resources and where they run | Thinking there are only Docker and K8s as "deployment methods" |
| isolation | How strict the boundary between sandbox and host is | Thinking changing the runtime automatically makes it safer |
| capability | Whether the backend, configuration, version, or image supports a certain feature | Thinking that if the SDK has this method, the backend can definitely do it |

## An analogy: the same order, three ways to fulfill it

Think of "creating a sandbox" as the next order, and the runtime as the fulfillment method:

```text
Order: A python:3.12 environment, runs for 15 minutes, can execute commands

Docker        = Made in store
                Made to order, see the process, fastest for recipe adjustments
                But there's only this one store, and if it's too busy, you have to wait in line.

Kubernetes = Central warehouse + distribution
                You just write 'what you need,' the warehouse is responsible for finding the goods, scheduling, and restocking.
                The most capable, but the chain is long, and if something goes wrong, it needs to be checked layer by layer.

Pool = Stock up in advance
                Replace 'equal production' with 'equal capacity'
                 Lower latency, pay costs in advance

FastSandbox   = Prefabricated house
                First, the template is created, and the order only specifies 'which set to use, for whom, and for how long'.
                 Fastest, but the formula cannot be changed on site
```

The four fulfillment methods correspond to the same order format, which is exactly the design goal of OpenSandbox: **the upper-layer API is not rewritten at runtime**. However, with different fulfillment methods, the options, failure modes, and cost structures vary. Every time the textbook says "supported," you need to ask: under which runtime and what configuration is it supported?

## Step 1 · First, find the location of the runtime layer

Add one more layer below the system diagram from Stage 1:

```text
SDK / CLI / MCP
  -> lifecycle server (authentication, TTL, state, error mapping)
       -> SandboxService (Unified Interface)
            -> DockerRuntime      (Local container)
            -> KubernetesRuntime  (BatchSandbox / agent-sandbox)
            -> FastSandboxService (fsb- sandbox, FastPath)
                 -> Runtime: execd +  your process
```

Three key points:

1. **The server does not directly manipulate containers or Pods.** It calls the implementation of `SandboxService`, translating 'create/pause/delete' into backend actions.
2. **The execd contract does not change with the runtime.** What changes is only 'who runs execd, which network it runs on, and how the endpoint is resolved.'
3. **FastSandbox is not a `runtime.type`.** Under `runtime.type = "kubernetes"`, it is a parallel service branch that routes based on request characteristics.

In the configuration, the only `runtime.type` options available are two values:

```toml
[runtime]
type = "docker"        # or "kubernetes"
execd_image = "opensandbox/execd:<tag>"
execd_run_as_init = false
```

`execd_image` is necessary: no matter which runtime is used, there must be an 'execd' execution agent in the sandbox. `execd_run_as_init = true` will make execd the container's PID 1 (OSEP-0018), taking over child process reaping and the container lifecycle, while also raising the security baseline—this is a **runtime startup mode** choice, not an API capability.

### Why 'isolated runtimes' are not included in this table

Beginners often consider gVisor, Kata, and Firecracker as a fourth `runtime.type`. They are not. They **replace the isolation boundary within the same runtime**:

```toml
[secure_runtime]
type = "gvisor"          # ""(runc) / gvisor / kata / firecracker
# docker_runtime = "runsc"
# k8s_runtime_class = "gvisor"
```

So at this stage, you need to understand two axes simultaneously:

```text
Horizontal axis: Where are the resources (Docker / Kubernetes / FastSandbox)
Vertical axis: How hard the boundaries are (runc / gVisor / Kata / Firecracker)
```

The two axes can be combined, but not arbitrarily. The restrictions will be provided in Step 7 later.

## Step 2 · Docker: The shortest path, and also the best observation window

The Docker runtime turns "a sandbox" into "a container   port mapping   several labels". It is not good at scale, but extremely suitable for learning: each step can be observed using `docker ps`, `docker inspect`.

### Key configurations and their trade-offs

| Configuration | Default | Impact |
| --- | --- | --- |
| `docker.network_mode` | `"host"` | The sandbox directly uses the host network, simple and no NAT; but the egress sidecar and `networkPolicy` require **`bridge`** |
| `docker.port_range_min/max` | `40000` / `60000` | Host port allocation range in bridge mode, at least 100; each sandbox needs 2–3 ports (3 with egress) |
| `docker.publish_host` | `"0.0.0.0"` | Which address the port is published to; when the server is on the host, it can be tightened to `127.0.0.1` |
| `docker.pids_limit` | `4096` | Prevent fork bombs from overwhelming the host |
| `docker.no_new_privileges` | `true` | Prevent privilege escalation |
| `docker.drop_capabilities` | see `config.py` | By default, a set of Linux capabilities is dropped |
| `docker.sandbox_binds` | `[]` | Unified mount for all sandboxes, placed before any mounts brought by requests |

The key point to understand here is the trade-off between `host` and `bridge`:

```text
host: fast, intuitive address, easy to debug
         But each sandbox shares the host machine's network namespace, making it impossible to attach outbound policies.

bridge: Each sandbox has an independent network namespace and can insert an egress sidecar
         The cost is port mapping, address rewriting, and port range management
```

So, the reason for 'I set up `networkPolicy` on Docker but was denied' is often not that the API is wrong, but that `network_mode` does not meet the required conditions. Such errors should be understood as **capability conditions not being met**, rather than overly strict parameter validation.

### What the lifecycle looks like on Docker

- Creation: start the container and wait for the execd port to be available.
- TTL: The server records the absolute expiration time using labels and has a timer; after a server restart, it recovers from the labels instead of discarding the expiration time.
- Pause: **freeze the container**. Processes are suspended, memory remains, the container still consumes resources, and ports are still occupied.
- Deletion: stop the container, delete the container, and release the ports.

'Pause still consumes resources' is not a bug but an inevitable result of the freeze semantics. If you want to 'release resources but keep files,' that is the snapshot path, not the pause path.

### When to use Docker

- Local development, teaching, single-machine CI.
- When you need to frequently change images, mounts, or inspect the container internals.
- The number of sandboxes is within the capacity of a single machine, and scheduling and pooling are not needed.

The trade-offs must also be clear: no cross-node scheduling, no pool, no controller convergence; if the host machine fails, everything fails.

## Step 3 · Kubernetes: Turn 'create' into 'converge'

The core change in Kubernetes runtime is not that 'containers become Pods,' but that **the creation action changes from 'imperative' to 'declarative'**:

```text
The server no longer says 'Give me a container'
The server said, 'There is a BatchSandbox here, expecting it to run this way.'
The controller repeatedly compares the desired and actual values until they match.
```

### Create Link

```text
1. server validates request (image/snapshot, resources, entrypoint, TTL)
2. server generates BatchSandbox CR and writes them into Kubernetes API
3. controller observed CR:
     - Have poolRef -> Apply to Pool for capacity
     - None poolRef -> Create Pod according to template
4. Pod Scheduling, pulling images, starting, execd ready
5. The controller writes allocated / ready / conditions back to status
6. The server reads Ready and the endpoint, and returns the sandbox id and endpoint
```

Note that there may be a long gap between step 2 and step 6. This is why stage 1 is divided into three levels:

```text
Resource accepted (CR written successfully)
  ≠ Pod already Ready
    ≠ execd accessible
```

The server's waiting limit is controlled by `kubernetes.sandbox_create_timeout_seconds`, defaulting to 60 seconds. It waits for 'availability,' not 'submission.' After the timeout, it returns an error, but the CR may still exist, requiring cleanup paths as a fallback—this is exactly why the controller pattern must pair with a finalizer/cleanup logic.

### Reading BatchSandbox: A 'Run Contract'

The main fields of `BatchSandboxSpec`:

| Field | Function | Design Meaning |
| --- | --- | --- |
| `replicas` | Desired number of replicas | Supports batching; ordinary sandboxes created via the lifecycle API are usually 1 |
| `template` | Pod template | Direct creation: image, entrypoint, resources, environment are all here |
| `poolRef` | References a Pool | Uses pre-warmed capacity; this and `template` are two separate allocation paths |
| `shardPatches` | Makes differentiated patches for each replica | Replicas in a batch may not be identical |
| `taskTemplate` | Tasks issued after successful allocation | Carries entrypoint, initialization, or business processes |
| `expireTime` | Absolute expiration time | Control plane cleans by time, not relying on the caller to remember deletion |
| `pause` | Pause/Resume intent | `true` requests pause, `false` requests resume, `nil` indicates no new operation |

One easily misunderstood point: **In Pool mode, `template` and `taskTemplate` are not the same layer.**

```text
Pod in Pool: The mirror and running shape are fixed before the request
Create request: entrypoint / env may be issued under 'task'
```

So seeing the original template in the Pod spec does not mean that the entry in the request hasn't taken effect; conversely, you also cannot change the request behavior by modifying the Pod spec. When reading the status, you need to look at the CR, the Pod, and the task simultaneously.  

### Reading status: look at quantity, health, and reasons separately  

| Field | Indicates | Do not use it to answer |
| --- | --- | --- |
| `replicas` / `allocated` / `ready` | Progress in quantity | Whether the business task succeeded |
| `phase` | Overall operational health | Whether a single command succeeded |
| `conditions` | Why it changed this way | Whether the current spec has taken effect |

Common items in `conditions` include `Ready`, `Progressing`, `PoolAllocationPending`, `PodFailed`. To determine if a condition corresponds to the current spec, check whether `observedGeneration` has caught up with `metadata.generation`. The status of an old generation may just be a historical snapshot.  

### Two types of workload providers  

Kubernetes runtime 1.1.1 supports two types of workload providers:  

- `batchsandbox` (default): CRD controller mode, the main topic in this stage.  
- `agent-sandbox`: uses `Sandbox` CR with `[agent_sandbox]` configuration; `shutdown_policy` can optionally be `Delete` or `Retain`.  

Both share `[kubernetes]`'s connection, timeout, and rate-limiting configurations, but the template source and lifecycle details differ. When you see `Sandbox` CR instead of `BatchSandbox` in the documentation, first confirm the provider and do not mix them up.  

## Step 4 · Pool: Change 'waiting to start' to 'waiting for capacity'  

Pool does not solve the problem of 'making the image smaller', but separates the creation process into two stages:

```text
Prepare in advance Pod (cost paid in advance)
  -> Only perform allocation and a small amount of injection when a request arrives
  -> Return according to the recycling strategy after use
```

### Two-Level Capacity

Core fields of `PoolSpec`:

| Field | Meaning | What are you optimizing |
| --- | --- | --- |
| `bufferMin` / `bufferMax` | Available free buffer upper and lower bounds at any time | Cold start latency |
| `poolMin` / `poolMax` | Upper and lower bounds of the entire Pool's capacity | Total cost and expansion limit during failures |
| `scaleStrategy.maxUnavailable` | How many Pods can be temporarily unavailable during scaling | Scaling speed and stability |
| `updateStrategy.maxUnavailable` | Unavailable budget during rolling updates when the template changes | Service capability during upgrades |
| `recycleStrategy` | Handling after returning: `Delete` / `Restart` / `Noop` | Reuse speed and contamination risk |

Intuition:

```text
bufferMin What I bought is 'ready to use'
Bought the 'won't inflate infinitely when bad'
recycle   Decide 'how to deal with what the previous user left behind'
```

`Restart` is faster than `Delete`, but requires you to accept the same Pod being reused; `Delete` is cleaner, but you have to go through scheduling and startup every time. There is no default correct answer here, only the business tolerance for 'residual isolation.'

### Pool exhaustion: waiting, 429, and the 30 seconds not to misinterpret

When there are no available slots, the complete path is:

```text
controller: write PoolAllocationPending on BatchSandbox while waiting
            The reason is commonly PoolCapacityExhausted, and it is rechecked periodically
server: Wait for capacity within pool_acquisition_timeout_seconds (default 30s)
            Still not released -> Mapped to retryable HTTP 429 + Retry-After semantics
```

Two precise details are often misstated:

1. **This 30 seconds will not extend the creation timeout.** The configuration documentation clearly states that the Pool wait "does not extend the creation timeout." The 60-second creation budget still constrains the overall process.
2. **Slots released within the wait window may still satisfy the original request.** Therefore, a 429 is not a "permanent failure," but it should not be immediately retried without limit.

The client strategy should be: respect `Retry-After`, add jitter, set an overall budget, and after multiple failures, degrade to normal creation or report capacity insufficiency to the user.

### API Constraints Brought by the Pool

- Pool Pods exist before requests and **cannot** inject arbitrary `networkPolicy` or `volumes` for a single request; these must be fixed according to the Pool template.
- Pool Pods must meet task contracts: manageable by task-executor, equipped with execd, and with correct bootstrap entry. Otherwise, "Pod can start" does not equal "Lifecycle API can be used." 
- When network policies need to differ per request, a direct creation template should be used, or different Pools prepared for different policies.

## Step 5 · Pause and Snapshot: Retention Boundaries Determined by the Backend

This is the easiest place to make mistakes across runtimes. Even with the same `pause()`, the semantics are completely different for the two backends:

| Aspect | Docker | Kubernetes (default rootfs mode) |
| --- | --- | --- |
| Action | Freeze container | Submit root filesystem as OCI image, release Pod and Pool allocation |
| Memory | Retained (process suspended) | **Not retained** (rebuild on restore) |
| Resource usage | Still occupies CPU/memory quota | Releases runtime resources, keeps image storage |
| Endpoint | Usually unchanged | May change, requires re-resolution |
| Credential Vault | Sidecar memory remains | **Lost**, must re-inject after restore |
| Restore | Unfreeze | Rebuild runtime environment from snapshot image |

```text
Pause: Running -> Pausing -> Paused -> Resuming -> Running
```

"The files are still there, but the variables are gone" is not a malfunction, but the definition of a rootfs snapshot: it saves the **file system**, not the **runtime memory**. Scenarios that require preserving the Guest memory are where capabilities like QEMU VMState come into play, and they also come with additional compatibility and node requirements.  

### Snapshot states need to be read in two layers

```text
Public API: Creating / Ready / Failed / Deleting
Inside the controller: Pending -> Committing -> Succeed / Failed
```

Internal `Succeed` and public `Ready` are not contradictory, but are two layers of state machines. The troubleshooting order should be to check internal resources first, then the public layer:

```text
kubectl -n <ns> get sandboxsnapshot <name> -o yaml
kubectl -n <ns> get job,pod -l sandbox.opensandbox.io/sandbox-snapshot-name=<name>
kubectl -n <ns> logs job/<commit-job-name> --all-containers
```

Common failure levels:

- `Pending` Stuck: source Pod not found, source node mismatch, commit Job cannot be scheduled.
- `Committing` Failed: image repository unreachable, push secret error, commit timeout.
- After recovery `ImagePullBackOff`: pull secret or snapshot image address incorrect.
- Lost process state after recovery: expected behavior in rootfs mode.

Two additional hard constraints: Pause/Resume currently only supports a single replica (`replicas=1`); restoring from a snapshot will create a **new sandbox ID**, not revive the old ID in place.

## Step 6 · FastSandbox: Template fixed, requests only express intent

FastSandbox is not positioned as "faster Docker," but as **moving scheduling, watch propagation, and kubelet path out of the hot path for creation**.

### Routing: It is hidden inside the Kubernetes runtime

Under `runtime.type = "kubernetes"`, `CompositeSandboxService` sorts based on two signals:

```text
Request with templateId        -> FastSandboxService
The existing sandbox id is fsb- -> FastSandboxService
The rest                      -> KubernetesRuntime (BatchSandbox path)
```

Both of these signals are indispensable: when creating, look at `templateId`, for subsequent operations, look at the ID prefix. So issues like 'the template sandbox was created successfully, but a different path was taken during deletion' essentially stem from inconsistent routing signals.

### Template: build first, then place the order

```text
Create template (image, entry, resources, guest wiring)
  -> Asynchronous build: Pending -> Building -> Succeeded / Failed
  -> Only templates with Succeeded can create a sandbox
  -> Create a request with only templateId, TTL, metadata, networkPolicy, etc.
```

Hard constraints must be remembered:

- `create_from_template()` must explicitly provide a TTL and cannot use `timeout=None` to bypass expiration management.
- Cannot carry per-request `image`, `env`, `resource`, `entrypoint`, or `volumes` at the same time.
- The template sandbox **does not** have a sandbox-side Credential Vault; key capabilities cannot be assumed to be reused across backends.

These constraints are not 'temporarily not done,' but are prerequisites of the template pattern: the template is an **immutable golden image**, and requests only express intent. To change the runtime shape, construct a new template instead of modifying it in the request.

### Component Division of Work

| Component | Responsibility |
| --- | --- |
| FastPath | Control plane and real-time operation entry |
| CRD | Save persistent intent, can be restored after a crash |
| Fastlet | Provides pre-warmed running capacity |
| runtime agent | Manage the Firecracker lifecycle |
| template builder | generate immutable golden image |
| janitor | Clean up orphaned resources from failed operations |

It is fast because the hot path is short; it is expensive because an entire set of components needs to be deployed, monitored, and troubleshooted. Before choosing it, make sure your bottleneck is really the creation latency, not the image size or the network.

## Step 7 · Isolate the Runtime: It's the boundary that changes, not the interface

`[secure_runtime]` Asking you to change the sandbox from a 'container with a shared kernel' to 'stronger boundaries':

| type | Docker mapping | Kubernetes mapping | boundary | main cost |
| --- | --- | --- | --- | --- |
| `""` (runc) | Default | Default | Shares host kernel | Fastest, weakest isolation |
| `gvisor` | `runsc` | RuntimeClass `gvisor` | User-space kernel (syscall interception) | System call overhead, partial feature incompatibility |
| `kata` | `kata-runtime` | RuntimeClass `kata-qemu` | Lightweight virtual machine | Slower to start, requires node support |
| `firecracker` | Not supported | RuntimeClass `kata-fc` | MicroVM | **Kubernetes only**, RuntimeClass must be explicitly specified |

It's also worth knowing the configuration validation rules:

- When `type` is empty, both mapping fields must be omitted.
- `firecracker` must provide `k8s_runtime_class`.
- `gvisor` / `kata` Provide at least one mapping for either Docker or K8s.
- At startup, it will check whether the RuntimeClass exists; if it does not exist, an error will be reported or a clear warning will be given.

The most important limitation: **a server process has only one `[secure_runtime]` profile, and API requests cannot select isolation levels based on the sandbox.** If multiple isolation levels are needed within the same cluster, multiple server instances must be deployed, each providing its own address externally.

There are two more compatibility red lines:

- gVisor's netstack does not support the egress redirection mechanism, so configuring egress will not work as expected.
- Transparent service mesh sidecar and egress conflict when in the same network namespace, and cannot be treated as a default combination that can be stacked.

## Step 8 · Capability Matrix and Selection Decision Tree

Compress the previous content into a table. `condition` indicates 'interface is supported, but prerequisites in the backend/configuration must be met.'

| Capability | Docker | Kubernetes | FastSandbox |
| --- | --- | --- | --- |
| Create/Delete/Query | Supported | Supported | Supported (templateId path) |
| Public/host endpoint resolution | Supported (port mapping) | Requires ingress solution | Provided by FastPath |
| Custom Image | Supported | Supported | Only through template |
| Per request env/entrypoint | Supported | Supported (direct template or task) | Not supported |
| TTL / renew | Supported | Supported (`expireTime`) | Supported (TTL must be provided when creating) |
| pause / resume | Freeze container, retain memory | rootfs snapshot, memory not retained by default | Supports pause/resume, includes `idlePolicy` automatic path |
| File System Snapshot | Not Primary Path | Supported, Single Copy | Template/Image Path |
| Pool Preheating | None | Supported | Preheating capacity provided by Fastlet |
| egress `networkPolicy` | Condition: `bridge` mode | Supported (declare at creation) | Condition: template/pool preset policy |
| Credential Vault | Condition: `dns+nft`   Creation Policy | Condition: Same as above, and not a template sandbox | Template sandbox not supported |
| Multi-instance sandbox | Not applicable | `replicas` Supported | According to FastSandbox capabilities |
| Strong Isolation | Condition: `runsc`/`kata-runtime` | Condition: RuntimeClass | Built-in Firecracker |
| Cross-node scheduling | None | Supported | Handled by Fastlet pool |

When choosing a model, you can ask yourself in this order:

```text
1. Just local verification/development? -> Docker
2. Need multi-tenancy, scheduling, elasticity, snapshots? -> Kubernetes
3. Is creation latency a key metric, and is the workload shape fixed? -> Kubernetes + FastSandbox template
4. Need hard isolation? -> First set secure_runtime, then confirm node/RuntimeClass support
5. Need a different network or volume for each request? -> Don't use Pool; create directly or use pooling
```

## Step 9 · Deployment Order and Prerequisites (Only Look at Runtime-Related Parts)

Official Order on Kubernetes:

```text
base(CRD + RBAC)
  -> opensandbox-controller
  -> fast-sandbox (optional)
  -> ingress-gateway (Kubernetes required)
  -> opensandbox-server
  -> opensandbox-node-agent (optional)
```

Order is not formalism:

1. Without CRD, the controller has no observable objects.
2. The controller must first be able to reconcile `BatchSandbox`, `Pool`, `SandboxSnapshot`.
3. When enabling fast-sandbox, it must be before the server because the server connects to FastPath and watches related resources on startup.
4. The gateway must be ready before the server so that the server can get the correct address from the first startup.
5. The server is installed last to avoid false failures like 'the backend does not exist at startup'.

Two easy-to-overlook configuration facts:

- The `ingress-gateway.enabled` of the umbrella chart defaults to `false`, even though Kubernetes deployment requires ingress. Do not assume that "the chart is installed" means "routing is enabled".
- When `kubernetes.namespace` is not filled, default behavior is used; in production, the workload namespace should be explicitly specified and aligned with RBAC.

## Step 10 · Experiment

> Note: When the author wrote this set of notes, there was no running Docker daemon or Kubernetes cluster in the environment. The following D series can be completed on a machine with Docker; the K series requires a disposable test cluster. The writing environment **did not execute** them. When reading, please separate "commands exist" from "verified locally".

### Experiment D1 · See "Sandbox = Container   Label   Port"

Start the server with `runtime.type = "docker"`, create a sandbox, and then on the host machine:

```bash
docker ps --format '{{.ID}}\t{{.Image}}\t{{.Ports}}\t{{.Names}}'
docker inspect <container-id>
```

Observe three things: whether the image is the one you requested, whether the port mapping falls within `docker.port_range_min`–`docker.port_range_max`, and whether the container's network mode is `host` or `bridge`. The purpose of this step is not to memorize fields, but to build the intuition that "there really is a concrete object under the API." 

### Experiment D2 · Cause a capability condition failure

Set `docker.network_mode` to `host`, and then create a sandbox with `networkPolicy`. The expected result is rejection, not silent ignoring.

Copy down the failure message, then change back to `bridge` and retry. You should be able to explain in your own words: **why this combination is not allowed**, and what security consequences would arise if the platform chose to "ignore the policy and allow it anyway."

### Experiment K1 · Observe the three-layer state of creation (requires a cluster)

While creating the sandbox, in another terminal loop:

```bash
kubectl -n <ns> get batchsandbox -w
kubectl -n <ns> get pods -w
```

Record three time points: CR appears, Pod Ready, and first command succeeds. The difference between these three is the part you need to optimize when planning capacity later. 

### Experiment K2 · Simulation once deduces pool exhaustion (requires clustering)

Set `bufferMin` to 1, `poolMax` to 1, and create 3 sandboxes concurrently. Expect to see one success, the rest enter `PoolAllocationPending`, and after waiting for the window, receive 429. 

If there is no cluster for now, use paper simulation: write the moment the controller writes the condition, the server starts waiting, the moment 429 returns, and which request will be satisfied after the first sandbox is released. **Being able to write the timeline correctly is more valuable than running it through.** 

### Experiment K3 · Snapshot Reading Fails Once (Cluster Required)

Create a sandbox, write a file, pause, then check the internal phase and commit job logs of `sandboxsnapshot`. Then deliberately mismatch the push secret and observe whether the failure falls on `Pending` or `Committing`. 

### Experiment S1 · Verification secure_runtime startup verification

In the configuration, write `type = "firecracker"` but not `k8s_runtime_class`, start the server, expecting configuration validation failure. Then write a non-existent RuntimeClass to observe whether it is "startup failure" or "startup warning, creation failure." 

The significance of this experiment is to help you distinguish between **configuration period errors** and **runtime errors**: the earlier it fails, the easier it is to locate. 

## Quick Fault Inspection

| Phenomenon | What to check first | Common root causes |
| --- | --- | --- |
| Create Timeout | `sandbox_create_timeout_seconds`, Pod events | Slow image pull, scheduling failure, execd not ready |
| 429 | `PoolAllocationPending` reason/message | Pool exhaustion, Pool Pod not Ready, selector mismatch |
| Restore 401 after pause | Vault injection, network policy | The key is only in sidecar memory and is not reinjected after restoration |
| Variable loss after recovery | Backend and snapshot mode | rootfs snapshots do not save memory, which is expected |
| After recovery `ImagePullBackOff` | pull secret, image address | Snapshot image push successful but pull credential missing |
| `networkPolicy` Rejected | `network_mode` / Pool mode | Docker is not a bridge, or a pool pre-created cannot be injected on request |
| Outbound policy abnormal under gVisor | `[egress]` and `secure_runtime` | netstack does not support this redirect mechanism |
| Template creation failure | Template phase, builder log | Template not `Succeeded`, or the request contains a per-request field |

## Common Misconceptions

| Misconceptions | Correction |
| --- | --- |
| "FastSandbox is the third type of `runtime.type`" | It is a service branch under `kubernetes`, relying on the `templateId` / `fsb-` prefix routing |
| "Pausing to save some resources" | Docker freezes but still occupies resources; K8s releases resources but does not retain memory |
| "If a pool has a Pod, it must have capacity" | Check Ready, whether it's occupied, `status.available`, tag selector |
| "A successful snapshot can restore the process as it is" | By default, only the file system is restored; Memory requires additional capabilities such as VMState |
| "Configuring gVisor automatically makes it safer" | Stronger boundaries, but narrower compatibility; egress/network solutions need to be revalidated |
| "If the interface has `credential_vault`, it means all backends have it" | Template sandboxes do not have sandbox-side vaults; Pools are also constrained by pre-creation |
| "429 is a server-side bug" | It is a capacity semantic, and should be handled as a retry error and respected `Retry-After` |

## Self-Check and Reference Answers

**1. Why is it said that "unified interfaces do not equal capability"?** 

Because `SandboxService` the unified feature is call shape, not backend capability. Docker has no pool or scheduling, K8s pause is snapshot semantics, and FastSandbox does not allow image modification per request. To determine whether a feature is usable, you need to look at the runtime, configuration, version, and image. 

**2. `runtime.type`, `secure_runtime.type` What is the relationship among FastSandbox?** 

`runtime.type` Decide where the resource is (Docker/Kubernetes); `secure_runtime.type` Decide the isolation boundary (runc/gVisor/Kata/Firecracker); FastSandbox is a service path within Kubernetes that streams requests by signature. The three are different dimensions and cannot replace each other. 

**3. Why does pool exhaustion first show `PoolAllocationPending`, instead of directly 429?** 

Because 429 is the external mapping of the server layer. The controller first writes "I am waiting for capacity" into the CR condition, and the server waits within a limited window. Only when the window ends with no capacity does it switch to 429. This way, requests waiting still have a chance to be satisfied by the freed slot. 

**4. What is the relationship between `pool_acquisition_timeout_seconds` and `sandbox_create_timeout_seconds`?**

The former is the maximum waiting pool capacity, while the latter is the overall budget for creation; The former does not extend the latter. Both must be considered; you can't just increase one and expect a longer wait. 

**5. Why do variables in the process disappear after Kubernetes pauses and resumes?** 

Because the default rootfs snapshot is submitted as a file system image, the container is rebuilt during recovery. Processes and memory are not saved. To retain Guest memory, additional VMState capabilities are required and are subject to node compatibility constraints. 

**6. Why are internal `Succeed` and public `Ready` inconsistent?** 

They are two-layer state machines. The controller first completes the submission, and the public layer also completes steps such as image pulling and endpoint publishing. During troubleshooting, first check internal resources, then public status, and use `observedGeneration` to determine whether the state matches the previous spec. 

**7. Why can't template sandboxes include per-request `image` or `env`?** 

Templates are immutable golden images; requests only express "which template to use, to whom, for how long, and what network policy." Allowing image modification would compromise reproducibility and consistency in constructed products. To change shape, build a new template. 

**8. Can a cluster have both gVisor and Kata sandboxes at the same time?** 

Yes, but you cannot switch between the same server instance on request. A server process has only one `[secure_runtime]` profile; if multiple isolation levels are needed, multiple server instances or different entry points must be deployed. 

**9. What is the shortest judgment when choosing between Docker and Kubernetes?** 

Use Docker for "standalone, observable, and quick modifying"; Use Kubernetes for "multi-tenancy, scheduling, pooling, snapshot, and convergence". When latency is the core metric and the shape is fixed, consider the FastSandbox template. 

## Key Source Code Coordinates

| Questions to answer | Let's look at |
| --- | --- |
| Unified Interfaces and Backend Implementation | `server/opensandbox_server/services/sandbox_service.py`, `docker/`, `k8s/` |
| FastSandbox Router | `server/opensandbox_server/services/composite_service.py` |
| Runtime and isolation configuration | `server/configuration.md` of `[runtime]`, `[docker]`, `[kubernetes]`, `[secure_runtime]` |
| Isolation Runtime Mapping and Startup Validation | `server/opensandbox_server/services/runtime_resolver.py` |
| BatchSandbox Fields and Conditions | `kubernetes/apis/sandbox/v1alpha1/batchsandbox_types.go` |
| Pool Capacity and Recycling | `kubernetes/apis/sandbox/v1alpha1/pool_types.go` |
| Snapshot phase and format | `kubernetes/apis/sandbox/v1alpha1/sandboxsnapshot_types.go` |
| Controllers and Distributors | `kubernetes/internal/controller/`, `allocator.go`, `internal/scheduler/` |
| Deployment Sequence and Helm Values | `docs/deployment/index.md`, `manifests/charts/opensandbox/values.yaml` |
| Pause of Reinstatement | `docs/guides/pause-resume.md` |
| FastSandbox Design | `docs/architecture/fast-sandbox/index.md`, `templates.md`, `scheduling.md` |

## After finishing

You should now be able to answer the four "bug-like phenomena" at the beginning of this stage, and be able to mark both "which backend supports" and "what conditions are needed" on a single table. This is the core judgment of the runtime layer. 

The next stage changes the axis: the resource is running, **how to access it externally, how it accesses externally, how to avoid the key entering the sandbox**. On the same runtime, the network and credentials are layered with another layer of conditions. 

With this question in mind, let's move on to the next chapter: **"The sandbox is ready, so why say it 'can safely connect'?"** Enter [Stage 5](../stage-5/).
