---
title: "Stage 1: How to cross the platform in one go"
description: "Follow a task through the control plane, data plane, and runtime to build a system map."
---

> Corresponds to [Learning Route](../learning-path/) Stage 1 (Core · 2–3 days). This stage does not aim to read the entire source code, but rather to build the ability to "know which layer it belongs to at every call." 
> Source directory: `$OSB_SRC`. All paths are relative to this directory. 
> Core outputs: one system diagram, one creation sequence diagram, one execution sequence diagram, and one list of failure points. Diagrams should be drawn by hand, not saved for existing ones. 

## 1. What exactly needs to be solved at this stage?

At the end of Stage 0, you have made a minimal link work really: `Sandbox.create` → container starts → commands output → `destroy`. 

But what you see is still a "working black box." Once it slows down or fails, problems immediately arise: 

- Creation freezes for 30 seconds—is it because the image wasn't pulled down, Pod hasn't been scheduled, or execd hasn't started? 
- Command report `404`: Is the sandbox missing, or is the port not listening, or did the router go to the wrong entrance? 
- Everything is normal in the server log, but why can't the client connect? 
- A colleague says, "Add a network policy," but you don't know whether to change server configuration, sandbox requests, or the cluster's CRD. 

The common thread among these questions is: **You don't know how many layers you've passed through in one call, so you don't know which layer to go to find the answer.** 

This stage is about building this map. After learning, you should be able to answer three questions for any single call: 

1. From which entrance does it come in? 
2. At which level is it handled, and where are the facts recorded? 
3. Which path does its result take to return, and where should you look first if it fails? 

At this stage, don't dig deep into the state machine, don't expand runtime implementations, don't design network strategies—those are stages 2, 4, and 5 respectively. Here, only one thing is done: **Clearly draw boundaries.** 

## 2. First, use a metaphor to build the framework

Think of OpenSandbox as a "Dispatch Workspace" service: 

| Metaphor | Corresponding component | What is it responsible for |
| --- | --- | --- |
| Customer | Application / Agent | Present "I want to perform this action" |
| Front Desk and Dispatch Center | Lifecycle Server | Authentication, Registration, Assignment of Workspaces, Management Period |
| Supplier | Docker / Kubernetes / FastSandbox | Truly building the workspace |
| Workspace | Container / Pod / Microvirtual Machine | Isolated Runtime Environment |
| The foreman in the workshop | execd | Receive commands, files, and code requests and execute |
| Built-in counters in the workspace | User workloads on their own ports | Providing business services, such as the 8080 |
| Main Gate and Access Control | ingress | How to find a certain workspace for external traffic |
| Logistics Security Inspection | egress sidecar | What can be sent and received from the workplace?
| Contract | `specs/` | Fixed interface agreement between the customer and the platform |
| Monitoring and Ledger | Status, SSE, Logs, Metrics, Auditing | Proof that "Things Really Happened" |

There's something in this analogy that needs to be corrected immediately: **The dispatch center doesn't transfer your daily calls to the workplace.** ** 

Creating a sandbox must go through the frontend; After creation, the application receives the direct contact information (endpoint) for the workspace, and subsequent commands, files, and code requests go directly to execd without going back to the frontend. If you misunderstand this, the subsequent layout will be completely wrong. 

## 3. Six practical planes plus two cross-sections

There are many warehouse directories, but they are divided into only six categories by "responsibility plane." From now on, every time a file is opened, first ask which plane it belongs to: 

| Practical Aspect | Problems to Be Solved | Main Contents | You will encounter |
| --- | --- | --- | --- |
| Client Side | How Applications Use the Platform | `sdks/`, `cli/` | `Sandbox`, `osb`, MCP tools |
| Contract Aspect | How to Decouple Client and Backend | `specs/` | Four OpenAPI and error model |
| Lifecycle Control Plane | When to create, renew, or delete environments | `server/` | FastAPI routing `SandboxService` |
| Runtime backend | Where do resources actually appear | `server/.../docker`, `server/.../k8s`, FastSandbox integration | Container, Pod, microvirtual machine |
| Sandbox Data Plane | How Actions Actually Happen | `components/execd/` | `/command`, `/files`, `/code` |
| Network and Security | How traffic enters and exits, and how is it restricted | `components/ingress/`, `components/egress/` | Endpoints, policies, credentials injection |

