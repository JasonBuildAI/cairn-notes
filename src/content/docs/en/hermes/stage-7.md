---
title: "Stage 7: Expanding Platforms and Multi-Agent"
description: "Stage 7: Expanding the platform and multiple agents. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: Hermes Agent Source Code Class · Stage Assignment
> Prerequisites: Stage 1, 4, 6
> Corresponding Overview: `core-mechanisms.md` Sections 6–7, `engineering.md` Section 6
> Goal of this stage: Understand how Hermes grows tools, providers, channels, scheduling, and sub-agents, rather than duplicating a set of core loops.

## 1. What this stage addresses

A long-evolving Agent platform will encounter continuous expansion needs:

- Add a read-only tool to the model;
- Add a new toolset;
- Connect a new model provider;
- Receive messages from Telegram, Slack, Discord, or Web;
- Execute tasks on a daily schedule;
- Launch a sub-agent to handle parallel sub-problems;
- Add an RPC method to the TUI;
- Combine capabilities with plugins without modifying the core.

The challenge is not "adding code," but deciding which ownership boundary each type of extension should attach to.

## 2. Remember this rule first

**An extension point only extends one layer of capability, without duplicating the entire turn semantics.**

Correct approach:

~~~text
New Tool         → tools/ + toolsets.py + model_tools Visibility
new provider → ProviderProfile + adapter + credential/fallback
New channel → adapter inbound constructs admission, outbound goes through delivery
New RPC/UI → tui_gateway method +  contract, execution still belongs to the host
New scheduled task     → cron generated internal event/admission
New child Agent → delegate tool + independent execution context + parent retrieves result
New plugin → register capability, does not bypass permissions or persistence
~~~

Counterexamples: The channel adapter constructs `AIAgent` by itself and writes the transcript directly; cron bypasses FIFO and calls the model directly; sub-Agents share the parent transcript and write messily; plugins hide arbitrary side effects during the import phase.

## 3. Mainline Source Code

1. `plugins/plugin_loader.py` supports directory plugins, module loading, relative imports, registration, and bounded wait. The loading lock and deadlock detection indicate that plugin import itself is high-risk management.
2. Plugins usually register tools, providers, channels/capabilities through `register(ctx)` or by inheriting the defined ABCs; it is not a permission sandbox and has the trust to execute arbitrary Python.
3. `toolsets.py` and `model_tools.py` determine the tool surface; new tools must consider schema, platform, authorization, budget, errors, and projections.
4. `providers/base.py` and `providers/__init__.py` are extension points for model providers; user providers are more suitable to be placed in `$HERMES_HOME/plugins/model-providers/`.
5. `gateway/run.py::GatewayRunner` holds the Gateway host, adapter, session runtime, and backend maintenance; inbound message platforms ultimately still go through SessionAuthority.
6. `tui_gateway/session_registry.py` constructs and caches shared backend Agents; `prompt_turn.py` is responsible for prompt input, execution, result absorption, and events.
7. `gateway/run_turn_runner.py::TurnRunner` connects streaming output, tool progress, approvals, and final delivery to a single turn.
8. `cron/scheduler.py` handles due jobs, tick locks, external workers, retries, crash recovery, and delivery; it produces tasks with sources, not another set of Agent semantics.
9. `tools/delegate_tool.py` exposes sub-Agent capabilities; parent and child each have their own context and execution boundaries, with parent Agents obtaining subtask outputs through tool results.
10. `acp_adapter/`, message adapters, and `ui-tui/`, `apps/desktop/` showcase different entry points but should all connect to the host with a unified admission/event protocol.

## 4. Key Objects and Contracts

| Extension | Access Point | Cannot Bypass |
| --- | --- | --- |
| tool | `tools/` schema | toolsets, authorization, approvals, persistence |
| toolset | `toolsets.py` | platform gating, include cycles, recursion |
| provider | `ProviderProfile` adapter | credentials, preflight, tool schema |
| plugin | `plugin_loader` context | trust boundaries, load timeout, sequence |
| skill | skills index volatile prompt | permission logic cannot be written into skill text |
| channel | adapter SessionAuthority | authentication, FIFO, deduplication, delivery |
| RPC/UI | `tui_gateway` contract | execution ownership, session scope |
| cron | scheduler internal event | lease, session isolation, restart recovery |
| subagent | delegate tool | capacity, timeout, parent-child lifecycle |
| MCP | server/tool bridge | tool visibility, approvals, output budget |

For the plugin trust model, it is especially important to remember: plugins can register capabilities and can also execute arbitrary Python. It is not a sandbox that is automatically safe just because it is called a 'plugin.' Source review before installation is necessary, and failures or timeouts during loading must have definite fallback measures.

## 5. An Observable Chain

### Channel Messages

