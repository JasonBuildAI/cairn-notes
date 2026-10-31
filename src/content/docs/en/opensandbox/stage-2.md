---
title: "Stage 2: Lifecycle and Cleanup"
description: "Lifecycle, TTL, pause and resume, snapshots and cleanup: from being able to create to being able to take responsibility."
---

> Corresponding to [Learning Path](../learning-path/) Stage 2 (Core · 2–3 days). In this stage, a sandbox is managed as a remote resource with costs, deadlines, and the potential for failure.  
> Source code directory: `$OSB_SRC`.  
> Core deliverables: an encapsulation that can release remote resources along the success, exception, and cancellation paths, as well as a record of a pause/resume experiment.  

## 1. What this stage aims to solve

The scripts in Stage 0 can create and destroy a sandbox, and the map in Stage 1 shows that creation and execution are two separate paths. However, production systems need to answer more difficult questions:

- A creation request has returned, so why can the sandbox still be unavailable?  
- After a process crash, user cancellation, or model timeout, who deletes the remote resource?  
- What if a long-running task reaches its TTL halfway?  
- Does "pause" save memory, disk, or only release the Pod?  
- The `Sandbox` object in my hand, is it the remote resource itself or just a local handle?  

The common theme among these questions is: **ownership.**  

Once a sandbox is created, there must be a clear owner and exit path; otherwise, it will continue occupying CPU, memory, disk, network slots, and incur costs. AI applications easily leak resources because model calls, tool calls, and user cancellations can happen at any time.  

### Separate the three layers first

| Layer | What it is | Owned by | Typical actions |
| --- | --- | --- | --- |
| Remote resources | Containers, Pods, micro-VMs, snapshots | Platform + your cleanup protocol | `create`, `kill`, `pause`, `resume` |
| Control plane records | Sandbox ID, state, expiration time, metadata | Lifecycle server + runtime | `get_info`, `renew`, `list` |
| Local handles | HTTP clients, connection pools, service adapters | Your process | `close`, `connect`, `resume` |

Mixing these three layers leads to two typical mistakes:

- **"Code has ended, but the sandbox is still running"**: Only the local handle was closed, not the remote.  
- **"Think the connection is closed, but actually deleted the remote"**: Using `close()` as `kill()`, the task is killed by mistake.  

The goal of this stage is to let you accurately state: **which layer am I operating on right now, and which layer still has remnants if it fails.**  

## 2. Lifecycle Vocabulary

| Term | Exact meaning | Often misunderstood as |
| --- | --- | --- |
| Absolute expiration time | `expiresAt` is a specific point in time; when reached, it terminates | "How many seconds are left" |
| TTL | Lifetime specified at creation, eventually converted into absolute time | Idle timeout |
| Renew | Sets the expiration time to "current time + given duration" | Adds on top of the original time |
| Manual cleanup | `timeout=None`, no automatic expiration deletion | Never expires, no cleanup necessary |
| Pause | Request to pause; different backends retain different content | Must save memory |
| Resume | Resume a paused sandbox, returning a new handle | Continue using the original object |
| Snapshot | Persistent checkpoint at a specific point in time | Synonym for pause |
| Template | Pre-built, immutable workload definition for FastSandbox | Regular image |
| Terminal state | `Terminated` / `Failed`, does not revert to `Running` automatically | Can retry to restore |

One general principle: **Lifecycle APIs are asynchronous; any "request accepted" does not mean "state completed."** Upon seeing `202`, the next step is always to check the state, not assume success.  

## 3. State Machine: First recognize the "intermediate states"

The states and transitions in the public contract are roughly as follows:

```text
                 ┌──────────────┐
                 │   Pending    │
                 └──────┬───────┘
                        Resources ready
                        ▼
   ┌──────────────► Running ◄──────────────┐
   │                │     │                │
   │        pause   │     │ kill / TTL     │
   │                ▼     ▼                │
   │            Pausing  Stopping          │
   │                │        │             │
   │                ▼        ▼             │
   │             Paused   Terminated       │
   │                │                      │
   │      resume    ▼                      │
   └──────────── Resuming ─────────────────┘

Any non-terminal state can enter Failed under a critical error
```