Add two more cross-sections: 

- **Orchestration Plane**: Operator, `BatchSandbox`, `Pool`, and `SandboxSnapshot` in `kubernetes/`. It does not directly face the API client, but it determines how resources are created and recycled on Kubernetes.
- **Engineering Side**: Testing, diagnostics, metrics, release, and supply chain validation. It does not change functionality, but it determines whether the system can be trusted. 

This table is to be used with three vertical lines, running from stage 0 all the way to stage 9: 

1. **Evidence Line**: Status, SSE events, exit codes, logs, metrics—success or failure can only be proven by them. 
2. **Trust Line**: Users, models, tools, sandboxes, hosts, external networks—each can control what they can control. 
3. **Condition Line**: When you see "Support," ask which backend, what configuration, which version, and which image. 

## 4. Three Types of APIs, Three Ports, Three Types of Identities

The platform appears to have only one URL to the public, but in reality, there are at least three sets of APIs. Let's separate them first:

| API | Default Location | Who Accesses | Handles What | Authentication |
| --- | --- | --- | --- | --- |
| Lifecycle API | `http://localhost:8080/v1` | SDK, CLI, MCP, trusted backend | Create, query, renew, pause, delete, snapshot, endpoint resolution | `OPEN-SANDBOX-API-KEY` |
| execd API | `44772` port on sandbox endpoint | SDK, trusted backend | Commands, files, Shell sessions, code, PTY, metrics | `X-EXECD-ACCESS-TOKEN` returned by endpoint resolution (if enabled) |
| egress API | `18080` port on sandbox endpoint | SDK, trusted backend | Outbound policies and credential vault | Determined by endpoint resolution |

Three things to note:

1. **Ports are 'sandbox-internal semantic ports', not fixed addresses.** On Docker, the host maps to a random port between 40000–60000; on Kubernetes, it could be the Pod IP, an Ingress path, or a server proxy. `44772` only indicates 'which port execd is in the sandbox,' not 'which host you should connect to.'
2. **Authentication headers are not universal.** Management requests use API Keys; execution requests use the token provided by endpoint resolution. Using an API Key for execd, or using an execd token for the Lifecycle API, will fail.
3. **Egress API is not an entry for regular users.** It is usually called by the SDK or trusted backend when configuring network policies or injecting credentials; do not treat it as a business API.

Another easily confused role: **Ingress is not a fourth API.** It does not provide 'create/query' capabilities; it simply routes external HTTP/WebSocket traffic to a sandbox port. The same execd request may connect directly, via ingress, or through a server proxy—the endpoint is the same semantic one, with the address and request headers determined by endpoint resolution.

### One thing, four address forms

| Deployment Type | What execd address might look like | Key Points |
| --- | --- | --- |
| Docker Direct | `http://127.0.0.1:<random-port>` | Port is mapped by runtime, cannot be hard-coded |
| Kubernetes Direct | `http://PodIP:44772` | Network must be reachable |
| Kubernetes Ingress | `https://gateway.example.com/sandboxes/<id>/port/44772` or with routing headers | Path/request headers defined by gateway |
| Server Proxy Fallback | `http://server:8080/sandboxes/<id>/proxy/44772` | Compatibility path, not the default fast path |

For now, just remember the conclusion: **do not construct the address yourself; resolve the endpoint via the Lifecycle API.** Stage 5 will cover details of each form.

## 5. Two Paths: Arrangement and Usage

Now we split the main line into two paths. This is the most important diagram for this stage:

```text
Management Path (Low Frequency, Short Requests, Small Data)
  Application / Agent
      │  Sandbox.create / get / renew / pause / kill
      ▼
  Python SDK (or CLI / MCP)
      │  HTTPS + OPEN-SANDBOX-API-KEY
      ▼
  Lifecycle server ── authentication, verification, state machine, TTL, endpoint resolution
      │  Select Runtime
      ▼
  Docker / Kubernetes / FastSandbox
      │
      ▼
  Physical resources: Container / Pod / Micro virtual machine
      │
      └── state, endpoint, expiration time back to the control plane, then back to SDK

Usage paths (high-frequency, long connections, big data)
  Application / Agent
      │  sandbox.commands.run / files.read / code.run
      ▼
  Service Object (Bound Endpoint)
      A one-time endpoint resolution, then direct requests
      ▼
  execd (44772) or user workload port
      │ Start processes, read and write files, run the kernel
      ▼
  SSE Event / File Content / Exit Code
      │
      └── back to SDK, aggregate into Execution or file object
```

### Why split into two paths?

This is not about laziness, but rather the result of four real-world constraints working together: 

1. **Different frequencies.** Creating a sandbox might happen every few minutes; Executing commands might happen several times per second. Pushing high-frequency traffic to the control plane is equivalent to making the registry office double as a production line. 
2. **Different connection models.** Management requests are short requests; Command output is SSE long connection, terminal is WebSocket, which may last for tens of minutes. 
3. **Different data volumes.** Creation requests are only a few KB; A single build log or a file download may be tens of MB. 
4. **Different fault isolation.** Even if the control plane is down, the running sandbox should still be executable; If the execution path is shaky, the entire platform should not be able to create new environments. 

The cost is clear: the client must take an extra step to "resolve the endpoint" and correctly handle the request headers, protocols, and expiration times within the endpoints. The trade-off is that the control plane no longer becomes a bottleneck for full-platform bandwidth and connection count. 

> **In short: the control plane is responsible for 'arranging', while the data plane is responsible for 'occurring.'** Server proxies are a safety net for compatibility, not default data paths. 

## 6. Creating Links: From a Single `create` to an Available Handle

Open three coordinates, first look at the entry point, skip the implementation details: 

| Location | What to look for first |
| --- | --- |
| `sdks/sandbox/python/src/opensandbox/sandbox.py` | `Sandbox.create`, `Sandbox._launch` |
| `server/opensandbox_server/api/lifecycle.py` | `create_sandbox` |
| `server/opensandbox_server/services/` | `SandboxService` and each runtime implementation |

### Nine steps to create at once

| Steps | Location of occurrence | What was done | What you can observe |
| --- | --- | --- | --- |
| 1 | SDK | Validate `image` or choose `snapshot_id`; Supplement the default value | Passing both at the same time will immediately throw an error parameter |
| 2 | SDK | Default `entrypoint=["tail","-f","/dev/null"]`, `timeout=10m`, resource `1 CPU / 2Gi` | You can create without passing, but the default value will go into request |
| 3 | SDK → Server | `POST /v1/sandboxes`, with API Key and JSON | Raw HTTP Visible Request Body |
| 4 | Server middleware | Authentication, request ID, parameter validation | 401/400 returns at this step |
| 5 | Server Service Layer | Press `runtime.type` to select Docker / Kubernetes / FastSandbox | When server logs appear, runtime select |
| 6 | Runtime | Create container / Batch Sandbox / Template Sandbox, inject execd, publish endpoint | `docker ps` or `kubectl get` visible resource |
| 7 | Server → SDK | Returns `202 Accepted` plus `id`, `status`, `createdAt`, `expiresAt`, and `entrypoint` | The status may still be `Pending` |
| 8 | SDK | Polling `GET /sandboxes/{id}/endpoints/44772` (non-template sandboxes may parse `18080`), construct the service object | Continuously retry | when the endpoint is not published
| 9 | SDK | Call execd `GET /ping` for health check, and after success, return `Sandbox` | Default is a 30-second ready budget, with a 200ms polling interval |

### Three Designs You Must Understand

**First, HTTP creation is asynchronous, and the SDK's "sense of synchronization" is encapsulated.** 

