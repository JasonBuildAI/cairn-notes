---
title: "Stage 5: Network and Credentials"
description: "Endpoints, ingress, egress, and Vault: three gates that are closed by default."
---

> Current stage response: How can the outside access the sandbox? Who can the sandbox access? How can a key be used but not retrievable?  
> Estimated 3–4 days. The core output is a one-page **network policy design** (default actions, allowed targets, credential binding, failure strategy, audit items), rather than just being able to write a single allow rule.  

## Why this step is needed  

By the end of Stage 4, the sandbox can already run, and execd can execute commands. But being "able to run" is still three steps away from "being able to connect to the network safely":

```text
First question: Who can come in and find it?        -> ingress
The second way: Who can it go out to find? -> egress
Question three: When it goes out to run errands, who should the keys be given to? -> Credential Vault
```

If only one of these three gates is implemented correctly, the other two will become vulnerabilities:

- Only implementing ingress: the sandbox can freely access the external network, and the model can send out data with just one `curl`.
- Only implementing egress: external parties cannot access services inside the sandbox, making it impossible for the Agent to preview web applications.
- Implementing both but not credential proxy: to call APIs, you would have to put the real keys into environment variables, which any process inside the sandbox can read.

What's more troublesome is that these three gates are **not automatically enabled just by configuration**; they come with conditions: runtime, network mode, whether policies were declared at creation, whether the server enables proxies, and whether the version is adequate. The "capability conditions" awareness established in Stage 4 will first truly come into play here.

First, remember this summary table:

| Capability | Problem it solves | Not universal |
| --- | --- | --- |
| Ingress | How the outside can access ports inside the sandbox | Does not handle outbound security |
| Egress | Which external targets the sandbox can access | Requires the correct mode and sidecar must be attached at creation |
| Credential Vault | How keys do not enter the sandbox | Not an encrypted file cabinet and does not cover all backends |

## A metaphor: three gates and a front desk

Think of the sandbox as an offsite workstation:

```text
Visitor entrance (ingress): If a client wants to come in for a meeting, there needs to be a door number, and the reception must guide them.
Freight Gate (egress): The workspace needs to receive and send express packages, but can only use whitelisted addresses.
Frontend proxy swiping (vault): When calling external services, the frontend uses a real access card to swipe
                   The person in the workshop only received a note that said 'Authorized'.
```

This metaphor can explain several real behaviors:

- House numbers are not fixed: endpoints need to be **resolved**, they cannot be hardcoded.
- When visitors cannot get in, you need to distinguish between 'the room does not exist' (404), 'the room is not ready yet' (503), or 'the building's infrastructure is broken' (502).
- The cargo door is closed by default: without a policy, it doesn't mean 'everything is allowed', but rather 'there is no passage'.
- The premise of the front desk proxy is that 'the visitor door has already been registered according to the rules', so Vault requires a network policy when it is created.

## Step 1 · First draw the four chains

### Inbound

```text
Client
  -> ingress gateway (or server proxy)
  -> Target port inside the sandbox
```

Kubernetes sandboxes are usually ClusterIP-only, and clients cannot assume they can directly connect to the Pod IP. The gateway is responsible for translating 'sandbox ID   port' into the real backend.

### Outbound

```text
Sandbox process -> DNS / Network stack -> egress sidecar -> target service
```

The egress sidecar shares the **network namespace** with the sandbox and enforces policies on the data path. It is not 'another container forwarding for you,' but 'the gateway for all your outbound traffic.'

### Credential Agent

```text
Trusted control plane -> Write real credentials into egress sidecar memory
Sandbox process -> Only sees fake/empty value or placeholder
Egress HTTPS -> sidecar matches binding and injects authentication headers
Upstream Service -> Received Real Authentication Information
```

### Endpoint Analysis

```text
sandbox.get_endpoint(port)
  -> {"endpoint": "...", "headers": {...}}
  -> The client accesses according to the returned address and headers
```

The complete definition of being "network-capable" is only realized when all four links are combined. If any one is missing, it should be documented as a condition, not as "supported."  

## Step 2 · Endpoint Resolution: Do Not Hardcode Addresses  

Many issues like "works locally, 404 in the cluster" are fundamentally caused by hardcoding addresses. Docker uses port mapping, Kubernetes uses Service/Gateway, and FastSandbox has its own entry method; the same port number has different meanings under different topologies.  

Correct order:

