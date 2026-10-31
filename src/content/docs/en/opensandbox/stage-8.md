---
title: "Stage 8: Engineering and Production"
description: "Multi-tenancy, testing, metrics, release, and rollback: from being able to run to daring to go live."
---

> This stage's questions: How do multi-tenants remain isolated? How to prevent resource leaks? Up to which layer should testing be done? How to locate issues when something goes wrong? What must be verified before release?
> Expected 4–5 days. The core deliverables are a **production readiness review checklist** and a set of **tiered troubleshooting processes**.

## Why this step is needed

In the first seven stages, you have been focused on "making one thing succeed": successful creation, successful execution, successful networking, successful Agent operation.

The production environment brings another set of questions:

```text
100 tenants share one server, can tenant A see the sandbox of B?
A Agent crashed, is the sandbox still being charged?
Are quota exhaustion and 429 the same thing?
After upgrading the controller, can the old BatchSandbox still be managed?
If you call the police at 2 a.m., which indicator does the person on duty check first?
```

These issues have a common characteristic: **they are all off the 'normal path'**. The normal path is covered by functional testing, while the exceptional path is covered by engineering measures. Engineering measures include: isolation models, quotas, test layering, observability, release processes, and rollback plans.

A harsh judgment criterion:

> If you can't clearly explain 'what to look at when things go wrong, how to contain the damage, and how to roll back,' then it is not yet production-ready.

## An analogy: from a model room to a chain hotel

```text
Stage 0–7: Showroom
  A room that can accommodate people, with water, electricity, and internet all functioning

Stage 8: Chain Operations
  The key cards for each room are not interchangeable (tenant isolation)
  Hydropower and electricity have meters and quotas (resource management)
  Someone inspects (monitors) every day
  Malfunction has SOP (Diagnosis and Loss Limitation)
  Changing furniture does not affect residents (release and rollback)
```

Model rooms rely on 'visible correctness,' chains rely on 'invisible constraints.'

## Step 1 · Write a Threat Model First

Security configurations without a threat model are usually just 'pile switches.' Start by listing assets and attack surfaces:

| Asset | Who Threatens It | Existing Controls | Residual Risk |
| --- | --- | --- | --- |
| Host/Node | Escape from sandbox, malicious images | Isolated runtime, capability dropping, seccomp/AppArmor | Kernel vulnerabilities, misconfiguration |
| Other tenants' data | Unauthorized access, ID guessing | Namespace isolation, tenant tags, 404 hiding | Tag omissions in shared namespace |
| Credentials/Model keys | Prompt injection, reading environment variables | Credential Vault, egress whitelist | Sidecar/control plane compromised |
| Network and data | Data leakage | Default deny, target whitelist | Whitelists too broad, DNS bypass |
| Image supply chain | Malicious base image, tag drift | Fixed digest, private registry, scanning | Runtime pull policy too loose |
| Cost | Sandbox leaks, unlimited renewal, idle pool | TTL, quotas, budget, inspection | Orphaned resources, abnormal retries |

The purpose of writing a threat model is not to 'list everything,' but to ensure that each control has a corresponding **asset** and **residual risk**. A control without residual risk usually means it wasn't thought through.

### Three Highest Priority Controls

1. **Default deny outbound**: Data leakage is the most realistic loss in Agent scenarios.
2. **Tenant-level namespace quotas**: Unauthorized access and resource contention converge here.
3. **TTL cleanup inspection**: Leaked sandboxes are both a cost and a potentially accessible execution environment.

## Step 2 · Multi-Tenancy: One Server, Multiple Namespaces

OpenSandbox's multi-tenant model is straightforward:

```text
API key -> TenantEntry -> Tenant Namespace
All lifecycle operations are automatically limited to this namespace
```

### Working Methods

```text
Request to bring OPEN-SANDBOX-API-KEY
  -> Configured tenant provider?
       Yes -> Use key to check tenant
             Found -> Inject tenant context, route to the corresponding namespace
             Not found -> 401
       No -> Revert to single tenant server.api_key
```