The server returns `202` instead of `200`, because image pulling, pod scheduling, and execd startup can all be slow. It registers first, then advances in the background. The SDK continues to wait for endpoints and perform health checks inside `create()`, so callers feel synchronized—but if you look at the original HTTP response, you'll see `Pending`. 

If the first query is already `Running`, it only means the image is cached and starts quickly, but it does not mean the interface itself is synchronized. 

**Second, the server does not store all sandbox facts.** 

Docker containers, Kubernetes `BatchSandbox`/Pod, and FastSandbox CRs are the real sources of runtime facts. The server only persists records it owns, such as snapshot metadata and template directories. This allows the storage backend to replace it, and fault recovery has boundaries. 

Direct consequences: **The server-side database is not a sandbox list.** To check "what sandboxes are now," you ultimately need to return to the runtime; After the server process restarts, the view must still be reconstructed at runtime. 

**Third, endpoint resolution is a contract, not an address guess.** 

The SDK does not use container IP or assume port mapping. It queries the lifecycle API for "how to access port 44772 in this sandbox" and preserves the address and request header in the response. With a different deployment method, the address changes, but the client code does not. 

### What does the SDK do when creation fails?

`_launch` contains a logic that is easily overlooked but very important: if a sandbox has been created but subsequent endpoint parsing or health checks fail, the SDK will attempt to call `kill_sandbox` to clean up this "half-finished product" before throwing an exception. 

This explains a common phenomenon: **After creating an error, `docker ps` usually does not leave a sandbox.** But this is just the SDK's effort to clean up, not a platform guarantee; If a process is forcibly killed or the cleanup request fails, orphan resources may still remain. Stage 2 clarifies this cleanup responsibility. 

## 7. Execution Link: Why Commands Don't Return to the Control Plane?

After creation, the `Sandbox` object has already been bound with several service objects. The call chain of executing commands is:

| Step | Location | What was done |
| --- | --- | --- |
| 1 | Application | `await sandbox.commands.run("...")` |
| 2 | SDK service layer | Assemble command, parameters, timeout, working directory, environment variables, and user identity |
| 3 | SDK adapter layer | `POST {execd endpoint}/command`, with request headers obtained from endpoint resolution |
| 4 | execd | Verify parameters, start process (shell or native argv) |
| 5 | execd → SDK | Continuously send stdout, stderr, results, and completion events via SSE |
| 6 | SDK | Aggregate into `Execution`: output fragments, exit code, error, command ID |
| 7 | Application | Determine success by itself: exit code, error, and output content together decide |

Relevant source code locations:

- `sdks/sandbox/python/src/opensandbox/services/command.py`
- `sdks/sandbox/python/src/opensandbox/adapters/command_adapter.py`
- `components/execd/pkg/web/router.go`
- `components/execd/pkg/web/controller/command.go`

### Why not let the server proxy all executions

Because the execution path has three characteristics opposite to the control plane: high frequency, long connection, large traffic.

If all commands go through the lifecycle server:

- Management traffic for creation/query would compete with command stream output for the same set of connections and threads;
- The server would have to forward tens of MB of logs and files for each sandbox, becoming a bandwidth bottleneck;
- A long connection timeout strategy would simultaneously affect management and execution, merging failure domains;
- When scaling the control plane horizontally, it is also necessary to ensure execution connections stick to the same replica.

Therefore, the default design is: the control plane only handles "telling you where to execute," and execution itself is directly connected by the client to the data plane. The server proxy path is still retained for deployments where the client cannot directly connect to the sandbox, but it serves only as a compatibility fallback.

### A common misconception in the execution link

"HTTP 200 means the command succeeded" is incorrect. The stream response from execd returning 200 only indicates that the request was accepted and execution started; the command may subsequently exit with a non-zero code, or the connection may break halfway through output.

Determining success requires checking at least:

- Whether `execution.exit_code` is 0;
- Whether `execution.error` is empty;
- Whether `execution.logs.stdout` and `stderr` are complete (whether the completion event was received).