```text
1. Tune get_endpoint(port)
2. Use the returned endpoint and headers
3. Confirm the protocol and timeout when a long connection is needed
4. When sharing externally, use a time-limited signed URL instead of a long-term token
```

### Return Structure

The response of endpoint 1.1.1 is:

```json
{
  "endpoint": "http://...",
  "headers": {
    "OpenSandbox-Ingress-To": "..."
  }
}
```

Key Points:

- **`endpoint` and `headers` should be used together.** If you only take the URL without the header, the gateway may not know which sandbox port to route to.
- Under different deployments, `headers` may be empty; do not assume that a certain header always exists.
- Different ports of the same sandbox should be parsed separately; you cannot use the address of 44772 to access 8000.

### Server Proxy Mode

When parsing the endpoint of a request, you can require it to go through a server proxy (`use_server_proxy=true`). At this time, the server will rewrite the endpoint to:

```text
/sandboxes/{id}/proxy/{port}
```

And remove the ingress routing header. The advantage of this path is that the client does not need to understand the gateway topology; the cost is that the traffic passes through an additional server hop, and both capacity and timeout are constrained by the server.

### Source Mark of Template Sandbox

Sandboxes starting with `fsb-` will carry a source header like `OPEN-SANDBOX-ORIGIN: template` in the endpoint response. It is not decorative: clients and operations rely on it to distinguish that "this sandbox is using the Template/FastSandbox path," so they know which capabilities (e.g., sandbox-side Vault) are not applicable.

### Signed Route

After enabling secure access (Kubernetes gateway mode), endpoints can include an expiration time to exchange for a time-limited signed route. It is suitable for "temporarily sharing this service with a browser or third party," but not for a long-term API address. After the signature expires, it needs to be re-resolved rather than reusing the old URL.

## Step 3 · Inbound: Routing Modes and Three Types of Errors

### Three Routing Modes

`[ingress.gateway].route.mode` supports:

| Mode | How to find the target | Suitable for |
| --- | --- | --- |
| `header` | Request header carries sandbox port | SDK/client that can customize headers |
| `uri` | The first two segments of the path are `/<sandbox-id>/<port>/...` | Browsers/simple clients that cannot modify headers |
| `wildcard` | Hostname encodes sandbox port, requires wildcard domain | Deployment with one subdomain per sandbox |

Values for the header mode are like:

```text
OpenSandbox-Ingress-To: <sandbox-id>-<port>
```

But **do not assume a default mode**. It is determined by the server configuration, and the client should follow `endpoint + headers` returned by `get_endpoint()`. Hardcoding code to 'it must be header mode' will break with a different deployment.

### Three Errors, Three Troubleshooting Paths

| Status | Meaning | Check first |
| --- | --- | --- |
| `404` | Sandbox does not exist or has been deleted | Whether the ID or TTL has expired, or if it used the wrong namespace |
| `503` | Sandbox exists, but no available endpoints yet | Whether Pod/container is Ready, whether execd port is listening |
| `502` | Infrastructure or cluster API layer failure | Connection from gateway to backend, Service/Endpoint, gateway logs |

These three cannot be retried in the same way: retrying 404 is meaningless, 503 should back off and wait, 502 requires checking infrastructure.

### WebSocket

WebSocket is a first-class capability but has limits:

- Single message limit is 64 MiB.
- Upgrades use HTTP/1.1.
- If the front TLS proxy only supports HTTP/2, the upgrade may not reach the ingress.

This is also why 'endpoint resolution' needs to carry protocol information: not all endpoints are suitable for the same client.

## Step 4 · Outbound: Deny by default, allow explicitly

### First, confirm if the sidecar is present

This is the most important sentence in this stage:

> **The platform only prepares outbound controls for the sandbox if the creation request carries `networkPolicy` (or the template/Pool fixed the policy at pre-creation).**

So the following path usually will not work:

```text
First, create a sandbox with a fully open network
  -> Think about patching an egress rule again
  -> Found no execution surface
```

egress is not a "switch while running," but an "attachment at creation." If outbound governance is needed, declare it at creation.

### Policy Model

The model in the Python SDK is `NetworkPolicy(default_action=..., egress=[NetworkRule(...)])`, and the default action is `deny`:

```python
from datetime import timedelta

from opensandbox import Sandbox
from opensandbox.config import ConnectionConfig
from opensandbox.models.sandboxes import NetworkPolicy, NetworkRule

config = ConnectionConfig(
    domain="localhost:8080",
    api_key="dev-secret",
    request_timeout=timedelta(seconds=60),
)

policy = NetworkPolicy(
    default_action="deny",
    egress=[
        NetworkRule(action="allow", target="pypi.org"),
        NetworkRule(action="allow", target="*.pythonhosted.org"),
    ],
)

sandbox = await Sandbox.create(
    "python:3.12",
    connection_config=config,
    timeout=timedelta(minutes=15),
    network_policy=policy,
)
```

### Verification should be done both positively and negatively

First, verify the allowed paths:

```python
allowed = await sandbox.commands.run(
    ["python3", "-c",
     "import urllib.request; print(urllib.request.urlopen('https://pypi.org', timeout=5).status)"]
)
print(allowed.exit_code, allowed.text, allowed.error)
```

Re-verify rejection path:

```python
blocked = await sandbox.commands.run(
    ["python3", "-c",
     "import urllib.request; urllib.request.urlopen('https://example.com', timeout=5)"]
)
print(blocked.exit_code, blocked.text, blocked.error)
```

Do not only look at `execution.text`: it does not include stderr. The exit code and `error` are the criteria for judgment (this semantics has already been explained in stage 3).

### Priority: The platform's deny always overrides your allow

The matching order given in the official documentation:

```text
Platform deny.always
  -> Platform allow.always
    -> User Rules
```

The meaning is very straightforward:

- Targets prohibited by the administrator cannot be overridden even if you write allow.
- Targets forcibly allowed by the administrator may still be accessible even if you default to deny.
- Maintenance overlays can be hot-updated, so the "effective policy" you see may not be the same as the JSON you submitted.

This explains a common confusion: "I clearly only allowed A, so why can B also go through?" Check the platform-level allow first, rather than suspecting your own rules are wrong.

## Step 5 · `dns` and `dns+nft`: Different strengths, different boundaries

| Mode | What it does | What it can prevent | What it can't prevent |
| --- | --- | --- | --- |
| `dns` (default) | Intercepts/parses DNS, returning NXDOMAIN for unallowed domains | Normal domain-based access | Applications connecting directly via IP, bypassing DNS; CIDR/IP rules don't take effect |
| `dns+nft` | DNS filtering, nftables drops by default, temporarily allowing based on resolution results | Stricter default packet-level deny, supports CIDR/IP constraints | Misconfigured allowances, application-layer data leakage, all non-network risks |

In one sentence:

> **Restricting only DNS does not mean only a certain domain is allowed.** If the code connects directly to `203.0.113.10`, DNS is not involved at all.

Recommendation:

- Only care about "can resolve and access these domains" → `dns` is enough.
- Need static IP/CIDR constraints, or require credential proxy → `dns+nft`.
- Confirm backend, kernel, and runtime support before using `dns+nft`.

`[egress]` also has several condition-related configurations:

- `image`: **required** when client sends `networkPolicy`.
- `mode`: default `dns`; credential proxy requires `dns+nft`.
- `disable_ipv6`: default `true`, because IPv6 egress (especially on Kubernetes) is still incomplete.
- `upstream_proxy`: let egress chain to upstream HTTP(S) CONNECT proxy, requires `dns+nft`.
- `readiness_timeout_seconds`: duration to wait for sidecar health under Docker.

## Step 6 · Runtime modification: merge, not replace

After creation, rules can be incrementally modified:

```python
await sandbox.patch_egress_rules([
    NetworkRule(action="allow", target="files.pythonhosted.org"),
])

current = await sandbox.get_egress_policy()
print(current.default_action, current.egress)
```

You must understand the semantics:

- **Patch means merge.** New rules override old rules for the same target, while rules for other targets are retained.
- **Patch does not change `default_action`.** Don't assume that adding an allow rule turns the default deny into allow.
- **Deletion is idempotent.** `delete_egress_rules(targets)` does not report an error for a non-existent target.

Runtime mutation is suitable for short-term, controlled exceptions and is not meant to let the model "open the network for itself." Even if the model can use the patch tool, server-side approval, a target whitelist, and audit logs are still required.

## Step 7 · Credential Vault: Keep secrets in the sidecar

### The goal is not to "encrypt and stuff it in"

The goal of Vault is to ensure that processes in the sandbox **cannot access the real secrets at all**:

```text
The sandbox process sees: fake/empty value or placeholder
Egress request reaches sidecar: match bindings, inject real authentication header
Upstream service received: real credentials
```