Specific behaviors:

- Each tenant has a **pre-created** Kubernetes namespace (created by the cluster administrator).
- Creation, listing, querying, and deletion are all executed within the scope of the tenant's namespace.
- Listing only returns the sandboxes of the current tenant.
- In multi-tenant mode, proxy routing `/sandboxes/{id}/proxy/...` also requires an API key.
- When creating, a `opensandbox.io/tenant=<name>` label will be applied to the workload; when multiple tenants share a namespace, list/get/delete/proxy operations will hide sandboxes with labels from other tenants (return HTTP 404).
- Historical sandboxes without labels are still visible until they expire — this is a window to pay special attention to during migration.

### Prerequisites and hard limits

| Condition | Description |
| --- | --- |
| `runtime.type = "kubernetes"` | Multi-tenancy relies on namespace isolation |
| **Docker not supported** | If Docker is configured and tenants are enabled, the server will refuse to start (fatal) |
| Namespace pre-created | The server will not create tenant namespaces for you |
| RBAC allows cross-namespace | The default Helm RBAC already includes the corresponding ClusterRole |
| Recommended to configure ResourceQuota / LimitRange | Prevent a single tenant from occupying the entire cluster |
| Recommended to configure egress sidecar resources | Prevent the sidecar from becoming a resource black hole |

### Tenant provider and rotation

- `file` provider: local TOML, suitable for a single cluster with infrequent changes.
- `http` provider: remote endpoint, suitable for centralized management.
- Both support hot reload and key rotation; during rotation, ensure the **old and new keys have an overlap window**, otherwise running clients may suddenly receive 401 errors.

### Clarify the boundaries of the isolation model

Multi-tenant isolation is for **control plane visibility and namespace resources**, not a "strong security boundary":

- Sandboxes on the same node still share the kernel (unless gVisor/Kata/Firecracker is enabled).
- Network isolation relies on egress/NetworkPolicy, it is not automatically provided by namespaces.
- Platform administrators can still operate across tenants.

Include these three points in your security description, which is more credible than just writing "supports multi-tenant isolation."

## Step 3 · Resource governance: Four accounts

In production, four accounts must be managed simultaneously:

```text
1. Single sandbox account: resourceLimits, disk, number of processes
2. Tenant Account: ResourceQuota, LimitRange, Concurrent Sandbox Number
3. Pool accounting: bufferMin/bufferMax, poolMin/poolMax, idle costs
4. Time accounting: TTL, renew, idle pause, orphan cleanup
```

### Single Sandbox and Tenant

- The resource limits in creation requests are an "application," not a "guarantee"; node capacity and quotas are the hard constraints.
- When a quota is exhausted, the manifestations may be creation failure, waiting, or 429; this should be distinguished from Pool exhaustion (look at the reason and request path).
- `LimitRange` can provide a safety net for Pods with undeclared resources, avoiding "a single request consuming the entire node".

### Pool Accounting

The buffer of the Pool is **buying delay with money**:

```text
The larger it is -> the fewer cold starts -> the higher the idle costs
poolMax   The bigger -> the stronger the resistance to emergencies -> the more drastic the expansion during a failure
```

In production, the buffer should be calculated based on "peak concurrency × acceptable cold start ratio" rather than just picking a number.

### Time Accounting

| Mechanism | Purpose | Note |
| --- | --- | --- |
| TTL | Absolute expiration, control plane cleanup | Default 10 minutes; the maximum timeout set at creation does not apply to renew |
| renew | Extend/shorten expiration time | Should only renew when progress is made |
| `automation.idle_pause` | Idle auto-pause/wake | Only effective for fast sandboxes that declare `lifecycle.idlePolicy` |
| Orphan cleanup | Clean up residues of failed operations | Relies on finalizer/janitor and inspection |

`automation.idle_pause` is not a "global resource-saving switch." For sandboxes without `idlePolicy`, this configuration is completely ineffective.

### Costs should be evaluated in three areas