Stage 3 will match each field of `Execution` with the SSE events one by one.

## 8. Endpoint resolution: turning 'address' into a contract

The original HTTP call endpoint resolution returns a very small body, but with high information density:

```json
{
  "endpoint": "http://127.0.0.1:32768",
  "headers": {
    "X-EXECD-ACCESS-TOKEN": "..."
  }
}
```

In the current contract, the response body only has two fields: `endpoint` and `headers`. A few easy mistakes to make:

1. **`headers` is not decorative.** When using an access token, if you don't include these headers, excd will reject the request. The client should attach `headers` to subsequent requests as-is, rather than just taking `endpoint`.
2. **`endpoint` is the base URL.** The command interface is `{endpoint}/command`, the file interface is `{endpoint}/files/...`; don't assume it always ends with `/`, and don't append `/v1` to it.
3. **Source information is in the response headers.** For `fsb-`-prefixed template sandboxes, the server will add `OPEN-SANDBOX-ORIGIN: template` in the endpoint-resolved response. The SDK uses this signal to determine whether the outbound policy should go through the sandbox sidecar or the control plane. In the original HTTP, it's not in the JSON body and is easy to overlook.
4. **`use_server_proxy=true` will switch to another address.** The returned `endpoint` becomes `/sandboxes/{id}/proxy/{port}`, and request headers may be adjusted. This is suitable for environments where the client cannot directly connect to the sandbox, but it adds one extra hop.
5. **`expires` will issue a time-limited route.** This is the entry point for secure access, expanded in stage 5; for now, just know that the endpoint can be temporary.

There's one boundary that needs to be established in advance: **endpoint reachable ≠ sandbox healthy.** Successful endpoint resolution only indicates that the route exists; excd may not be ready, the token may be invalid, and the target port may not be listening. Health checks are a separate step.

## 9. Experiment: Seeing Two Paths with Raw HTTP

The goal is not to "make it work" but to directly observe `202`, `Pending`, endpoint responses, SSE, and `204`. The SDK hides these details, so this experiment uses `curl.exe` entirely.

First, make sure the stage 0 server is still running and prepare two variables:

```powershell
$base = "http://127.0.0.1:8080/v1"
$headers = @{ "OPEN-SANDBOX-API-KEY" = "dev-secret" }
```

### Experiment 1 · Create and Observe 202 and Pending

Write the request body into a file to avoid PowerShell quotes breaking the JSON:

```powershell
@'
{
  "image": { "uri": "alpine:3.20" },
  "entrypoint": ["tail", "-f", "/dev/null"],
  "timeout": 600,
  "resourceLimits": { "cpu": "500m", "memory": "512Mi" },
  "metadata": { "lesson": "stage-1" }
}
'@ | Set-Content -Encoding utf8 .\create.json
```

Create and record HTTP status:

```powershell
$response = curl.exe -s -D .\create.headers -o .\create.body `
    -X POST "$base/sandboxes" `
    -H "OPEN-SANDBOX-API-KEY: dev-secret" `
    -H "Content-Type: application/json" `
    --data-binary "@create.json"

Get-Content .\create.headers | Select-Object -First 1
$created = Get-Content .\create.body -Raw | ConvertFrom-Json
$created | ConvertTo-Json -Depth 8
$id = $created.id
```

**To observe**:

- Whether the status code in the first row is `202`;
- Whether `status.state` is `Pending` or `Running`;
- Whether `expiresAt` is 'now   10 minutes';
- Whether `entrypoint` is echoed as is.

Then check once more:

```powershell
Invoke-RestMethod -Uri "$base/sandboxes/$id" -Headers $headers |
    ConvertTo-Json -Depth 8
```

If the first time is `Running`, delete the sandbox, switch to a non-cached image, and try again; what you want to see is that "Create" and "Ready" are separated in time, not that you have to see `Pending` every time.

### Experiment 2 · Parse endpoint, call execd directly