| Status | Meaning | What You Should Do |
| --- | --- | --- |
| `Pending` | Accepted, resources not yet ready | Wait or poll; do not send business requests |
| `Running` | Available | Execute commands, access files or services |
| `Pausing` | Pausing | Do not assume it has already paused |
| `Paused` | Paused | Can be resumed; retention scope depends on backend |
| `Resuming` | Resuming | Wait until it reaches `Running`, do not reuse old endpoints |
| `Stopping` | Terminating | Do not initiate new business operations |
| `Terminated` | Terminated normally | Perform final cleanup and audit |
| `Failed` | Terminal failure | Read `reason` / `message`, do not retry blindly |

Two implementation details:

1. **The SDK constants do not include `Resuming`.** `SandboxState` defines `Pending`, `Running`, `Pausing`, `Paused`, `Stopping`, `Terminated`, `Failed`, `Unknown`, but the public contract clearly lists `Resuming` as a valid state. Clients should treat states as extensible strings, logging unknown values and continuing polling, rather than hardcoding a set of `if state == ...`.
2. **`Stopping` is a real observation window.** In Kubernetes, after deleting `BatchSandbox`, the object may be retained briefly while waiting for task cleanup and pool release; during this period, queries will see `Stopping`, which is not a "deletion failure." Stage 4 will explain the underlying controller behavior.

Outside of the state machine, there is a status field that is often ignored:

```python
info.status.reason    # Machine-readable reasons, such as user_delete, ttl_expiry, provision_timeout
info.status.message   # Human-readable instructions
info.last_transition_at
```

When troubleshooting, first read `reason`, then check the logs; don't start guessing just because `state` is `Failed`.

## 4. Creation: From "Request Success" to "Being Responsible"

Stage 1 has already broken down the creation process; here we only supplement three key points from the lifecycle perspective.

### 1. When `create()` returns, what you get is a "usable handle," not a "proof of ownership"

By default, the SDK waits until the endpoint is published and passes the health check before returning. But this only indicates that "it is usable now," and does not mean:

- You have recorded the sandbox ID;
- It will be cleaned up when your process exits;
- Its TTL is sufficient to cover the task;
- Another worker later won't kill it.

Handle is capability; ownership is a protocol. Production systems must explicitly design the latter.

### 2. When creation fails, the SDK will try to clean up the "half-finished product"

`Sandbox._launch`, when endpoint resolution or health checks fail, will attempt to `kill_sandbox` clean up the already created remote sandbox, then throw an exception. This can reduce orphans, but does not guarantee:

- If the process is `SIGKILL` or the machine loses power, cleanup code won't execute;
- The cleanup request itself may fail;
- The server might fail before returning the ID, and the client has no way of knowing whether the remote resource was created.

So a TTL fallback and orphan scanning are still needed; the SDK's best-effort cleanup cannot be considered a transaction.

### 3. Ready budget and health check are two separate things

`ready_timeout` (default 30 seconds) is the total budget for "waiting for endpoint publication and health check"; `skip_health_check=True` just skips the health check, **but will still wait for the endpoint to be published**. This means:

- Skipping health check does not mean not waiting;
- Custom `health_check` may be stricter than `/ping` and better suited for business services;
- Exhausting the budget should be seen as a diagnosable failure, not "just try again".

## 5. TTL: Absolute time, not a countdown

### TTL at creation

The default `timeout` of `Sandbox.create` is 10 minutes, which is ultimately converted by the server into `expiresAt` as this absolute time point. The `max_sandbox_timeout_seconds` limit in the server configuration is the **maximum duration that can be requested at creation**.

`timeout=None` indicates manual cleanup mode: no automatic expiration deletion. It does not mean free, safe, or permanent; it only means **the leak risk is entirely transferred to your code**. Some Kubernetes workload providers may even refuse requests with "no expiration time set".

### The true meaning of renewal

The source code describes it very directly:

```python
new_expiration = datetime.now(timezone.utc) + timeout
```