So to determine whether an implementation is correct, only one question matters: **Has the real value entered the sandbox's files, environment variables, or process memory?** If it has, then this layer of protection has been bypassed.

### Prerequisites (all required)

- Server `[egress].mode = "dns+nft"`;
- Outbound enabled at creation `networkPolicy`;
- Enabled at creation `credential_proxy=CredentialProxyConfig(enabled=True)`;
- Network policy recommends default deny, explicitly allowing binding to the target host;
- Sandbox Pod cannot have a transparent service mesh sidecar at the same time;
- Backend and SDK versions must meet documentation requirements (egress >= 1.1.1; the example configuration uses `opensandbox/egress:v1.1.7`, component tags and umbrella versions are not the same concept).

Example creation:

```python
from opensandbox.models.sandboxes import CredentialProxyConfig

sandbox = await Sandbox.create(
    "python:3.12",
    connection_config=config,
    timeout=timedelta(minutes=15),
    network_policy=NetworkPolicy(
        default_action="deny",
        egress=[NetworkRule(action="allow", target="api.example.com")],
    ),
    credential_proxy=CredentialProxyConfig(enabled=True),
)
```

Write credentials and binding:

```python
from opensandbox.models.sandboxes import Credential, CredentialBinding

await sandbox.credential_vault.create(
    credentials=[
        Credential(name="api-token", source={"value": "REAL_SECRET_VALUE"})
    ],
    bindings=[
        CredentialBinding(
            name="example-api",
            match={
                "schemes": ["https"],
                "hosts": ["api.example.com"],
                "methods": ["GET", "POST"],
                "paths": ["/v1/*"],
            },
            auth={"type": "bearer", "credential": "api-token"},
        )
    ],
)
```

True values should only be read and written on trusted backends; Do not print to logs, put into model context, or write to sandbox files. The Safe API returns anonymized metadata; do not expect it to show the secret. 

### Rigging Match and Replace

Binding can match scheme, host, method, path, and supports authentication types such as `bearer`, `basic`, `apiKey`, `customHeaders`, `passthrough`, etc. 

`passthrough` can be used with `substitutions` to replace placeholders in path/query/header/body to solve the problem of "some APIs only receiving credentials in URLs or forms." However, replacement is **precise, case-sensitive, and scoped**, so do not treat it as an arbitrary template engine. 

### Three Boundaries of Failure

1. **After pausing/resuming, reinject the secret.** The secret is only in the sidecar memory; successful recovery does not automatically return the secret. After recovery, 401 is the first to suspect this item. 
2. **Template sandboxes do not have sandbox-side Vaults.** Accessing `sandbox.credential_vault` from `template` sources will explicitly throw exceptions; Do not mix platform-level egress with sandbox-side Vaults. 
3. **Sidecar, control plane, and logs remain the trust boundaries.** "Key not in sandbox environment variable" does not mean "system has no key risk." 

## Step 8 · Network isolation and runtime conditions

### The `networkPolicy` mentioned here is not Kubernetes NetworkPolicy

OpenSandbox's `networkPolicy` is a **policy model sent to outbound sidecars**, not a native Kubernetes `NetworkPolicy` resource. The two have the same name but different layers: 

| | OpenSandbox `networkPolicy` | Kubernetes `NetworkPolicy` |
| --- | --- | --- |
| Function | Sandbox outbound objectives and credential injection | Pod-to-Pod/namespace network access control |
| Executor | egress sidecar | CNI plugin |
| Declare timing | Create requests / templates / Pool | Cluster resources, independent of sandbox APIs |

Confusion can lead to incorrect troubleshooting directions: If you write `networkPolicy` in the creation request, a K8s NetworkPolicy will not be automatically generated; Conversely, the K8s policy configured by the cluster administrator will not appear in `get_egress_policy()`. 

### Conflicts with runtime/isolation layers

- **Transparent Service Mesh Sidecar** and egress in the same network namespace will cause override conflicts and cannot be treated as stackable default combinations. 
- **gVisor's netstack** does not support egress's redirect mechanism; When choosing gVisor, you need to revalidate the network scheme, rather than assuming "switch to isolated runtime, everything else remains unchanged." 
- **Docker** To use egress, you must `network_mode = "bridge"`; `host` mode does not have an independent network namespace to insert. 
- The Pod of **Pool** already existed before the request, so the network policy must be fixed to the template and cannot be injected upon request. 

### Failure must be fail-closed