- **Runtime**: Idle pool, leaked sandboxes, over-provisioned resources.
- **Storage**: Snapshot images, golden images for templates, logs.
- **Traffic and tokens**: Egress traffic, model calls.

Only focusing on CPU cost usually misses the latter two areas.

## Step 4 · Testing Pyramid: What each layer proves

| Level | Command Example | What it proves | What it does not prove |
| --- | --- | --- | --- |
| Unit | `uv run pytest tests/test_docker_service.py` | Logic of a single module | Behavior of real containers/clusters |
| Controller Unit | `go test ./internal/controller/ -run TestAllocatorSchedule -v` | Convergence logic like allocation, pause/resume | Real scheduling and image pulling |
| Contract | `specs/tests` generate client validation | Consistency between implementation and spec | End-to-end availability |
| Integration (K8s) | `make setup-envtest && make test` | Interaction between controller and API Server | Real nodes, CNI, RuntimeClass |
| Cross-language e2e | `tests/` run by language directory | Consistency between SDK and real server behavior | Production topology and capacity |
| K8s e2e | `make test-e2e` | Creation, pool, tasks, pause/resume | Your production configuration |
| Smoke | `server/tests/smoke.sh` | Minimal closed loop after deployment | Deep regression tests |

### Three principles of layered testing

1. **The lower the layer, the cheaper; the higher, the more trustworthy.** Do not use e2e to cover branches that should be unit tested.
2. **Contract tests are cross-language anchors.** Without them, the five SDKs will drift independently.
3. **E2e must cover failure paths.** E2e tests only for "successful creation" do not prove 429 errors, snapshot failures, or Pod recovery.

### Minimal validation set when changing code

```text
Change server business logic -> Corresponding pytest +  related e2e
Change CRD/controller -> make manifests generate + make test +  related e2e
Modify spec -> Regenerate + contract test + affected languages SDK test
Change Helm/Deployment -> Render verification + Cluster installation + Smoke test
```

Pay attention to CRD generation constraints: if you change the type under `apis/`, you must run `make manifests` and `make generate`, otherwise the CRD YAML and DeepCopy will be out of sync. This kind of "artifact drift" is hard to spot during review, but it will directly break things in production.

## Step 5 · Observability: Logs, Metrics, Tracing, Diagnostics

### Four types of signals

| Signal | Source | Answers what |
| --- | --- | --- |
| Logs | server, controller, execd, egress | What happened at this moment |
| Metrics | server HTTP, controller allocation/capacity, execd, egress | Trends and saturation |
| Tracing | OTel (HTTP, Pool warm-up, etc.) | Which part a request was slow in |
| Diagnostics | Stable logs and events from `osb diagnostics` | Reproducible troubleshooting material |

### Groups of metrics to watch

```text
server: request volume, error rate, latency, 429 ratio
controller: allocation success/failure, Pool available, Pending count
execd: number of commands, number of failures, OOM observations
egress: allow/deny count, DNS latency, failure reason
```

Don't just monitor "whether it exists"; monitor "whether it is sufficient": pool availability, quota remaining, snapshot failure rate, tenant-level concurrency.

### The value of tracking lies across layers

A single creation may span server → K8s API → controller → Pod → execd. Without tracing, you can only guess which part is slow; with tracing, you can see how much time is spent waiting for the pool, scheduling, pulling images, and execd readiness.

Pool warm-up has dedicated tracing support; once enabled, you can pinpoint "why this allocation was slower than the last time."

### Diagnostic entry points

`osb diagnostics` provides stable diagnostic logs and events, suitable for collecting "the minimal reproducible evidence package." `osb devops` is an experimental old entry point, do not include it in new scripts or on-call manuals.

A good diagnostic package should include:

```text
sandbox id / tenant / time window
Request ID and key response code
BatchSandbox conditions (including observedGeneration)
Pod events and container state
Relevant component log snippet (anonymized)
Metric snapshot (Pool available amount, quota balance)
```

## Step 6 · Layered Fault Localization: Define the Scope First, Then Collect Evidence

The most common mistake in production troubleshooting is 'looking at the logs right away.' The correct sequence is to define the scope first:

```text
Layer 1: Client/Authentication 401/403, misconfiguration, key rotation
Layer 2: server           4xx/5xx, 429, timeout, status mapping
Layer 3: Scheduler/Controller      PoolAllocationPending, PodFailed, condition reason
Layer 4: Pod/Container         Scheduling failed, image pull failed, OOM, CrashLoop
Layer 5: execd            ports, health checks, command failures
Layer 6: Network/egress      ingress 404/503/502, policy deny, DNS
Layer 7: Storage/Snapshot        Repository unreachable, push secret, ImagePullBackOff
```

Each layer has 'minimal evidence':

| Layer | Minimal Evidence |
| --- | --- |
| Client | Request ID, status code, response body |
| Server | Structured logs, metrics, 429 ratio |
| Controller | CR conditions, `observedGeneration`, events |
| Pod | `kubectl describe pod`, events, last exit code |
| execd | `/ping`, port listening, command logs |
| Network | Gateway logs, policy hit/deny counts |
| Snapshot | Internal phase, commit Job logs, repository connectivity |

### Stop-loss order

```text
1. Stop expansion: limit flow/pause new creation/close entry
2. Preserve evidence: diagnostic package, log snapshots (before reboot)
3. Restore Service: Rollback/Scale Up/Switch Pool
4. Root Cause: Code/Configuration/Capacity
5. Review: Turn 'what positioning was used this time' into a checklist item for the next time
```

Step 2 is often skipped: once restarted, the evidence is gone. Collect evidence first, then take action.

## Step 7 · Release and Change: Make rollback a default capability

### Versions must align

At least the following versions should be included in a single deployment:

```text
umbrella chart version
server image
controller image
execd image
egress mirror
gateway / fast-sandbox / node-agent images
SDK Version (Client)
```

They do not have to be exactly the same, but must **clearly have a compatible relationship**. It is usually acceptable for the SDK to lag behind the server (tolerating unknown fields), whereas the reverse may result in missing capabilities. Component tags and the umbrella version are not the same level of concept, so don't use one version number for all images.

### Change Order

```text
spec -> deliverables -> implementation -> deployment checklist -> documentation -> release notes
```

Artifacts on the deployment side include CRD YAML, DeepCopy, and Helm rendering results. Modifying the CRD without regenerating it is the most common case of 'works locally but fails in the cluster.'

### Release Strategy

- **First do a canary release for a single tenant/namespace**, monitor error rates, 429s, and Pool availability.
- **Keep the previous version of the image and chart**; rollback should be possible within minutes.
- **Evaluate database/storage changes separately**, do not combine them with image upgrade into a single release.
- **Clearly document destructive changes and migration steps** in the release notes, do not just write 'fixed several issues.'

### Rollback Checklist

Rollback is not just 'replace the image back':

- Is the CRD forward compatible? (New fields are ignored by old controllers, usually safe; deleting fields is dangerous)
- Are snapshot/template formats compatible?
- Will running sandboxes lose connection?
- Does the Pool need to be rebuilt after rollback?

## Step 8 · Production-Ready Review Checklist

Check each item before release; any unanswered item must be marked as blocking:

| Category | Check Item |
| --- | --- |
| Authentication | Is an API key required? Does it support rotation? Is 401 audited? |
| Tenant | Is multi-tenancy enabled? Are namespaces pre-created? Are quotas/LimitRange configured? |
| Isolation | Is gVisor/Kata/Firecracker needed? Was the RuntimeClass validated? |
| Network | Is outbound denied by default? Is the allowlist minimal? Does ingress mode match clients? |
| Credentials | Is Vault used? Could keys enter sandboxes/logs/model context? |
| Lifecycle | Default TTL and upper limit? Renew strategy? Orphan cleanup? |
| Capacity | Basis for Pool capacity? Burst limits? Behavior when quota exhausted? |
| Storage | Snapshot repository, push secret, retention policy, restore drill? |
| Observability | Log fields, key metrics, alert thresholds, trace sampling? |
| Diagnostics | How to collect diagnostic packages? Where is the on-call manual? Has the upgrade path been tested? |
| Release | Canary plan, rollback steps, version compatibility matrix, release notes? |
| Cost | Is someone responsible for runtime/storage/traffic/token accounting? |