So the meaning of `renew(timedelta(minutes=5))` is 'live for another 5 minutes from now,' not 'add 5 minutes to the original expiration time.' It may extend or **shorten** the remaining lifespan.

A practical budget is:

```text
Estimated task duration + waiting in queue + tool retry budget < TTL
```

Do not treat renewals as unlimited keep-alive; also, do not blindly renew before each tool call, otherwise a frozen Agent can occupy resources permanently.

### Why Absolute Time is More Reliable

Absolute expiration time has an important advantage: **restarting the service does not reset its lifespan.**

- Docker runtime writes the expiration time into the container labels; when the server starts, it will scan existing sandboxes and restore the timers.
- Kubernetes writes the expiration time into `BatchSandbox`'s `expireTime`, executed by the controller.

This is the value of 'absolute TTL rather than idle timeout': the lifespan of the sandbox can be audited from its creation time and will not be quietly extended due to a restart, a period of idleness, or a reconnection.

### Signs of TTL Expiration

TTL expiration is not 'gracefully notifying your code,' but the termination of the resource:

- The command being executed will be disconnected;
- Subsequent requests may receive `404` or a connection failure;
- The state eventually enters `Terminated`, `reason` may be `ttl_expiry`.

Applications should handle 'interruption during execution' and 'command itself failure' separately; the former is a lifecycle event, while the latter is a business event.

## 6. Pause and Resume: The Same Interface, Different Retention Scopes

This is one of the places in the entire course most easily misled by 'interface similarity'.

### Common Points

- `sandbox.pause()` is only responsible for **initiating** the pause, not waiting for it to complete; it is considered complete only when `Paused` is reached.
- The old endpoint may become invalid after pausing; the SDK will clear the endpoint cache at `pause()`.
- Restore using the class method `Sandbox.resume(id, ...)`, which will re-parse the endpoint, rebuild the service object, perform a health check, and return a **new handle**.
- Sandboxes that are paused may still expire according to the original TTL; pause does not mean 'billing is frozen'.

### Differences: 'Pause' in Docker and Kubernetes Are Not the Same

| Dimension | Docker Runtime | Kubernetes (BatchSandbox rootfs mode) |
| --- | --- | --- |
| Implementation Method | Pause container process (freeze) | Commit root filesystem snapshot, release Pod and pool quota |
| RAM | Kept in memory | Not kept by default |
| Resource Usage | Container still exists, still consumes resources | Pod is released, mainly leaving image/snapshot |
| Recovery Speed | Fast, just thaw | Requires rebuilding workload from snapshot |
| Endpoint | Usually unchanged, but should not be cached | May change, must be re-parsed |
| Credential Vault | sidecar still present, secrets may be retained | sidecar released with runtime, secrets lost, need to be re-injected |
| Applicable Scenarios | Short interruptions, preserving process state | Long-term inactivity, releasing cluster capacity |

This table needs to be carried into Stage 4: **The same `pause()`, different backends provide different guarantees.** When you see 'supports pause,' you must ask 'which states are retained and which resources are released.'

### Precautions for Pausing/Resuming Experiments

- Before pausing, first confirm that the status is `Running`; pausing `Paused` again usually results in `409`.
- Do not reuse the old `Sandbox` object after recovery; use the new handle returned by `resume()`.
- If a task depends on in-process memory (for example, a Python process that is currently training), it will not continue from the original memory after recovery in Kubernetes rootfs mode.
- If Credential Vault is enabled, you need to re-inject credentials after recovery; do not assume secrets will come back with the snapshot.

## 7. Snapshots: Persistent Checkpoints, Not an 'Alias for Pausing'

Snapshots and pauses solve different problems:

- **Pause**: Make a sandbox temporarily unavailable, then restore **the same sandbox ID**.
- **Snapshot**: Persist the state at a certain moment. Later, you can create a **new sandbox** or retain it for a long time.

### Public Status

The snapshot state exposed by the lifecycle API is:

| Status | Meaning |
| --- | --- |
| `Creating` | Accepted, capturing |
| `Ready` | Can be used for recovery |
| `Failed` | Creation failed, read the reason |
| `Deleting` | Deleting |