```powershell
$execd = Invoke-RestMethod -Uri "$base/sandboxes/$id/endpoints/44772" -Headers $headers
$execd | ConvertTo-Json -Depth 6

# Bring the request headers returned by the endpoint as they are
$execdHeaders = @()
if ($execd.headers) {
    $execd.headers.PSObject.Properties | ForEach-Object {
        $execdHeaders += @("-H", "$($_.Name): $($_.Value)")
    }
}
curl.exe -i "$($execd.endpoint)/ping" @execdHeaders
```

**Observe**: Whether the response from `ping` comes from `44772`'s side, rather than the lifecycle server. At this point, you are already on the data plane path.

Parse the egress port again to confirm that there are two data plane endpoints for the non-template sandbox:

```powershell
Invoke-RestMethod -Uri "$base/sandboxes/$id/endpoints/18080" -Headers $headers |
    ConvertTo-Json -Depth 6
```

Template sandbox (prefix `fsb-`) does not have a sandbox-side egress sidecar, this step will fail or go through the control plane; the current Docker experimental environment will not encounter this.

### Experiment 3 · Run a command with raw HTTP to see SSE

```powershell
@'
{
  "command": "echo out-line; echo err-line 1>&2; exit 3",
  "timeout": 10000
}
'@ | Set-Content -Encoding utf8 .\command.json

curl.exe -N -X POST "$($execd.endpoint)/command" @execdHeaders `
    -H "Content-Type: application/json" `
    --data-binary "@command.json"
```

**To Observe**:

- The connection first returns `200`, followed by continuous `data:` events;
- stdout and stderr are different events;
- Finally, there is a completion event, and the exit code is `3`;
- Although the command "fails," the HTTP layer does not return 500.

This is what was mentioned earlier: **Successful transmission does not equal a successful command.**

### Experiment 4 · Change a Path: Server Proxy

```powershell
$proxied = Invoke-RestMethod `
    -Uri "$base/sandboxes/$id/endpoints/44772?use_server_proxy=true" `
    -Headers $headers
$proxied.endpoint
```

Compare direct connection addresses and proxy addresses. Both can be executed, but the former is the default fast path, while the latter goes through an additional server forwarding. This difference will appear again in Stage 5 when discussing ingress and proxy.

### Experiment 5 · Cleanup

```powershell
curl.exe -i -X DELETE "$base/sandboxes/$id" -H "OPEN-SANDBOX-API-KEY: dev-secret"
```

**To Observe**: Deletion returns `204`, not `200`; subsequently querying the same ID again should return `404`. If running on Kubernetes, you might briefly see `Stopping` after deletion, which will be explained in Stage 2.

### Record Table

Fill your observations into your notes:

| Observation Item | Your Record |
| --- | --- |
| HTTP status on creation | |
| Status on first query | |
| Time elapsed from creation to `Running` | |
| Field names in the endpoint response | |
| Does `ping` require request headers | |
| Command's HTTP status and exit code | |
| HTTP status on deletion | |

## 10. Failure Points List: Translate 'Error Occurred' to 'Which Layer'

This table is the most practical output in this stage. When encountering a problem later, first locate the layer, then decide what to check:

| Failure Point | Typical Phenomenon | Layer | What to Check First |
| --- | --- | --- | --- |
| Incorrect address or domain | Connection refused / timeout | Client | `ConnectionConfig.domain`, port, proxy settings |
| API Key error | `401` | Control Plane Entry | Server configuration and whether client key matches |
| Invalid request body | `400` | Contract/Validation | Response error code; whether image mode missed `entrypoint`, resource limits |
| Image pull failure | Creation timeout or `Failed` | Runtime | `docker ps -a`, server logs, image repository permissions |
| Pool capacity exhausted | `429` + `Retry-After` | Orchestration Layer | Pool status, concurrency budget; expand in Stage 4 |
| Endpoint not publishing | SDK waits beyond budget | Control Plane / Network | Whether status is `Pending`, whether port is listening, sidecar readiness |
| Health check failure | `READY_TIMEOUT` / `UNHEALTHY` | Data Plane | execd logs, `/ping`, endpoint request headers, network policies |
| Command `404` | Endpoint exists but wrong path | Data Plane / Entry | Whether `/v1` is appended to execd address |
| SSE interruption | Incomplete output, connection reset | Data Plane / Transport | Proxy timeout, command status, log cursor |
| Non-zero exit code | Output exists but business fails | User Process | `exit_code`, `stderr`, `execution.error` |
| TTL expired | Execution interrupted | Lifecycle | `expiresAt`, renewal records |
| Still visible after deletion | Briefly `Stopping` | Orchestration Layer | Kubernetes deletion and task cleanup; not "not deleted" |
| File not found | `404` or empty result | Data Plane | Path, working directory, file identity (Stage 3) |

