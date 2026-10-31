---
title: "Stage 6: Interfaces and Contracts"
description: "Contracts, SDK, CLI, and MCP: How a single blueprint can grow multiple entry points."
---

> Phase Response: For the same set of capabilities, why are there four ways to use them: SDK, CLI, MCP, and raw HTTP? Are the SDKs in five languages based on the same code? If you modify a field, which order should you follow?  
> Expected 3–4 days. The core output is a **entry selection table** and a **contract change sequence list**.

## Why this step is needed

In the first five phases, you have been using the Python SDK. This creates a subtle misconception: **the SDK is the system itself**.

Once the scenario changes, the misconception breaks:

- Operations need to create sandboxes in CI and don't want to install Python dependencies → use `osb`.  
- Coding agents need to call sandbox operations via a tool without writing code → use MCP.  
- Another team is writing a service in Go and finds method names are different from Python → suspect the documentation is outdated.  
- You add a field to the server; Python can read it, but Kotlin throws an error → don't know which layer to modify first.

The common root of these problems is: OpenSandbox is not an SDK but **a public contract with multiple consumers**.

```text
                 specs/(public contract, the only truth)
                    |
      +-------------+-------------+-------------+
      |             |             |             |
   Python SDK    JS/TS SDK     Kotlin SDK     C# / Go SDK
      |             |             |             |
      +-------------+------+------+-------------+
                         |
                    lifecycle server / execd / egress
                         ^
                         |
                  osb CLI        MCP server
```

When reading this diagram, focus on two things:

1. **Arrow direction**: Contracts are on top, implementations are below; both SDK and CLI are consumers, not the control plane.
2. **Multiple implementations can exist at the same layer**: Different languages, different entry points, but behavior must be aligned.

## A metaphor: blueprints, elevator, reception, intercom

Think of OpenSandbox as a building:

```text
specs/     = Architectural drawings (public contracts, defining where the doors are and how the house numbers are assigned)
SDK        = Elevator (the most direct way to go upstairs, press the floor button)
CLI = Front desk (can handle tasks without writing code, suitable for scripts and manual operations)
MCP = Walkie-talkie (a restricted panel for Agent, only some buttons are enabled)
Primitive HTTP = Climbing stairs (you can get anywhere, but you have to walk each floor yourself)
```

Trade-offs among the four entry points:

| Entry Point | Suitable For | Cost |
| --- | --- | --- |
| SDK | In-app integration, needs type and error semantics | Requires dependencies, version must match the server |
| CLI | Scripts, CI, manual troubleshooting | Process-level invocation, not suitable for high-frequency embedding |
| MCP | Agent tool invocation | Only exposes a subset, state in local registry |
| Raw HTTP | Teaching, debugging, minimal cross-language integration | You handle all the details yourself |

## Step 1 · Understand the four public contracts

`specs/` Below is not a "reference document," but the **source of the contract**:

| File | Constrains Whom | Default Port | When You Read It |
| --- | --- | --- | --- |
| `sandbox-lifecycle.yml` | lifecycle server | `8080` | Create/query/pause/delete, endpoint resolution, snapshots |
| `execd-api.yaml` | execd inside sandbox | `44772` | Commands, sessions, files, PTY, metrics |
| `egress-api.yaml` | egress sidecar | `18080` (client default) | Outbound policies, credential binding |
| `diagnostic-api.yml` | diagnostics interface | As deployed | Stable logs and events of `osb diagnostics` |

Three usage principles:

1. **Fields follow the spec, not an SDK's model class.** SDKs may lag behind or provide convenience wrappers.
2. **Status codes follow the spec.** For example, create returns `202`, delete returns `204`, pause/resume returns `202`; these are not implementation details.
3. **Do not rely on behaviors not mentioned in the spec.** Even if a version happens to support them, they do not constitute a contract.

Stage 1 already had you manually create, resolve endpoints, and delete; the purpose of those three experiments was to have you take the "stairs" outside the "elevator," so you know what each step looks like.

## Step 2 · Layering of generated code and handwritten code

The SDKs of each language roughly have three layers inside:

```text
Level 1: generated client
         OpenAPI -> model class + lower-level HTTP method
         Field names, enums, and status codes correspond one-to-one with the spec
         Do not provide business conveniences, do not hide details

Layer 2: handwritten adapters
         Convert low-level responses into a user-friendly model
         Handle default values, error mapping, and state normalization
         For example, turn HTTP error into SandboxException family

Layer 3: services / facade
         Sandbox.create, commands.run, files.read_file this type of entry
         Responsible for scheduling, polling, health checks, and resource cleanup
```