When creating the interface, it usually still returns `Creating`, and you must poll until `Ready` before it can be used for `Sandbox.create(snapshot_id=...)`.

Inside Kubernetes, controllers also go through the `Pending → Committing → Succeed / Failed` phase; this is the implementation phase and should not be confused with the public state. What you see through the API is the public state.

### Border

- By default, the root file system is saved; the running memory is not saved by default. Optional QEMU VMState can save the virtual machine memory state, but it is specific to certain backends and configurations.
- Pause/resume and snapshots are usually only supported for single-replica sandboxes (`replicas=1`).
- Deleting snapshot records does not equal deleting images that have already been pushed; the image retention policy is an operations issue.
- The registry, credentials, and retention policy of the snapshot are determined by the deployment configuration and cannot be overridden by each request.

### Parameter Constraints During Recovery

`Sandbox.create` requires `image` and `snapshot_id` **to provide exactly one**. Providing both at the same time will fail immediately; not providing either will also fail. The restored sandbox is a new ID, not a 'resurrection' of the original sandbox.

## 8. Template: The shape is fixed before creation

FastSandbox templates are another type of lifecycle object, which are easily confused with snapshots:

| Dimension | Snapshot | Template |
| --- | --- | --- |
| Source | Result of a certain sandbox run | Pre-built golden image |
| Purpose | Restore the state of that sandbox | Quickly create new sandboxes of the same shape |
| Status | `Creating` / `Ready` / `Failed` / `Deleting` | `Pending` / `Building` / `Succeeded` / `Failed` |
| Creation Entry | `Sandbox.create(snapshot_id=...)` | `Sandbox.create_from_template(template_id, timeout=...)` |
| Overridable Fields | Some creation parameters | Almost non-overridable: entry, environment, resources, volumes, platform, lifecycle all come from the template |

Template mode has three hard constraints:

1. `timeout` is a **required parameter**;
2. Only templates of `Succeeded` can create sandboxes;
3. Cannot override template shape with per-request `image`, `env`, `resource`, `entrypoint`.

If the business needs "different image and resources per task," templates are not suitable; they fit scenarios where "shape is stable and startup needs to be fast."

## 9. Four cleanup actions: `close`, `kill`, `destroy`, `async with`

First look at the source code semantics, then usage scenarios.

| Action | Remote Sandbox | Local Connection | Typical Use |
| --- | --- | --- | --- |
| `close()` | **Keep** | Close | Task finished, but want to `connect()` later or hand over to TTL |
| `kill()` | **Terminate** | Keep | Remote no longer needed, but client still used for cleanup |
| `destroy()` | **Terminate** | Close | Standard exit path: create—use—discard |
| `async with sandbox` | **Does not auto-terminate** | On exit `close()` | Only ensures local resources are released |
| `connect()` | Connect to existing | New handle | Take over across processes, reconnect after disconnect |
| `resume()` | Restore paused sandbox | New handle | Continue task after pause |

Several implementation details to remember:

- `destroy()` first `kill()`, then in `finally` `close()`; **even if termination fails, local resources are closed, and the exception is then propagated.**
- `close()` only logs errors and does not throw, preventing cleanup path from crashing again.
- `pause()` and `kill()` both clear endpoint cache to prevent continued use of old addresses.
- `async with`'s `__aexit__` only calls `close()`, so "sandbox still exists after context exit" is by design, not a bug.

### A minimal but reliable encapsulation

```python
import asyncio
from datetime import timedelta

from opensandbox import Sandbox
from opensandbox.config import ConnectionConfig

async def run_in_sandbox(work):
    config = ConnectionConfig(domain="localhost:8080", api_key="dev-secret")
    sandbox = await Sandbox.create(
        "python:3.12",
        connection_config=config,
        timeout=timedelta(minutes=15),
    )
    try:
        return await work(sandbox)
    finally:
        # Use a shield to prevent the current task's cleanup from being interrupted when it is canceled;
        # It cannot prevent a second cancellation or process exit, so TTL is still the fallback.
        await asyncio.shield(sandbox.destroy())
```

This piece of code handles both the 'success' and 'exception' paths, but it hasn't yet addressed:

- How to alert when cleanup fails;
- How to handle cleanup timeouts;
- How to ensure the cleanup task actually completes if a cancellation occurs;
- How to log the sandbox ID for post-event auditing.

At least, production packaging should include structured logging, destruction failure alerts, and sandbox ID recording. Do not silently swallow destruction exceptions in `finally`, otherwise leaks will be disguised as successes.

### All three paths need to be considered

| Path | Typical Scenario | What You Need to Ensure |
| --- | --- | --- |
| Success | Task completes normally | Explicitly `destroy()`, do not rely solely on GC |
| Exception | Command failure, parsing failure, business exception | Cleanup is still executed in `finally` |
| Cancellation | User interruption, upper-level timeout, process shutdown | Cleanup is not interrupted by the same cancellation; have TTL and orphan scanning as a fallback |

## 10. Experiment: Seeing the difference between 'handles' and 'remote'

### Experiment 1 · Lifecycle Observer

```python
import asyncio
from datetime import datetime, timezone, timedelta

from opensandbox import Sandbox
from opensandbox.config import ConnectionConfig

def connection() -> ConnectionConfig:
    return ConnectionConfig(
        domain="localhost:8080",
        api_key="dev-secret",
        request_timeout=timedelta(seconds=60),
    )

async def wait_for_state(sandbox, wanted: str, timeout_seconds: float = 120) -> str:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_seconds
    while True:
        info = await sandbox.get_info()
        state = info.status.state
        print(f"state={state} reason={info.status.reason}")
        if state == wanted:
            return state
        if state in {"Failed", "Terminated"}:
            raise RuntimeError(f"sandbox reached {state}: {info.status.reason}")
        if loop.time() >= deadline:
            raise TimeoutError(f"state did not become {wanted}")
        await asyncio.sleep(1)

async def main() -> None:
    sandbox = await Sandbox.create(
        "python:3.12",
        connection_config=connection(),
        timeout=timedelta(minutes=10),
        resource={"cpu": "500m", "memory": "512Mi"},
        metadata={"lesson": "stage-2"},
    )
    print("sandbox id:", sandbox.id)
    try:
        info = await sandbox.get_info()
        print("expires_at:", info.expires_at)
        print("now       :", datetime.now(timezone.utc))

        await wait_for_state(sandbox, "Running")

        await sandbox.renew(timedelta(minutes=3))
        new_info = await sandbox.get_info()
        print("after renew:", new_info.expires_at)
    finally:
        await sandbox.destroy()

if __name__ == "__main__":
    asyncio.run(main())
```

**Observe Three Things**:

1. `expires_at` is absolute time, and the difference with `now` is close to the TTL you provided;
2. After `renew(3m)`, the new `expires_at` is close to "now + 3 minutes" rather than "original time + 3 minutes";
3. The remote resource is only terminated by `destroy()` after the script ends; `finally` is the key to resource safety.

### Experiment 2 · Are remote resources still there after `close()`

Replace `destroy()` in `finally` with `close()`, and after running, execute in another window:

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}"
```

You will see that the sandbox container still exists. Then manually terminate it:

```python
await sandbox.kill()
```

Then use `docker ps` to confirm disappearance. This experiment completely separates 'local handles' and 'remote resources'.

### Experiment 3 · Pause and Resume (Docker)

```python
async def pause_and_resume() -> None:
    config = connection()
    sandbox = await Sandbox.create(
        "python:3.12",
        connection_config=config,
        timeout=timedelta(minutes=30),
    )
    sandbox_id = sandbox.id
    try:
        await sandbox.pause()
        await wait_for_state(sandbox, "Paused")
        print("paused; check `docker ps` for (Paused)")

        resumed = await Sandbox.resume(
            sandbox_id,
            connection_config=config,
            resume_timeout=timedelta(seconds=60),
        )
        try:
            execution = await resumed.commands.run("echo resumed")
            print(execution.text)
        finally:
            await resumed.destroy()
    finally:
        try:
            await sandbox.close()
        except Exception as exc:
            print("close failed:", exc)