### Troubleshooting Order Mnemonic

**First entry, then object, then endpoint, then execution, then policy, finally business.**

1. Entry: domain, port, key — first rule out 401 and connection refusal.  
2. Object: whether sandbox exists, its state — rule out "object already gone".  
3. Endpoint: check parsing success, whether headers are included — rule out "wrong address".  
4. Execution: whether execd is healthy, whether command itself succeeded — rule out "action failure".  
5. Policy: whether network is rejected, credentials injected — rule out "environment restriction".  
6. Business: only then suspect user code or model output.

This table is not an encyclopedia of errors but a navigation guide. After each new stage learned, add a few rows.

## 11. Draw Two Diagrams (Core Assignment of This Stage)

Do not skip this step. Understanding someone else's diagram and drawing your own reflect two completely different levels of mastery.

### Diagram A · Creation Sequence Diagram

Must include these roles and messages:

```text
Apply → SDK: create(image, timeout, resource)
SDK → Lifecycle Server: POST /v1/sandboxes
Lifecycle server → runtime: create resource + inject execd
Runtime --> Lifecycle Server: Resource has been created, endpoint pending publication
Lifecycle Server --> SDK: 202 + id + Pending
SDK → Lifecycle server: GET .../endpoints/44772 (polling)
Lifecycle server --> SDK: endpoint + headers
SDK → execd: GET /ping
execd --> SDK: 200
SDK --> Application: Available Sandbox handle
```

Mark three moments next to the diagram: **Registration Complete**, **Endpoint Release**, **Health Confirmation**. These three moments are not the same thing.

### Figure B · Execution Sequence Diagram

```text
Apply → SDK: commands.run(command)
SDK → execd: POST /command (with endpoint request header)
execd → user process: start and execute
User process --> execd: stdout / stderr / exit code
execd --> SDK: SSE event stream
SDK --> Application: Execution (outputs + exit code + error)
```

Mark next to the diagram: **Which flows pass through the control plane and which do not.** If the two lines are drawn into a straight line, it means the "arrangement" and "occurrence" have not yet been separated. 

## 12. Common Misconceptions

| Misconceptions | A More Accurate Understanding |
| --- | --- |
| "`Sandbox.create()` is the synchronization interface" | Server creation is asynchronous; The SDK waits for the endpoint and then performs health checks for you, so it appears synchronized. |
| "All requests go through the lifecycle server" | Only management requests pass by default; Execution goes through the data plane. The server proxy is the safety net. |
| "Successful endpoint resolution means the sandbox is available" | Endpoints only prove the existence of the route; Health, authentication, and port listening all need to be separately confirmed. |
| "execd is the user's workload" | execd is a daemon parallel to the user payload and provides an execution API; The two are not the same thing. |
| "All sandboxes can be found in the server database" | The runtime is the source of the facts; The server only persists records it owns. |
| "`specs/` If it's present, it means the current environment is usable" | You also need to look at the backend, configuration, version, and image; Stage 4 will repeatedly train this point. |
| "HTTP 200 means the command is successful" | 200 only means the request is accepted; Success depends on the exit code, error, and full output. |

## 13. Self-Check for Customs Clearance (with Reference Answers)

First, close the document and answer, then compare with the others. 

**1. Why does creating return `202` while SDK calls sound synchronous?** 