The design should clearly answer: If the egress sidecar crashes, should it be rejected or released? The correct answer is **security failure**, not silent passthrough. Similarly, policy parsing failures, upstream inaccessibility, DNS timeouts should all be explained as request failures, not quietly relaxed. 

## Step 9 · Experiment

> Note: This environment does not have running Docker daemon, egress images, or Kubernetes clusters. D series requires runnable Docker servers; K series requires real clusters. For experiments that have not been executed, please mark them as "unverified." Do not write that the interface exists as validated. 

### Experiment D1 · Endems are parsed, not guessed

After creating the sandbox, resolve the two ports separately:

```python
ep_exec = await sandbox.get_endpoint(44772)
ep_app = await sandbox.get_endpoint(8000)
print(ep_exec.endpoint, ep_exec.headers)
print(ep_app.endpoint, ep_app.headers)
```

Compare the two returns: whether the addresses are the same, and whether the headers are the same. Then try to use the address of `ep_exec` to access port 8000 and observe the failure pattern. The conclusion should be: **the port is not a path parameter, it is an independent endpoint.**

### Experiment D2 · The Positive and Negative of Default Deny

Use the strategy from step 4 to create a sandbox, and access `pypi.org` and `example.com` respectively, recording exit codes, stderr, and elapsed time.

Then do a control test: change `default_action` to `allow`, keeping only the same allow rule, and observe whether unlisted targets are accessible. This control allows you to understand that the "default action" is the main switch of the strategy.

### Experiment D3 · Bypassing DNS with IP (Read-only Deduction)

In `dns` mode, the strategy allows `pypi.org`, then execute:

```bash
python3 -c "import socket; print(socket.gethostbyname('pypi.org'))"
```

After obtaining the IP, directly connect to that IP (for example, using `curl --resolve` or the direct URL). Observe whether it is still reachable in `dns` mode, then switch to `dns+nft` for comparison.

If the environment does not support nftables, write a simulation: what is seen at the DNS layer, what is seen at the packet level, and why the conclusions are different. **The value of this experiment is to break the illusion that 'domain whitelisting = network security.'**

### Experiment D4 · Semantics of patch merging

When creating, allow A and B, patch a new rule for A (change to deny), then `get_egress_policy()`. Expectation: A is overridden, B remains, `default_action` remains unchanged.

Then delete a non-existent target, confirming it is idempotent rather than causing an error.

### Experiment V1 · Proving that the real key does not enter the sandbox

Execute in a sandbox with Vault enabled:

```bash
env | grep -i token
cat /proc/1/environ | tr '\0' '\n' | grep -i token
```

Re-initiate the binding target request and observe for success, then check if any real values appear anywhere in the sandbox. You need to answer: Which layer of injection did the request succeed? What do you see in the sandbox? 

### Experiment I1 · Three types of ingress errors

Separately create: deleted sandbox (404), newly created but not yet ready sandbox (503), and pointing the gateway backend to the error Service (502). Record the response body and log location. 

## Quick Fault Inspection

| Phenomenon | What to check first | Common root causes |
| --- | --- | --- |
| Inbound 404 | sandbox ID, TTL | Expired/Deleted, routed to an incorrect namespace |
| Inbound 503 | Pod/Container Ready, execd port | Endpoint not published, process not listening |
| Inbound 502 | Gateway to backend connection | Service/Endpoint exceptions, gateway configuration errors |
| Creating with a strategy rejected | `docker.network_mode` | If not `bridge`, egress |
| sidecar not up | `[egress].image`, readiness | Missing mirroring, startup timeout |
| Allowed domain name still not working | Platform deny overlay, DNS | Administrator blocked, parsing failed, application used IP |
| Still rejected by default after patch | `default_action` | patch does not modify the default action |
| After recovery 401 | Is the Vault reinjected | The secret is only in the sidecar memory |
| `credential_vault` Throwing anomalies | Sandbox source | Template sandbox does not have a sandbox side Vault |
| Strategies are "sometimes good, sometimes bad" | Is overlay hot-updated | Platform-level rule changes |

## Common Misconceptions

| Misconceptions | Correction |
| --- | --- |
| "After creation, patches can start egress" | Sidecar is part of the creating/pre-creation path; without an execution face, there is no patch |
| "Allowing a domain name blocks the IP" | `dns` only applies to name resolution; Package-level constraints must be `dns+nft` |
| "My allow will definitely take effect" | Deny platform always takes priority, overlay may also hot-update |
| "Vault will put the true key into the environment variable" | The truth value is only in the sidecar; in the sandbox, only fake/empty or placeholders are visible
| "The key will automatically return after recovery" | Trusted control plane reinjection is required |
| "Template sandboxes can also use Vault" | Template sources will explicitly throw exceptions |
| "`networkPolicy` is K8s NetworkPolicy" | The former is the egress sidecar policy model |
| "If the egress collapses, it should be released to avoid affecting business" | Should fail-close; silent direct access equals canceling governance |