### Three 'Vetoes'

1. **Outbound allowed by default** with no audit.
2. **No TTL or cleanup mechanism**, sandboxes can live indefinitely.
3. **No rollback plan**, can only 'fix forward.'

## Step 9 · Experiment

> Note: Unit/contract tests can run locally; K8s e2e, quota, and tenant experiments require a real cluster and have not been executed in this environment. Please mark as 'unverified.'

### Experiment S1 · Run a focused test instead of a full run

```bash
cd server
uv run pytest tests/test_docker_service.py -q
uv run ruff check
uv run pyright
```

Observation: How quickly can a focused test provide feedback; under what circumstances is it worthwhile to run the full suite.

### Experiment S2 · Controller Testing

```bash
cd kubernetes
make setup-envtest
go test ./internal/controller/ -run TestAllocatorSchedule -v
```

If there is no envtest dependency, record the blocking point and do not skip it. 

### Experiment S3 · Contract consistency

Modify (or simulate modification in the replica) spec to regenerate the client, observe: 

- Which languages have diff; 
- Whether the handwriting layer needs to be changed; 
- Whether the contract test failed. 

Don't submit this change; treat it as a "change impact plane" exercise. 

### Experiment S4 · Metrics and tracking

Start the server with `[otel]` configuration, create and execute a task, and confirm: 

- HTTP metrics have data; 
- Pool preheating traces have cross-layer spans; 
- Logs can be linked to requests via trace id. 

### Experiment S5 · Quota Exhaustion (Requires Cluster)

Set a very small ResourceQuota for the tenant namespace, continuously create sandboxes, and observe failure patterns: whether it's 403, creating timeout, or Pending. Distinguish it from the 429 that is exhausted in the pool. 

### Experiment S6 · Tenant Isolation Verification (Requires Cluster)

Create a sandbox using tenant A's key, then use tenant B's key to get/list/delete, expecting 404 or an empty list. Verify again whether the proxy routing also requires a key. 

### Experiment S7 · Diagnostic package drill

Execute `osb diagnostics` on a deliberately failed sandbox to check if the evidence package includes: conditions, events, logs, and indicator snapshots. If another person not involved in troubleshooting only looks at this package, can they give more than half the reason? 

## Quick Fault Inspection

| Phenomenon | Predetermined boundary | Common root cause |
| --- | --- | --- |
| All requests 401 | Authentication layer | Key rotation without overlap, tenant provider not loaded |
| Single Tenant 403/Failure | Quota Layer | ResourceQuota exhaustion, LimitRange conflict |
| Slow but successful creation | Scheduling/Pool | Insufficient buffer, slow image pull |
| 429 Concentrated Appearances | server/Pool | Pool depleted, waiting window to close |
| condition Always Pending | Controller | Source Pod/Node Mismatch, Job Unable to Schedule |
| Pod CrashLoop | Container layer | Entry error, execd startup failure, OOM |
| Inbound 503 | Network Layer | Endpoint not ready, execd not listening |
| Snapshot failure | Storage layer | Warehouse unreachable, push secret error |
| Missing metrics | Observable layer | OTel not enabled, endpoint/protocol mismatch |
| Abnormally rising costs | Time/capacity account | Orphan sandbox, no-progress renewal, pool too large |

## Common Misconceptions

| Misconceptions | Correction |
| --- | --- |
| "Multi-tenant equals strong isolation" | It isolates control surface visibility from namespace resources; Kernel/network boundaries are calculated separately |
| "Docker can also open multiple tenants" | Not supported; enabling it will refuse to start |
| "With TTL, there won't be leaks" | Failure paths and orphan resources still need inspection and cleanup |
| "The more tests, the safer" | When layering is missing, heap e2e will only be slower and more unstable |
| "No need to regenerate CRD after modifying" | CRD YAML/DeepCopy drifts, causing cluster errors |
| "Restart and then see" | Restarting will destroy evidence, so collect evidence first |
| "Just monitor the CPU and it's enough" | You also need to look at pool availability, quota balance, snapshot failure rate, 429 |
| "Rollback means changing the image" | CRD/storage/running sandbox may all have compatibility issues |