Why divide it into three layers? Because the two types of changes occur at different speeds:

```text
Contract Change -> Regenerate Layer 1
Semantic change -> Modify the 2nd and 3rd layers
Mixing the two together -> Each generation overwrites the handwritten logic, or the handwritten logic blocks the contract upgrade
```

### A Hard Rule

> **Do not treat 'modifying generated code' as the only fix.**

If the generated output is incorrect, first modify the spec or generation configuration, then regenerate; if it's just an inconvenient usage, modify the handwritten adapter layer. Directly changing generated files will be lost the next time generation runs.

Kotlin's generated artifacts are under directories like `build/generated/**`; Python's generated client is under `opensandbox/api/lifecycle` and `opensandbox/api/execd`. When you see these paths, assume they are "read-only."

### A Specific Example: Status Strings

The server may return a new status value, while a certain SDK's constant enum has not yet been updated. The handwritten layer should **tolerate unknown values** instead of crashing:

```python
# Concept illustration: Keep unknown states as strings instead of forcibly mapping them
state = raw.get("state", "Unknown")
known = {"Pending", "Running", "Pausing", "Paused",
         "Resuming", "Stopping", "Terminated", "Failed"}
if state not in known:
    logger.warning("unknown sandbox state: %s", state)
```

This type of "normalization" logic belongs to Layer 2, not the generation layer. Stage 3's `normalize()` is also the same kind of thing: taking unstable low-level outputs and converging them into a stable form that the Agent can consume.

## Step 3 · Five languages: same ability, different habits

1.1.1 Sandbox SDK coverage:

```text
sdks/sandbox/python
sdks/sandbox/javascript
sdks/sandbox/kotlin
sdks/sandbox/csharp
sdks/sandbox/go
```

Note that the JVM branch is a **Kotlin package**, do not guess based on Java naming conventions.

| Language | Asynchronous Model | Typical Style | Pay Attention When Reading Documentation |
| --- | --- | --- | --- |
| Python | `async/await`, additionally `opensandbox.sync` synchronous wrapper | Context managers, exception classes | The synchronous API is not a separate implementation; semantics should align |
| JavaScript/TypeScript | Promise | Type definitions released with the package | Distinguish between generated types and handwritten types |
| Kotlin | Coroutines/suspend functions | Build artifacts contain generated code | Method names may be closer to HTTP semantics |
| C# | `async/await` `CancellationToken` | Strongly typed model | Distinguish cancellation semantics from timeout |
| Go | `context.Context` explicit `error` return | No exceptions, errors return layer by layer | Do not expect "throw exception" style error handling |

### The Correct Way to Align Across Languages

Do not search for Python method names in other languages. Alignment should be based on **capabilities**:

```text
Ability: Create a sandbox with TTL
  Python:     Sandbox.create(image, timeout=...)
  JS/TS: Corresponding create + timeout option
  Kotlin:     Corresponding builder/parameter
  C#:         Corresponding CreateAsync +  parameter
  Go:         Create(ctx, req) (Sandbox, error)
```

To determine whether a certain language supports a certain capability, look at three places: the language's docs page, the SDK's publicly exported functions, and whether the corresponding field exists in the spec. If any one of the three is missing, it should be marked as conditionally supported.

### Boundaries of Synchronous Wrappers

Python's `opensandbox.sync` provides synchronous entry points like `SandboxSync`, suitable for scripts and blocking frameworks. But there are two easily misunderstood points:

- It's not "another server"; the underlying layer still uses the same HTTP contract.
- The timeout, retry, and cleanup semantics in the synchronous entry must be consistent with the asynchronous version; if inconsistencies are found, that is a bug, not a "feature of the synchronous version."

## Step 4 · Python SDK Structure: From Entry Point to Adapter

Take the Python you are most familiar with as an example, and map the three layers to specific paths:

```text
opensandbox/sandbox.py Entry and orchestration (create / connect / pause / kill)
opensandbox/services/*.py              Domain Services (commands / files / egress / ...)
opensandbox/adapters/converter/*.py    Request and Response Conversion
opensandbox/api/lifecycle/...          Generate Client (lifecycle)
opensandbox/api/execd/... Generate client (execd)
opensandbox/models/*.py                Model exposed to the user
```

The full path of a request:

```text
Sandbox.commands.run(...)
  -> Assemble RunCommandOpts
  -> ExecutionConverter Generate request body
  -> Generate client to send HTTP to execd
  -> SSE Event Analysis
  -> Execution model (text / exit_code / error)
  -> Your code
```

