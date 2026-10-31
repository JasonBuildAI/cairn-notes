---
title: "Stage 0: Get the system running"
description: "Start the server, Docker, and the first sandbox, and record the system boundaries."
---

> Corresponding to [Learning Path](../learning-path/) Stage 0 (Preparation · 0.5–1 day). This document is a supplementary explanation and does not replace the check items in the list.
> Source code directory: `$OSB_SRC`. Unless otherwise specified, the commands below should be executed after cd to this directory.
> This stage only involves one task: make the minimal chain "source-code server → Docker → sandbox → Python SDK → command output" actually work.

## 1. What to Achieve in This Stage

AI infrastructure projects are prone to a pseudo-learning scenario: understanding the architecture diagram but never having seen a real sandbox start, fail, or get cleaned up.

The goal of Stage 0 is not to "set up the environment," but to establish three baselines:

1. **Environment baseline**: Docker, Python, server, and SDK versions and configurations are clear.
2. **Behavior baseline**: You know how long normal creation, execution, and destruction take, and what the outputs are.
3. **Failure baseline**: You have seen at least one authentication failure or Docker not starting error, so you won't mistake environmental issues for code problems afterward.

All subsequent stages refer to these three baselines. Without real behavior, concepts become theoretical; without failure records, debugging becomes guesswork.

## 2. Prerequisites

| Component | Requirement | Check Command |
| --- | --- | --- |
| Windows | Recommended Windows 10/11, with WSL2 enabled | `wsl --status` |
| Docker | Docker Desktop, Linux containers | `docker version` |
| Python | 3.10 | `python --version` |
| uv | Latest stable version | `uv --version` |
| Disk | At least reserve several GB for images and containers | `docker system df` |

> On Windows, make sure Docker Desktop is using **Linux containers**. The reference local runtime of OpenSandbox targets Linux containers; Windows containers require a different backend configuration and should not mix with commands in this stage.

If Docker reports `failed to connect to the docker API` or `dockerDesktopLinuxEngine`, start Docker Desktop first and wait until the status shows Engine running before continuing. **Do not suspect Python code if Docker hasn't started yet.**

## 3. Step 1 · Enter the Source Code and Confirm Versions

```powershell
cd $OSB_SRC
git describe --tags --always
git log -1 --format="%H %ad %s" --date=iso
```

You should see `release-1.1.1` and submit `531700ca...`. This step is very important: the paths and actions in the textbook are based on this snapshot, and the development line may have already moved forward.

Double-check Docker:

```powershell
docker version
docker context show
```

**You need to observe**: If both the client and server sections appear, it indicates the Docker daemon is available; if only the client information appears, it usually means the engine is not running.

## 4. Step 2 · Create an isolated Python environment

```powershell
uv venv .venv
.\.venv\Scripts\Activate.ps1
uv pip install -e .\server -e .\sdks\sandbox\python
```

Why install from source code instead of just using `uvx`?

- `uvx opensandbox-server` will fetch the released package, which may be more up-to-date than the current learning snapshot;
- Installing from source ensures that the server, SDK, and teaching materials are fully aligned;
- Later when reading the source code or modifying small experiments, there's no need to switch environments.

Verification:

```powershell
python -c "import opensandbox; print(opensandbox.__version__)"
opensandbox-server --help
```