## Self-Check and Reference Answers

**1. Why must endpoints be parsed and not written to death?** 

Because different runtimes and deployment topologies differ: Docker uses port mapping, Kubernetes uses Service/gateway, and FastSandbox follows FastPath. Addresses and routing headers are generated by the server according to the current topology; a dead lock will become invalid when switching environments. 

**2. `endpoint` and `headers` Why use them together?** 

The gateway may rely on the request header to identify "sandbox ID + port." If only the URL is taken without a header, routing information is incomplete. Headers may be empty under different deployments, so the parsing result should be the standard, not assuming fixed headers. 

**3. What do incoming stations 404, 503, and 502 respectively indicate?** 

404: Sandbox does not exist or has been deleted; 503: Exists but endpoints are not ready; 502: Infrastructure/cluster API layer failed. Each of these three corresponds to different troubleshooting paths and cannot be retried together. 

**4. Why does it say "only restricting DNS doesn't mean only allowing a certain domain name"?** 

DNS mode only affects name resolution. Applications can directly use IP, implement their own resolution, or take a path that does not pass through the DNS. If you need packet-level assurance, you need `dns+nft`. 

**5. Which takes priority: platform deny or user allow?** 

Platform deny takes precedence over platform allow, platform allow takes precedence over user rules. User rules cannot override targets prohibited by administrators. 

**6. Will patches change default behavior?** 

No. Patch only merges rules, overwrites the same target, retains others; `default_action` remains unchanged. To change the default action, you must restate the policy. 

**7. What problems has Credential Vault solved, and what hasn't solved?** 

Solved the issue of "sandbox processes obtaining the real key": truth values only exist in the sidecar, injection occurs on the exit path. Problems such as sidecar breaches, control planes breached, log leaks, and application layer data leaks have not been resolved. 

**8. Why is Vault required to include network policies and `dns+nft` when created?** 

Because agents must work on a clear set of targets. Default allows unmatched bound requests to leave the site as usual, expanding the scope of leakage; `dns+nft` Provide package-level default rejection to make "only bound targets" valid. 

**9. After the pause to restore 401, what is the most likely reason?** 

The secret of the Vault is only in sidecar memory and does not automatically recover after pause/recovery. It needs to be reinjected from the trusted control plane, rather than writing the secret into a snapshot. 

**10. Why can't the Pool mode pass `networkPolicy` on request?** 

Pool Pods are created before the request, and the network namespace and sidecar configuration are fixed. To distinguish policies by request, you should create them directly or prepare different pools for different policies. 

## Key Source Code Coordinates

| Questions to Answer | First Look |
| --- | --- |
| Client Network Model | `sdks/sandbox/python/src/opensandbox/models/sandboxes.py`'s `NetworkPolicy`, `NetworkRule` |
| Egress and Credential API | `sdks/sandbox/python/src/opensandbox/services/egress.py` |
| Server Egress/Ingress Configuration | `server/configuration.md`'s `[ingress]`, `[egress]`, `docker.network_mode` |
| Endpoint Resolution and Proxy Rewriting | `server/opensandbox_server/api/lifecycle.py` |
| Outbound Architecture and Limitations | `docs/architecture/network/egress.md` |
| Inbound Routing and Error Semantics | `docs/architecture/network/ingress.md` |
| Credential Vault | `docs/guides/credential-vault.md` |
| Secure Endpoints | `docs/guides/secure-access.md` |
| Egress Contract | `specs/egress-api.yaml` |

## After Completing

You should now be able to break down "networking" into four things: resolve endpoints, handle inbound, manage outbound, and hold credentials; and for each, you should be able to state one precondition and one failure boundary. This is much more important than just "knowing how to write allow rules."

The next stage shifts to the developer perspective: with the same set of capabilities, what roles do the five language SDKs, `osb` CLI, MCP, and public contracts play? Which are generated, which are handwritten? If you change a field, in what order should things move?

Take this question into the next chapter: **"Why does the same contract look different in different languages?"** Enter [Stage 6](../stage-6/).