`202` indicates "accepted, processing." Pod scheduling, image pulling, and execd startup can all be time-consuming, so the server should not suspend HTTP requests. The SDK continues to poll endpoints and perform health checks before returning, encapsulating asynchronous processes into seemingly synchronous calls. 

**2. Why don't commands run through lifecycle servers?** 

Execution is a path for high-frequency, long connections, and large traffic. Having a control plane proxy couples management and execution traffic together, making the server a bottleneck for bandwidth and connection. The control plane is only responsible for endpoint resolution, while execution is directly connected by the client to the data face. 

**3. What key information is in the endpoint resolution response? Why can't we just retrieve the address?** 

The current response body contains `endpoint` and `headers`. When access tokens are enabled, `headers` is part of the request; missing it results in 401/403. Additionally, the source information of the template sandbox is in the `OPEN-SANDBOX-ORIGIN` response header, not inside the JSON. 

**4. Why doesn't the server save all sandbox records?** 

Because containers, pods, and micro-virtual machines are the true state of runtime, if the server copies a copy, it faces issues such as double write inconsistency, fault recovery, and storage backend binding. The server only persists records it owns (such as snapshot metadata, template directories), and sandbox facts return to runtime queries. 

**5. What might `404`, `503`, and `502` mean?**

In the semantics of entry gateways: `404` usually means the sandbox does not exist or has disappeared; `503` means the sandbox exists but is not yet ready and has no reachable endpoints; `502` indicates infrastructure layer failure (e.g., cluster API error). For specific links, it also depends on which entry returned it. 

**6. Can commands be executed while the sandbox is still `Pending`?** 

Usually not. The endpoint has not yet been released, and the SDK's `create()` has not yet returned. Even if an address is forcibly obtained, execd may not have been started or ready. `Pending` means "The resource is being arranged and not yet available." 

**7. If the command outputs but the business fails, which three fields should you look at?** 

`exit_code` (whether it is 0), `error` (whether there is an execution error), and whether stdout/stderr are complete. Simply checking `execution.text` or "whether there is an output" is not enough. 

**8. Why is the execution chain of the template sandbox the same, but the outbound strategy different?** 

The template sandbox (`fsb-` prefix) runs on prebuilt images and does not have an egress sidecar on the sandbox side, so policy operations follow the control plane; The SDK recognizes this through the endpoint response `OPEN-SANDBOX-ORIGIN: template` and switches the egress service to implement it. Execution is still directly connected to execd, so the link looks the same.

### Complete the checklist

- [ ] Draw a hexagonal diagram without looking at the data, and be able to specify which table of contents each face corresponds to. 
- [ ] Draw the creation sequence diagram, marking `202`, `Pending`, endpoint release, and health check. 
- [ ] Draw the execution sequence diagram explaining why execution bypasses the default lifecycle server. 
- [ ] Use raw HTTP to create and query, resolve endpoints, command and delete. 
- [ ] Can explain why the server does not save all sandbox records. 
- [ ] Able to explain why endpoint responses must be retained `headers`. 
- [ ] List at least 8 failure points and specify which layer each belongs to. 
- [ ] Can clearly explain "control plane arrangement, data plane execution, and network plane governance" in 10 minutes. 

## 14. After Finishing

Now you have a map: you know which layers a call passes through, know that creation and execution are two paths, and know where to look first if it fails. 

But the map still doesn't answer a more fundamental question: **Who owns these environments, and when will it truly end?'** 

The SDK returns handles, but that doesn't mean the resources are yours; `close()` doesn't mean the remote end has disappeared; TTL expiration, process crash, and user cancellation are three different recycling paths. The next stage is to handle this matter and write them into a package that cleans up correctly on success, exception, and cancel paths. 

Entering the next chapter with this question: **"I created it, but who guarantees it will definitely be destroyed?" "** 

Entering [Stage 2](../stage-2/). 

--- 

*Supporting [Learning Route](../learning-path/) Stage 1 Writing · 2026-10-30 · Based on release-1.1.1(`531700ca`)*