This path explains several conclusions from Stage 3:

- Why `text` does not include stderr: the model is defined that way.
- Why `exit_code` might be `None`: inference logic only provides a value when there is `error` or `complete`.
- Why timeout should be placed in `RunCommandOpts`: it is a command-level parameter, not an HTTP client-level parameter.

When reading the SDK, it is recommended to fix an order: **entry method → service → converter → generation model**. Do not start by reading the generated code, as it only contains fields, not intentions.

## Step 5 · CLI: Turn the API into Composable Commands

`osb` is the official command-line client. After installation, first configure the connection:

```bash
osb config init
osb config set connection.domain localhost:8080
osb config set connection.protocol http
osb config set connection.api_key <your-api-key>
osb config show -o json
```

Minimum closed loop:

```bash
osb sandbox create --image python:3.12 --timeout 30m -o json
osb sandbox get <sandbox-id> -o json
osb command run <sandbox-id> -o raw -- python -c "print(1 + 1)"
osb sandbox kill <sandbox-id> -o json
```

### Command Groups

| Group | What It Manages |
| --- | --- |
| `osb sandbox` | Lifecycle: create, query, renew, pause, delete |
| `osb template` | Template (golden image) construction |
| `osb snapshot` | Snapshot management |
| `osb command` | Command execution and persistent sessions |
| `osb file` | File and directory operations |
| `osb egress` | Runtime outbound policies |
| `osb diagnostics` | Stable diagnostic logs and events |
| `osb devops` | Experimental old diagnostic entry, do not use for new scripts |
| `osb config` | Local configuration |
| `osb skills` | Built-in skills for AI tools |

### Output format determines whether it can enter the pipeline

`-o json` is suitable for program consumption, `-o raw` is suitable for passing command output directly to the next program. When writing scripts, follow two rules:

1. **Always explicitly specify the output format**, do not rely on the default human-readable format.
2. **Do not parse human-readable text**, field order and wording may change.

The CLI also comes with built-in skills for coding Agents (`osb skills`). Its value is not just "an extra command," but turning "how to safely call the sandbox" into reusable operational instructions—this is already close to the theme of stage 7.

## Step 6 · MCP: Restricted Dashboard for Agents

The MCP server exposes a portion of the Python SDK capabilities as tools. Its positioning is a **controlled subset**, not the full API.

### Tool List (1.1.1)

Sandbox Management:

```text
sandbox_create        sandbox_connect      sandbox_kill
sandbox_get_info      sandbox_list         sandbox_renew
sandbox_healthcheck   sandbox_get_metrics  sandbox_get_endpoint
```

Command execution:

```text
command_run           command_interrupt
```

File System:

```text
file_read             file_write           file_delete
file_search           file_create_directories
file_delete_directories                    file_move
file_replace_contents
```

### Two Key Mechanisms

**1. Local Registry.** All tools operate around `sandbox_id`, and this ID is registered locally by `sandbox_create` or `sandbox_connect`. Agents cannot just invent an ID to operate—it's both a convenience and a constraint.

**2. Transport Method.** stdio is suitable for local IDE/client invocation; Streamable HTTP is suitable for remote or multi-client scenarios. Which one you choose determines who can connect, how authentication is handled, and where logs are stored.

### Why MCP Doesn't Expose All Capabilities

Because tools are chosen by models, not programmed by developers. Exposing too many low-level parameters brings three problems:

- Models can easily combine dangerous operations (arbitrary mounts, arbitrary network policies).
- Tool descriptions become longer, reducing selection accuracy.
- Permission boundaries become difficult to audit.

So the right mindset is: **MCP is the "safe common interface," SDK is the "full interface."** When complex capabilities are needed, write a controlled server-side tool instead of handing the entire SDK to the model.

## Step 7 · Contract Change: Which Layer to Change First

Suppose you want to add a field `priority` to the creation request. The correct order is:

```text
1. specs/sandbox-lifecycle.yml        Define fields, types, whether required, and default values
2. Generate Client                        Regenerate low-level models for each language
3. Server implementation: validation, persistence, return
4. Handwritten Adaptation Layer                        Expose convenient parameters, error mapping, default values
5. docs / examples                   Update usage and migration instructions
6. Test                              Contract testing +  All languages SDK Test
```

Common Mistake Order:

| Wrong Approach | Consequence |
| --- | --- |
| Modify the server first, then update the spec | Contract and implementation drift, other languages cannot keep up |
| Only change the Python SDK | Inconsistent behavior across languages, users may think "the documentation is wrong" |
| Directly modify generated files | Will be overwritten next generation, problem recurs |
| Make new fields required | Breaks old clients, considered a breaking change |
| Do not update docs | Users can only read the source code and guess behavior |