```

Execute `docker ps` after pausing and before resuming, and observe the container's state; execute the command again after resuming. **Note**: Docker pause retains process memory, while Kubernetes rootfs pause does not; redo this experiment with a different backend, and the conclusions will differ.

### Experiment 4 · Snapshot (requires Kubernetes backend)

If only Docker is available, skip execution, but still understand the code:

```python
from opensandbox import Sandbox, SandboxManager

async def snapshot_lab(sandbox: Sandbox) -> None:
    created = await sandbox.create_snapshot(name="stage-2-checkpoint")
    manager = await SandboxManager.create(connection_config=connection())
    try:
        deadline = asyncio.get_running_loop().time() + 300
        while True:
            current = await manager.get_snapshot(created.id)
            state = current.status.state
            print("snapshot state:", state)
            if state == "Ready":
                break
            if state == "Failed":
                raise RuntimeError(current.status.message or "snapshot failed")
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError("snapshot did not become Ready")
            await asyncio.sleep(2)

        restored = await Sandbox.create(
            snapshot_id=created.id,
            connection_config=connection(),
            timeout=timedelta(minutes=10),
        )
        try:
            print((await restored.get_info()).id)
        finally:
            await restored.destroy()
    finally:
        await manager.close()
```

**Observation**: The snapshot ID is different from the restored sandbox ID; `create(snapshot_id=...)` can no longer pass `image`.

### Experiment 5 · Cancel Path

```python
async def cancelled_work() -> None:
    try:
        await asyncio.sleep(60)
    finally:
        print("work cancelled; cleanup still runs")
