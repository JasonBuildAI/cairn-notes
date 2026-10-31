---
title: "Stage 5: Model Integration and Provider Adaptation"
description: "Stage 5: Model integration and Provider adaptation. Understand facts, contracts, observable evidence, and failure recovery along the main line of the source code."
---

> Course: DeerFlow Source Code Class · Stage Exam
> Prerequisite: Stage 2, 3
> Corresponding Overview: Model section of `core-mechanisms.md`
> Goal of this phase: Explain why "which model is allowed to be used" and "how to construct this model" are two layers of responsibility.

## 1. What this phase addresses

Model integration is not simply hardcoding an API key:

~~~text
Configure whitelist
  → Request/Agent/Global Default Model Name Resolution
  → model:use authorization
  Provider and credential selection
  → thinking / reasoning / settings merge
  → provider adapter
  → BaseChatModel
~~~

DeerFlow places authorization at the order/assembly stage and handles specific protocol differences at the provider layer to avoid each route individually judging model security. 

## 2. Remember One Judgment First

**The model name is both a configuration key and a permission boundary; it is not an arbitrary string from the client.**

`start_run()` First check the whitelist, `assemble_lead_agent()` then parse the final model and authorization, `create_chat_model()` then construct the instance. The order of these three steps cannot be reversed.

## 3. Main Source Code Flow

1. `config/model_config.py` Define model configuration, provider, capabilities, and default values.  
2. `services.start_run` Perform whitelist checks on `context.model_name` in the request.  
3. `lead_agent/agent.py::_resolve_model_name` Parse according to request → Agent configuration → global default.  
4. `_authorize_model_name` Execute model usage authorization; if denied, may downgrade to an allowed model.  
5. `models/factory.py::create_chat_model` Read provider class, credentials, base URL, model settings, and tracing.  
6. Adapters are located at `claude_provider.py`, `openai_codex_provider.py`, `vllm_provider.py`, `mindie_provider.py`, and `patched_*`.  
7. `credential_loader.py` and `request_admission.py` handle credentials and request admission.  
8. When thinking is not supported, it will downgrade to non-thinking instead of sending invalid parameters to the provider.

## 4. Key Objects and Contracts

| Layer | Decides What | Failure Mode |
| --- | --- | --- |
| start_run whitelist | Whether this model name exists in the configuration | 400, Run not created |
| model:use authorization | Whether the current caller can use it | Denied or downgraded |
| `_resolve_model_name` | Request/Agent/global priority | Fallback on unknown name or error |
| `create_chat_model` | Provider class and parameter shape | Construction failure, Run fails |
| provider adapter | Protocol, stream, tool calling, reasoning | Logged and retried/classified by the runtime layer |
| credential loader | Source and isolation of keys | Keys are not written into checkpoint |

## 5. An Observable Chain

~~~text
request.model_name
  → app_config.get_model_config
  → resolve(request > agent > default)
  → authorize model:use
  → create_chat_model
  → provider class
  → request / stream
  → usage + tracing
~~~

Observation Points: The client can only express "preferences" and cannot pass in the provider's private key, arbitrary base URL, or unconfigured models. Runtime configurations must also have internal keys sanitized when written to a checkpoint.

## 6. Experiments

### Experiment A: Invalid Model Name

Request a model that does not exist in the configuration. Acceptance reference: Rejected at `start_run` stage, does not generate a pending Run, and does not call the provider.

### Experiment B: Thinking Downgrade

Select a model at `supports_thinking=false` and enable thinking. Observation reference: Assembly logs show downgrade, the request does not carry invalid thinking parameters, and the Run continues execution.

### Experiment C: Comparing Two Providers

Use the same tool to call tasks separately running OpenAI-compatible adapter and Claude adapter. Observation reference: The tool rounds on the graph are the same; differences are concentrated in message conversion, stream events, usage, and error shapes.

### Experiment Reference Answers

1. Invalid models should be rejected at the `start_run` configuration/whitelist verification stage, should not generate a pending Run, and should not call the provider.
2. Models that do not support thinking should be downgraded at the assembly layer; requests should not carry invalid parameters. This is capability adaptation, not leaving the provider to ignore it by itself.
3. Both adapters should share the same tool round semantics; differences are concentrated in message conversion, stream events, usage, and error shapes. If the loop itself branches, it indicates the adapter layer intrudes too deeply.

## 7. Failures and Recovery

| Failure | Responsibility Layer | Recovery |
| --- | --- | --- |
| 401/403 | credential/provider | Rotate or terminate, do not fake success |
| 429 | runtime layer | Bounded backoff/retry |
| Unsupported parameters | adapter | Normalize or downgrade |
| Context window exceeded | context/preflight | Re-measure and compress |
| Stream interruption | worker/provider | Recover based on received content and idempotency boundary |

## 8. Self-Test for Mastery

1. What do the model whitelist and `create_chat_model` prevent respectively?
2. Why can't the configuration be written to the checkpoint as-is?
3. Why should thinking and reasoning effort be normalized at the assembly stage?
4. Should the provider adapter decide the final state of a Run?

### Reference Answers

1. The whitelist prevents the client from turning any model name into permissions for network access, billing, and credential selection; `create_chat_model` is responsible for constructing the correct protocol instance according to authorized configurations, not for taking orders.
2. The configuration may contain API keys, base URLs, internal tokens, and host policies. Checkpoints can be restored/read/copied; writing secrets to them enlarges the exposure surface. Internal keys must be sanitized and secure references used.
3. Different providers support thinking and reasoning fields differently. Parsing and verifying capabilities first before constructing requests avoids invalid parameters, implicit billing, and inconsistent context behavior.
4. No. The adapter is responsible for protocol conversion and error exposure; Run state, retry boundaries, delivery, and final state are determined by the worker/manager.

## 9. Source Code Locations

- `backend/packages/harness/deerflow/models/factory.py`
- `backend/packages/harness/deerflow/models/credential_loader.py`
- `backend/packages/harness/deerflow/models/request_admission.py`
- `backend/packages/harness/deerflow/config/model_config.py`
- `backend/app/gateway/services.py::start_run`
- `backend/packages/harness/deerflow/agents/lead_agent/agent.py`

## 10. Next Steps

Move to Stage 6: Once the model has been called and the tools executed, how can the process be recorded as recoverable and auditable facts?