### Compatibility Judgment

| Change | Nature | Handling |
| --- | --- | --- |
| Add optional fields | Backward compatible | Can be released with the version |
| Add response fields | Usually compatible | Clients should tolerate unknown fields |
| Change field meaning | Breaking | Migration instructions or new fields are needed |
| Change status code | Breaking | Must go through contract review |
| Delete fields/enum values | Breaking | Deprecation period is required |

Stage 0 mentioned "outputs need to provide evidence," similarly here: **evidence of contract changes is spec diff, generated artifact diff, test results**, not just a statement "I have fixed it."  

## Step 8 · Experiment

> Note: The following experiments only require a usable lifecycle server; if there is no server, you can just do the static reading part and mark it as "not run."  

### Experiment E1 · The Same Thing, Three Approaches

Create the same sandbox in three different ways:

```bash
# 1) CLI
osb sandbox create --image python:3.12 --timeout 5m -o json

# 2) Original HTTP
curl -s -X POST http://localhost:8080/v1/sandboxes \
  -H "OPEN-SANDBOX-API-KEY: dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"image":{"image":"python:3.12"},"timeout":300,"entrypoint":["tail","-f","/dev/null"]}'

# 3) Python SDK (Script for Stage 0)
```

Compare the three request bodies: Which default values did the SDK and CLI fill in for you? Which fields were filled in by the server? Put the differences into a table, and you will understand what the 'convenience layer' is doing.

### Experiment E2 · Finding the boundary between generated and handwritten

Follow a trace in the Python SDK:

```text
Sandbox.commands.run
  -> opensandbox/services/commands.py
  -> opensandbox/adapters/converter/command_execution.py
  -> opensandbox/api/execd/...
```

Mark which layer handles `exit_code` inference and which layer only does field mapping. Then answer: if a new SSE event type needs to be supported, which layer should be modified?

### Experiment E3 · Reading the Same Capability Across Languages

Open `docs/sdks/python.md`, `javascript.md`, `kotlin.md`, `csharp.md`, `go.md`, only look for the two actions "create sandbox" and "execute command," and list the method names and parameter styles for each.

Do not evaluate "which is better," just record the differences. The goal is to establish the habit of "retrieving by capability," not memorizing method names.

### Experiment E4 · CLI into Pipeline

```bash
SID=$(osb sandbox create --image python:3.12 --timeout 5m -o json | jq -r '.id')
osb command run "$SID" -o raw -- python -c "print(6 * 7)"
osb file write "$SID" /workspace/answer.txt -c "42" -o json
osb file cat "$SID" /workspace/answer.txt -o raw
osb sandbox kill "$SID" -o json
```

If `jq` is not available, use Python to parse JSON. The key point is: **Take the ID from the output, do not copy it manually.**

### Experiment E5 · Minimal Closed Loop of MCP

Start the MCP server (stdio or HTTP) and follow the minimal process in the README:

```text
sandbox_create -> command_run -> file_read -> sandbox_kill
```

Observe two things: `sandbox_id` is how it is registered locally; which SDK capabilities cannot be found in the tool list. The second thing is the places where you will need to add 'controlled tools' in the future.

### Experiment E6 · Contract Change Simulation (Read-Only)

Find an optional field in the spec and trace it to the models of the SDKs in three languages. Answer:

- If this field is changed to required, which clients will break?
- If a new enum value is added, which languages will fail to deserialize?
- After regenerating the code, which parts of the handwritten layer need to be modified?

You don't really need to change the spec; just clearly write out the impact.

## Quick Troubleshooting

| Phenomenon | What to check first | Common root causes |
| --- | --- | --- |
| 401 | `OPEN-SANDBOX-API-KEY`, CLI config | No key configured, configured to another profile |
| 404 | Path prefix, sandbox ID | Missing `/v1`, ID expired or typed incorrectly |
| SDK reported field does not exist | SDK version vs server version | Client is lagging behind or ahead of the server |
| Cross-language behavior differences | Handwriting layers for each language | Default values/error mapping not aligned |
| CLI output parsing failed | `-o` format | Parsed human-readable output |
| MCP tool reports unknown sandbox | Local registry | No prior create/connect, or process restart loses state |
| Generated code changes lost | Changed `generated/**` | Should modify spec or generation configuration |
| New state causes crash | State enumeration | Handwritten layer does not tolerate unknown values |