If PowerShell refuses to execute the activation script, you can allow it for the current user only:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
.\.venv\Scripts\Activate.ps1
```

> If `python` points to the placeholder of Microsoft Store, first use `uv python list` to find the real interpreter, then use `uv venv --python 3.12 .venv` to specify the version.

## 5. Step 3 · Generate server-side configuration

```powershell
opensandbox-server init-config "$HOME\.sandbox.toml" --example docker
```

Open `$HOME\.sandbox.toml`. The example does not enable authentication by default; to practice real deployment, find the `[server]` section and add or uncomment:

```toml
[server]
host = "127.0.0.1"
port = 8080
api_key = "dev-secret"
max_sandbox_timeout_seconds = 86400
```

If `api_key` is empty, the server will require you to explicitly confirm 'unsafe mode' at startup (interactive input `YES`, or set `OPENSANDBOX_INSECURE_SERVER=YES`). **It is also recommended to set a key in the development environment**, because what you are practicing is exactly 'where the credentials come from and how to fix a 401'.

### What the three configuration items do

| Configuration | Function | Common Mistakes |
| --- | --- | --- |
| `host` / `port` | Lifecycle API listening address | Client accesses the wrong port |
| `api_key` | Authentication key for the management API | SDK does not set the same key, resulting in 401 |
| `max_sandbox_timeout_seconds` | Maximum TTL at creation | Thinking it also limits renewal or total lifetime |

### Key runtime configuration

`[runtime]` in the same file determines the backend:

```toml
[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.1.0"
```

`execd` is the execution daemon injected into the sandbox. Do not confuse `execd_image` with your business image: the former provides the execution API, while the latter is the working environment for running model code.

The `v1.1.0` in the example is a component-level image tag, which is not the same as the umbrella version `release-1.1.1` in the tutorial. Component tags, server configuration, and Helm chart default values belong to different release layers. When deploying, you should use the tags in the current chart/configuration and check compatibility during upgrades.

`[egress]` controls outbound sidecars. Even if network policies are not used at this stage, it is recommended to keep the default configuration, as it will be needed in stage 5.

## 6. Step 4 · Start the Server

In the first PowerShell window:

```powershell
cd $OSB_SRC
.\.venv\Scripts\Activate.ps1
opensandbox-server
```

Expect to see Uvicorn startup logs, listening on `127.0.0.1:8080`

Verify in the second window:

```powershell
curl.exe http://127.0.0.1:8080/health
curl.exe -H "OPEN-SANDBOX-API-KEY: dev-secret" http://127.0.0.1:8080/version
```

Expected return is similar to:

```json
{"status":"healthy"}
{"version":"1.1.1"}
```

Open the browser and visit:

- `http://127.0.0.1:8080/docs` — Swagger UI
- `http://127.0.0.1:8080/redoc` — ReDoc

**What to observe in this step**: `/health` does not require an API Key, `/version` does. This indicates that authentication occurs at the middleware layer, not manually on every route. Stage 1 will put this kind of "cross-cutting concern" back into the layered diagram.

## 7. Step 5 · Intentionally Fail Once

First, make a request without a Key:

```powershell
curl.exe -i http://127.0.0.1:8080/v1/sandboxes
```

Expect to get `401` or a clear authentication error. Then add the wrong key, and finally add the correct key:

```powershell
curl.exe -i -H "OPEN-SANDBOX-API-KEY: wrong" http://127.0.0.1:8080/v1/sandboxes
curl.exe -i -H "OPEN-SANDBOX-API-KEY: dev-secret" http://127.0.0.1:8080/v1/sandboxes
```

This step establishes the fault baseline: **401 is a credential issue, not a sandbox creation failure.** The two types of errors appear in different places in the logs and the actions that can be taken are different.

## 8. Step 6 · First Real Sandbox

Set environment variables in the second window:

```powershell
$env:OPEN_SANDBOX_API_KEY = "dev-secret"
$env:OPEN_SANDBOX_DOMAIN = "localhost:8080"
```

Create `first_sandbox.py`:

```python
import asyncio
from datetime import timedelta

from opensandbox import Sandbox
from opensandbox.config import ConnectionConfig

async def main() -> None:
    config = ConnectionConfig(
        domain="localhost:8080",
        api_key="dev-secret",
        request_timeout=timedelta(seconds=60),
    )

    sandbox = await Sandbox.create(
        "alpine:3.20",
        connection_config=config,
        timeout=timedelta(minutes=10),
        resource={"cpu": "500m", "memory": "512Mi"},
        metadata={"lesson": "stage-0"},
    )

    print(f"sandbox id: {sandbox.id}")
    try:
        execution = await sandbox.commands.run(
            "uname -a; echo '---'; id; echo '---'; cat /etc/alpine-release"
        )
        for message in execution.logs.stdout:
            print(message.text, end="")
        for message in execution.logs.stderr:
            print(message.text, end="")
        if execution.error:
            raise RuntimeError(
                f"{execution.error.name}: {execution.error.value}"
            )
        if execution.exit_code != 0:
            raise RuntimeError(f"command exited with {execution.exit_code}")
    finally:
        await sandbox.destroy()

if __name__ == "__main__":
    asyncio.run(main())
```

Run:

```powershell
python .\first_sandbox.py
```

If this is the first time the image is pulled, creation may take several tens of seconds; subsequent times will be much faster. The expected output includes the Linux kernel, the current user, and the Alpine version.

**A lot actually happens in this step**: The SDK sends a creation request, the server calls Docker to create the container and injects execd, the SDK polls `Running`, parses the execd endpoint, performs a health check, and only then returns `sandbox`. The "one line `Sandbox.create`" you see represents a complete control plane–data plane link. Stage 1 will break it down.

## 9. Step 7 · Seeing the actual container (optional, but strongly recommended)

Temporarily insert between `Sandbox.create` and `destroy`:

```python
await asyncio.to_thread(input, "Press Enter to destroy the sandbox...")
```

After running, open another window to execute:

```powershell
docker ps --format "table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}"
```

You will see a container marked with `opensandbox`. After pressing Enter, it should disappear.

This step maps the "API call" to the "real resource": **`Sandbox` is not the container itself, but a client handle pointing to the container.**

## 10. Step 8 · Observing Cleanup Semantics

Modify the script to not use `finally`, and end directly after executing the command; or only call `sandbox.close()`. Then observe:

```powershell
docker ps
```

You will learn one point that this textbook repeatedly emphasizes:

| Operation | Remote Sandbox | Local Connection | When to Use |
| --- | --- | --- | --- |
| `close()` | Keep | Close | When the task is finished but you want to `connect()` later or let TTL manage it |
| `kill()` | Terminate | Keep | When the remote resource is no longer needed, but you still want to reuse the client for cleanup |
| `destroy()` | Terminate | Close | Standard exit path for create-use-discard |
| `async with sandbox` | **Does not automatically terminate** | On exit `close()` | Only ensures local resource release, cannot replace kill |

Production code should use `try/finally` to wrap remote resources, or have a clear termination strategy at the business layer. Stage 2 will turn this into a reusable encapsulation.

## Eleven, Step 9 · Read Two Sections of Official Documentation

Only read the following two sections, do not expand:

1. [Learning Area Overview](../) **Getting Started**: Confirm the official minimal path.
2. `docs/getting-started/configuration.md` **Authentication** and **Sandbox Expiration**: Confirm API Key and TTL semantics.

After reading, write three sentences in your own words:

```text
Server side is responsible for:
SDK Responsible for:
When must I clean the sandbox:
```

Reference Answers:

- The server is responsible for authentication, validation, lifecycle states, and runtime selection;
- The SDK is responsible for assembling requests, waiting until ready, parsing endpoints, and packaging execution results into language objects;
- Once a remote sandbox is created, it must be scheduled for destruction in all three paths: success, exception, and cancellation. TTL is just the final fallback.

## 12. Self-check for Completion

All items must be done to be considered complete:

- [ ] `git describe` displays `release-1.1.1`.
- [ ] Docker Engine is running and using Linux containers.
- [ ] Server `/health` and `/version` are operating normally, and `/docs` is accessible.
- [ ] Have encountered a 401 once and know how to fix it.
- [ ] Python script can create an Alpine sandbox, run commands, print output, and destroy it.
- [ ] Can use `docker ps` to prove the sandbox really existed.
- [ ] Can explain the differences between `close()`, `kill()`, and `destroy()`.
- [ ] Can explain the relationship between default TTL and explicitly set `timeout`.

### Reference Answers

1. **What is the default TTL?** The default `timeout` of `Sandbox.create` is 10 minutes; explicitly passing in a value will override the default.
2. **Is `timeout=None` "never expires"?** No. It indicates entry into manual cleanup mode, with no automatic expiration deletion, which carries a higher leakage risk.
3. **Is the sandbox always available when creation returns?** The SDK by default waits until it is executable, but server creation itself is asynchronous; the original HTTP request may first see `Pending`.
4. **Why should 401 not be retried?** Credential issues do not improve with retry; keys, domain, or authentication configuration should be corrected.

## 13. Common Issues Quick Reference

| Symptom | Cause | Handling |
| --- | --- | --- |
| `dockerDesktopLinuxEngine` not found | Docker Desktop is not started or not using Linux containers | Start Docker Desktop and ensure Linux containers |
| Server starts and immediately exits, requiring confirmation of no authentication risk | `server.api_key` is empty | Set `api_key`; do not mask configuration errors with `OPENSANDBOX_INSECURE_SERVER=YES` in CI |
| SDK returns 401 | The three keys are inconsistent | Check `~/.sandbox.toml`, `ConnectionConfig(api_key=...)`, and CLI configuration |
| `Sandbox.create` keeps waiting for readiness | Container not created / Image pull failed / execd unavailable / Port conflict / Insufficient resources | Check `docker ps -a`, server logs, execd image, ports, and resource limits in order |
| Command succeeds but no output is seen | Only the first stdout chunk was taken | Iterate `logs.stdout`, while checking `stderr`, `execution.error`, `exit_code` |
| Connection fails after sandbox expires | TTL is absolute time | For long tasks, renew according to budget; renewal is `now + duration`, not cumulative |
| PowerShell refuses to activate scripts | Execution policy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |

## 14. After Completion

You have obtained three baselines. In the next stage, do not repeat installation, but start building a global map:

- The boundary between server API and SDK;
- How the Docker runtime is selected;
- Why execution requests bypass the lifecycle server;
- Which layers a single creation goes through in the source code.

Enter the next chapter with a specific question: **"After I press `Sandbox.create`, which layer exactly does what at what time?"**

Proceed to [Stage 1](../stage-1/).

---

*Accompanying [Learning Path](../learning-path/) Stage 0 draft · 2026-10-30 · Based on release-1.1.1 (`531700ca`)*