## Self-Check and Reference Answers

**1. Why do multi-tenants require Kubernetes runtime?** 

Because isolation depends on namespace, RBAC, and quotas, which are primitives of Kubernetes. Docker does not have a corresponding model, so when enabling tenants, it directly refuses to start. 

**2. Why does proxy routing also require an API key in multi-tenant settings?** 

Otherwise, someone who knows the sandbox ID can bypass the tenant boundary to access the sandbox port. The proxy is the data surface entry point and must perform tenant authentication just like the lifecycle. 

**3. When tenants A and B share a namespace, how can they avoid seeing each other?** 

When created, tag `opensandbox.io/tenant=<name>`, list/get/delete/proxy filter by tag, and other tenants' sandboxes return 404. Untagged historical sandboxes are still visible before expiration and require migration plans. 

**4. Why is contract testing irreplaceable in the testing pyramid?** 

It directly verifies consistency between implementations and specs, serving as a common anchor for cross-language SDKs. Unit testing shows no contracts, and E2E is too slow and lacks coverage. 

**5. What must be done after changing the CRD type?** 

Run `make manifests` and `make generate`, synchronize CRD YAML with DeepCopy, then run controller testing. Changing only Go types will cause cluster behavior to be inconsistent with code. 

**6. Why should we first define boundaries before collecting evidence?** 

Evidence varies completely across layers. First, determine whether it is authentication, server, controller, Pod, execd, network, or storage before obtaining the correct evidence; Otherwise, time will be wasted on the error layer. 

**7. Why is "rebooting first" a bad habit?** 

Restarting will clear container status, events, and temporary logs. The correct order is to collect diagnostic packets and log snapshots first, then cut losses. 

**8. Which versions should be considered together at launch?** 

chart, server, controller, execd, egress, gateway/fast-sandbox/node-agent, and client SDK. They do not have to be the same version, but must have a clear compatibility matrix. 

**9. What are the three veto items for production readiness?** 

By default, outbound is allowed without any audits, no TTL/cleanup mechanism, and no rollback plan. 

**10. Which four ledgers should be used to calculate costs?**

Single sandbox resources, tenant quotas, pool buffering, time (TTL/renew/idle pause), plus storage, traffic, and tokens.

## Key Source Code Coordinates

| Question to answer | First look at |
| --- | --- |
| Multi-tenant model and configuration | `docs/guides/multi-tenancy.md` |
| Network isolation scheme | `docs/guides/network-isolation.md` |
| Telemetry and metrics | `docs/guides/telemetry.md`, `docs/sdks/observability.md` |
| Lifecycle hooks | `docs/guides/lifecycle-hooks.md` |
| Pod provisioning failure recovery | `docs/guides/pod-recovery.md` |
| Deployment and operations | `docs/deployment/index.md`, `docs/deployment/ack.md` |
| Server testing | `server/tests/`, `server/AGENTS.md` |
| Controller testing and e2e | `kubernetes/AGENTS.md`, `kubernetes/test/e2e/` |
| Cross-language e2e | `tests/` |
| CRD generation constraints | `kubernetes/AGENTS.md` |

## After completion

You should now be able to answer "what gives this system the confidence to go live," and be able to produce a checkable list instead of just saying "tested it." 

The next phase is consolidation: merging all previous capabilities into a complete project—Data Analysis and Reporting Agent. It will involve lifecycle, execution, runtime, network, credentials, SDK, and engineering components. What you need to do is not to learn new APIs, but to prove that you can organize these constraints into a deliverable system.

Take this question into the final chapter: **"If you were to deliver a sandbox Agent from scratch, how would you prove it is correct?"** Move on to [Stage 9](../stage-9/).