## Common Misconceptions

| Misconception | Correction |
| --- | --- |
| "SDK is just a list of server capabilities" | SDK is on the client side; capabilities are also limited by server version, configuration, and runtime |
"Five languages are translations of the same code" | Shared contract, implemented individually; details may vary |
| 'Synchronous SDK is another implementation' | Blocking wrapper of the same contract, semantics should align |
| 'CLI is another control plane' | It is just a client of the lifecycle API |
| 'MCP can do as much as the SDK' | MCP is a controlled subset, complex capabilities need to be encapsulated by yourself |
| 'Changing the generated code counts as fixing it' | Next time it's generated it will be overwritten; the source should be changed |
| 'It's okay if the response has an extra field, it can be ignored' | The client must tolerate unknown fields, but the server cannot arbitrarily change the meaning |
| 'If the documentation doesn't mention it but the code supports it, it can be used' | Behavior not in the spec does not constitute a contract |

## Self-Check and Reference Answers

**1. Why is `specs/` said to be the only truth?**

Because the server, execd, various language SDKs, and CLI are all implemented around it. Changing only one layer will cause drift; only the spec can constrain all consumers at the same time.

**2. What are the responsibilities of generated code and handwritten code respectively?**

The generation layer is responsible for the model corresponding one-to-one with the contract and low-level calls; the handwritten layer is responsible for business semantics such as default values, error mapping, state normalization, polling, and cleanup. Mixing the two can cause generated logic to override handwritten logic.

**3. What is the relationship between Python's synchronous SDK and asynchronous SDK?**

Two invocation styles of the same contract. The synchronous version is a blocking wrapper and should not have independent semantics; any observed behavior differences should be treated as defects.

**4. To determine whether a language supports a certain capability, which three aspects should be considered?**

This language documentation, SDK public export, and corresponding fields in the spec. If any one of the three is missing, it should be marked as conditionally supported.

**5. Why does the CLI output need to explicitly specify the format?**

Because the default format is intended for humans, the order of fields and wording may vary. Scripts should use `-o json` or `-o raw` to avoid parsing changeable text.

**6. Why does MCP only expose a subset?**

Tools are selected for the model. Exposing all low-level parameters increases the risk of misuse, reduces selection accuracy, and makes permission boundaries difficult to audit.

**7. Add fields to the create request, what is the correct order?**

spec → regenerate → server implementation → handwritten adapter layer → documentation/examples → testing. Changing the implementation first will cause contract drift.

**8. Which contractual changes are considered destructive changes?**

Change the meaning of fields, modify status codes, delete fields or enum values, or change optional fields to required. Migration instructions or transition for new fields are needed.

**9. Why does the client need to tolerate unknown state values?**

The server may add states before the SDK. If the handwritten layer enforces strict mapping, it will turn new normal states into crashes. The correct approach is to keep the original value and log a warning.

**10. Is it still necessary to learn raw HTTP?**

It is necessary. It is the shortest path to check SDK behavior, cross-language minimal integration, and understand contracts; it is also the dividing line for determining whether it is an 'SDK issue or a server-side issue'.

## Key Source Code Coordinates

| Questions You Want to Answer | Take a Look First |
| --- | --- |
| Lifecycle Contract | `specs/sandbox-lifecycle.yml` |
| execd Contract | `specs/execd-api.yaml` |
| egress/Credential Contract | `specs/egress-api.yaml` |
| Diagnostic Contract | `specs/diagnostic-api.yml` |
| Python Entry and Orchestration | `sdks/sandbox/python/src/opensandbox/sandbox.py` |
| Python Handwritten Adapter | `sdks/sandbox/python/src/opensandbox/adapters/`, `services/` |
| Python Generated Client | `sdks/sandbox/python/src/opensandbox/api/` |
| SDK Documentation for Various Languages | `docs/sdks/*.md` |
| CLI Usage and Command Groups | `cli/README.md`, `docs/cli/index.md` |
| MCP Tools and Startup | `sdks/mcp/sandbox/python/README.md` |
| SDK Development Conventions | `sdks/AGENTS.md` |

## After Completing

You should now be able to treat "which entry to use" as an engineering decision rather than a personal preference; and when modifying contracts, you can move each layer in the correct order.

The next stage hands these entries over to the real protagonist: **Agent**. When the model decides by itself to create sandboxes, execute commands, or read files, tool contracts, budgets, retries, and context management will become new challenges.

Take this question into the next chapter: **"After handing the sandbox to the model, who ensures it doesn't go out of control?"** Go to [Stage 7](../stage-7/).