~~~text
Telegram/Discord/Slack event
  → adapter authentication and identity mapping
  Standardized payload
  → SessionAuthority admission
  → FIFO / turn lease
  The same AIAgent core
  → deliver through adapter
~~~

### Sub-Agent

~~~text
parent assistant tool_calls
  → delegate_task
  → child execution context / budget / timeout
  → child result
  → tool result persisted
  → parent continues
~~~

### Cron

~~~text
due job
  → tick lock / owner check
  → internal event or worker
  → session-scoped admission
  → turn execution
  → delivery / retry / crash recovery
~~~

Observation Focus: All paths should ultimately converge on the same main line of 'admission → lease → loop → finalize', rather than each writing a separate while loop.

## 6. Experiments

### Experiment A: Add Read-Only Tool

Implement `list_recent_notes`, add it to the toolset, and verify model visibility, platform restrictions, errors, and oversized outputs.

### Experiment B: Concurrent Cron and Manual Input

Let cron tasks and user inputs of the same session arrive simultaneously, and observe the order of FIFO, lease, and transcript.

### Experiment C: Sub-Agent Timeout

Launch a delegate that will timeout, and check whether the parent turn receives bounded error results and whether the child execution is cleaned up.

### Experiment Reference Answers

1. **Experiment A**: The tool should be visible within the allowed toolset, the parameter schema should reject unknown inputs, results should have an output budget, failures should return explainable errors, and the host path should not be directly exposed.
2. **Experiment B**: Both should be serialized in admission order; the same session cannot write twice; the source of cron can be distinguished, but it cannot bypass the lease.
3. **Experiment C**: The parent should receive a timeout/failure tool result, not hang; the child execution should stop or be marked recyclable, and the parent transcript should still maintain call/result pairing.

## 7. Failure and Recovery

| Failure | Risk | Correct Recovery |
| --- | --- | --- |
| Plugin import deadlock | Startup gets stuck | Bounded load wait, record, and degrade |
| Plugin registration duplicate | Tool/channel conflict | Clear namespace and override rules |
| Toolset include cycle | Recursive expansion out of control | Detect and reject at build time |
| Channel retry | Duplicate turn | Request ID/platform message ID idempotency |
| Cron and user submitted simultaneously | Double write | SessionAuthority FIFO + lease |
| Cron worker crash | Task partially executed | Inflight/owner/lease recovery and idempotency |
| Subagent timeout | Parent turn hangs | Timeout result + lifecycle cleanup |
| RPC old generation | Control wrong turn | Generation fencing |

## 8. Self-Check

1. Why can't new tools just write a handler?
2. Why is a plugin not equivalent to a safe sandbox?
3. Why can't a message channel directly call the model and write the transcript?
4. Which layers are shared between cron tasks and normal user input, and which are different?
5. How do sub-agents and parent agents exchange results?
6. Why prioritize user plugins over directly changing the core when adding a provider?
7. When adding an RPC method, where should execution rights reside?

### Reference Answers

1. Because model visibility, toolset selection, authorization, approval, parameter validation, output budget, error projection, and persistence all determine whether it can execute safely; writing only a handler bypasses these boundaries.
2. Plugins execute arbitrary Python in the host process; registration may alter tools, providers, or channels. Load isolation can only reduce fault impact; it cannot replace source review and permission design.
3. Direct calls bypass unified admission, FIFO, lease, idempotency, approval, and recovery, causing multi-entry state divergence. Adapters should only convert platform semantics to the unified protocol.
4. Shared: Agent core, admission/lease, transcript, and delivery semantics; different: source, triggering method, scheduling, retry policies, and whether delivery to a specific channel is required.
5. The parent agent issues a delegate tool call; the child execution produces results; the results are persisted as tool results and then returned to the parent model; they do not share the same transcript that can be freely written.
6. User plugins reduce core coupling and upgrade costs, facilitating isolation experiments and third-party maintenance; core integration only occurs when built-in discovery, stable contracts, or performance paths are truly needed.
7. Execution rights belong to the host/Agent runtime. RPC methods are only responsible for validation, authentication, and scheduling; they should not run a separate turn in the UI process just because they come from TUI.

## 9. Source Code Coordinates

- `plugins/plugin_loader.py`
- `toolsets.py`
- `model_tools.py::get_tool_definitions`
- `providers/base.py::ProviderProfile`
- `gateway/run.py::GatewayRunner`
- `gateway/run_turn_runner.py::TurnRunner`
- `tui_gateway/session_registry.py`
- `tui_gateway/prompt_turn.py`
- `cron/scheduler.py::_run_one_job_body`
- `tools/delegate_tool.py`
- `acp_adapter/`

## 10. Next Steps

Enter Stage 8: The more extensions, the more testing, logging, failure matrices, and minimal reproduction are needed to secure the previous seven layers, rather than relying on 'it ran locally'.