```

Wrap the entire `run_in_sandbox(cancelled_work)` with an outer layer `asyncio.timeout(2)` and observe: 

- `CancelledError` Will spread; 
- `destroy()` in `finally` should still be executed; 
- If the cleanup is not completed, `docker ps` will leave evidence. 

This step lays the groundwork for the Agent budget in Stage 7 and the leak troubleshooting in Stage 8. 

## 11. Failure Pattern Table

| Phenomenon | Possible Cause | What to Check First | Handle |
| --- | --- | --- | --- |
| Create timeout | Slow image pull, scheduling failure, execd not ready | Server logs, `docker ps -a`, status `reason` | Distinguish between "slow" and "dead"; Do not mindlessly retry |
| Container remains after failed creation | Failed cleanup request, process killed | Sandbox ID, container tag | Depends on TTL + orphan scanning, does not assume reliable SDK cleanup |
| `401` | API Key Inconsistency | Server Configuration, Client Configuration | Fix keys, do not retry |
| Pause to return `409` | Sandbox is not present `Running` | Current state | Wait until the stable state |
| Recovery failed | Snapshot not `Ready`, backend not supported, insufficient resources | Snapshot status, event | Wait for `Ready` before recovery; Read `reason` |
| Command connection failed after restoration | Endpoint changed, old handle reused | Should `resume()` new handle be used | Re-parse endpoint without caching old address |
| Long task interrupted midway | TTL expired | `expiresAt`, `reason` | Renewal within budget; Separate TTL events from business failures |
| Snapshot always `Creating` | Slow image push, registry unreachable | Snapshot status, controller events, registry | Set timeout and alerts, do not poll endlessly |
| After deletion, you can still find | Kubernetes `Stopping` window | `status.reason` Is it `DELETING` | Waiting for the object to truly disappear |
| Cleanup failed but business succeeded | `destroy()` Mistake and swallowed | Log level, exception handling | Record IDs and issue alerts, don't fake success |

## 12. Common Misconceptions

| Misconceptions | A More Accurate Understanding |
| --- | --- |
| "`create()` Returned, resources are under my control" | Returns usable handles; Ownership is established through cleaning protocols, TTL, and auditing. |
| "`renew(30m)` is 30 minutes added to the original expiration time" | is `now + 30m`, which may be extended or shortened. |
| "`timeout=None` is a permanent sandbox" | It is not automatically deleted when expiring, so the risk of leakage is higher. |
| "`close()` will delete the sandbox" | Only close the local connection, the remote remains intact. |
| "`async with` will be automatically destroyed" | Only calling `close()` will not terminate the remote. |
| "Pause to save memory" | Docker freeze retains memory; Kubernetes rootfs snapshots are not saved by default. |
| "After restoration, you can still use the old `Sandbox` object" | The endpoint may change; Use the new handle of `resume()`. |
| "Snapshot creation returns successfully, then recovery is possible" | To poll to `Ready`; `Creating` is not available. |
| "Both templates and snapshots are saved" | Templates are pre-built shapes, snapshots are checkpoints in a sandbox. |

## 13. Self-Check for Customs Clearance (with Reference Answers)

**1. Why is the essence of lifecycle management said to be ownership management?** 

Because once a resource is created, it continues to occupy costs, and "creation successful" only proves it exists now; it does not prove that someone will be responsible for releasing it on the three paths of success, exception, or cancellation. Ownership means clear responsibility, deadline, and exit path. 

**2. `renew(5m)` What exactly was done?** 

Set the expiration time to "Current UTC time + 5 minutes". It is neither cumulative nor active; If the original remaining time is longer, this call will shorten the lifespan. 

**3. What is the difference between `close()`, `kill()`, and `destroy()`?**

`close()` Only release local connections; `kill()` Terminate remote but retain local clients; `destroy()` First terminate remote, then unconditionally close local resources—this is the standard create-use-discard exit path. 

**4. Why can't `async with` replace cleanup?** 

Its `__aexit__` only calls `close()` and does not call `kill()` or `destroy()`. The remote sandbox continues to run until the TTL expires or is cleaned up by other mechanisms. 

**5. After pausing on Kubernetes, does process memory still exist?** 

Not available by default. rootfs mode commits the file system and releases Pods, then rebuilds from the snapshot during recovery; Running memory is not reserved by default. When memory needs to be reserved, use the specific snapshot/VMState mode and confirm backend support. 

**6. Why re-resolve endpoints after pausing?** 

Pausing/restoring may change the address of the workload (especially on Kubernetes). The SDK's `pause()` will clear the endpoint cache, and `resume()` will re-parse and return a new handle; Business code should not cache old addresses. 

**7. Why is the public state of snapshots different from the internal phase?** 

Public APIs are client-facing and use `Creating` / `Ready` / `Failed` / `Deleting`; Kubernetes controllers also have `Pending → Committing → Succeed / Failed`. The former is the contract, the latter is the implementation phase, and the client should only rely on the public state. 

**8. Is there definitely no residue after a failed creation?**

Not necessarily. The SDK will try its best to clean up the sandbox that has already obtained an ID, but processes being killed, cleanup requests failing, or the server failing prematurely can all leave resources behind. TTL and separate orphan scans are still necessary as a safety net.

### Checklist

- [ ] Be able to draw `Pending → Running → Pausing → Paused → Resuming → Running` and the termination branches.
- [ ] Be able to explain `resume` why it returns a new handle, and why the old endpoint cannot be cached.
- [ ] Be able to state the default TTL, and the actual semantics of `timeout=None` and `renew`.
- [ ] Write a wrapper that can clean up on success, exception, and cancellation paths.
- [ ] Be able to distinguish `close`, `kill`, `destroy`, and `async with`.
- [ ] Complete a pause, poll to `Paused`, resume, and execute a command on Docker.
- [ ] Be able to explain the differences between Docker and Kubernetes in terms of pause retention.
- [ ] Be able to explain why both snapshot `Ready` and template `Succeeded` must be polled.

## Fourteen, After Completion

Now you can turn a sandbox from "something that can run code" into "a resource with an owner, a TTL, and an exit path."  

The next stage moves into the data plane: commands, streaming output, file reading and writing, terminal, and code context. You will see what exactly is in the `Execution` object, how SSE events turn into evidence, and why "successful transmission" and "command success" are two different things.

Take this question into the next chapter: **'After the model says `run this code`, why does the system make the application believe it actually ran and really succeeded?'**

Proceed to [Stage 3](../stage-3/).

---

*Accompanied by [Learning Path](../learning-path/) Stage 2 draft · 2026-10-30 · based on release-1.1.1 (`531700ca`)*
