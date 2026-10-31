---
title: "Stage 5: Provider, Credentials, and Fallback"
description: "Stage 5: Provider, Credentials, and Fallback. Understand facts, contracts, observable evidence, and failure recovery along the main source code line."
---

> Course: Hermes Agent Source Code Course · Stage Paper
> Pre-process: Stages 3 and 4
> Corresponding overview: `turn-lifecycle.md` Section 8, `core-mechanisms.md` Section 4
> The goal of this stage: distinguish between request constructors, transfer retrys, credential rotation, and provider fallback, and understand why fallbacks must reconstruct context. 

## 1. This stage addresses what to address

The Provider layer is not "one OpenAI SDK for another base_url." Hermes faces the following challenges simultaneously: 

- Various wire formats such as OpenAI-compatible, Anthropic, Bedrock, Gemini, Codex, etc.; 
- API key, OAuth, environment variables, credential pool, multiple sources of credentials; 
- Various errors such as rate limiting, timeout, overload, context overwindow, expired authentication, and model unavailability; 
- Key rotation, model cooldown, and cross-provider fallback within the same provider; 
- Differences in context windows, tool schemas, reasoning replays, and request fields for each provider. 

The key here isn't whether it will be retaken, but **which layer of fact each recovery action changes**. 

## 2. Remember one judgment first

**Retry: Reuse the current request; Credential Recovery: Replace the invocation credentials; Fallback: Change the provider/model and reconstruct the entire request context.** 

The three cannot be mixed: 

- Retry can continue to use the same `api_messages`, but must be constrained by the number of times and intervals; 
- Changing keys may still preserve the provider, model, and context window, so you can continue from the current request; 
- After switching providers, the context window, adapter, schema, and system prompt compatibility may all change, so you must return to preflight. 

## 3. Source code main storyline

1. `providers/base.py::ProviderProfile` Describes the provider's `auth_type`, environment variables, base URL, API mode, model directory, and capabilities. 
2. `providers/__init__.py` Responsible for built-in provider registration/discovery; User plugins can also provide providers. 
3. `agent/credential_pool.py` Manage pooled credentials, source tags, priority, cooldowns, failure counts, and refreshes. 
4. `agent/conversation_loop.py` Refreshes environment credentials at the start of turn so that the `.env` saved by Settings does not necessarily take effect after the process restarts. 
5. `agent/turn_api_request.py::build_api_request()` Assemble messages, system prompt, tools, extra body/headers, request id, and trigger a pre-API hook. 
6. `agent/turn_api_call.py::perform_api_call()` Choose between stream or non-stream calls based on provider and configuration, and convert responses/exceptions into verdicts. 
7. `_run_api_retry_loop()` Execute `request → call → error handling` inside `max_retries`. 
8. `agent/turn_api_error.py::handle_api_error()` First attempt `recover_before_classification()`, then classify errors, recover credentials, handle overflow, and finally settle the unrecovered error. 
9. Once the fallback is activated, `restart_with_rebuilt_messages` must take effect and retry the `break` loop, allowing the next round to re-assemble and preflight. 
10. New providers may change token budgets and message compatibility, so you cannot directly reuse wire copies verified by old providers. 

## 4. Key Objects and Contracts

| Target | Responsibility | Cannot be done |
| --- | --- | --- |
| `ProviderProfile` | Declare provider contract | Pretend all providers are isomorphic |
| adapter | Transform request/response/stream events | Rewrite durable transcript |
| `ApiRequestBuild` | Build result of a wire request | Bypass preflight |
| `ApiCallVerdict` | Call the stage result | Decide the fallback context |
| `ApiErrorVerdict` | Error recovery action | After fallback, retain the old messages |
| `CredentialPool` | Selection and Cooling Credentials | Treat a failure of a key as the permanent death of the entire provider |
| fallback route | New provider/model selection | Skip rebuild/preflight |

At the very least, the classification of errors should be distinguished:

- **Local validation/parameter error**: Retrying the same request is usually useless;
- **Authentication/credential error**: You can refresh OAuth, change the key, or mark the credential as cooling down;
- **Rate limiting/overload/temporary network error**: Retry with limited backoff can be used;
- **Context window exceeded**: Compress or switch to a larger window, cannot retry indefinitely;
- **Provider unavailable/capability mismatch**: Enter fallback;
- **User interruption/process termination**: Stop, do not enter normal retry.

## 5. An observable trace

~~~text
assemble_api_request
  → build_api_request
       messages + system prompt + tools
       provider profile / auth / base_url
       hooks / headers / request id
  → perform_api_call
       success → normalize response
       error   → handle_api_error
                   recover_before_classification
                   classify
                   credential recovery / overflow / retry
                   fallback armed?
                     yes → break retry loop
                         → re-assemble / preflight / build with new provider
                     no  → settle unrecovered
  → next model turn or terminal result
~~~

Observation point: After a fallback log, the old request should not immediately be resent with the old request; The correct approach is to return to the preflight to re-estimate and generate a new provider request. 

## 6. Experiment

### Experiment A: Single Voucher Instantaneous 429

After simulating a 429 and succeeding, observe the number of retries and whether the request is reused. 

### Experiment B: Credential Pool Rotation

Prepare two keys, keep the first 401, and observe whether the cooldown/switch to the second and whether the main request continues. 

### Experiment C: Cross-provider fallback

Have the main provider return a fallback error and record the context window, messages, and preflight counts before and after the fallback. 

### Experimental Reference Answers

1. **Experiment A**: Retry the same request within a limited number of times; Do not switch providers after success. If the error is determined not to retry, proceed directly to subsequent recovery or failure. 
2. **Experiment B**: The first credential should be cooled/downgraded, and the second can serve the same provider request; You cannot permanently lock the provider or refresh the same bad key indefinitely. 
3. **Experiment C**: After fallback activation, you must leave the original retry loop, reassemble, and preflight; The token estimate, adapter field, and message copy for the new request should be regenerated by the new provider. 

## 7. Failure and recovery

| Failure | Correct action | Common mistakes |
| --- | --- | --- |
| 401/OAuth expired | Refresh/replace credential or fallback | Infinite retries as they are |
| 429 / overload | Limited evasion retry | Immediate concurrent bombardment |
| context length | Compress/Enlarge/fail closed | Send secretly after truncation |
| provider 5xx | By policy retry/fallback | Treat the streaming half-packet as a complete response |
| Unsupported tool schema | Adapt or replace provider | Send the old provider field |
| fallback | Rebuild messages, preflight | Directly reuse old requests |
| User interrupt | Stop and close turn | When a normal network error retries |
| Process closure | Abandon turn, return clearly failed | Continue rotating in shutdown |

## 8. Pass through customs and self-test

1. Which layer do you change for retry, credential rotation, or fallback? 
2. Why must tool visibility remain explainable before and after provider adaptation? 
3. Why must fallback return to preflight? 
4. Why is the handling of context hyperwindow different from 429? 
5. What problems does credential pool cooling solve, and what can't be solved? 
6. When a stream call fails, why can't the received half of text be treated as successful? 

### Reference answers

1. Retry: Reuse the current request; Credential rotation: Replace credentials from the same provider; Fallback: Change providers/models, and reconstruct context and requests. 
2. Different providers support different tool schema capabilities; Adaptation must ensure the model sees a legitimate, executable, and authorized set of tools, not residual fields from the old provider. 
3. Because the context window, tokenizer, message format, and system prompts of the new provider may differ in compatibility. Old requests may be over-windowed or contain incompatible fields, requiring re-estimation, compression, and reassembly. 
4. 429 is a transient resource constraint and can be retried backward; Overwindow is a request structure/budget issue; resending the same content will not succeed, so compression, window expansion, or explicit failure is necessary. 
5. It avoids repeatedly using known failed credentials, spreading throttling, and preserving the recovery state; It cannot turn invalid requests, overwindows, or provider capability mismatches into successes. 
6. Half a text is not a complete model message; reasoning, tool calls, finish reasons, and usage may all be missing; If success would pollute the transcript, it must be restored as an error or clearly failed. 

## 9. Source code coordinates

- `providers/base.py::ProviderProfile`
- `providers/__init__.py`
- `agent/credential_pool.py::CredentialPool`
- `agent/turn_api_request.py::build_api_request`
- `agent/turn_api_call.py::perform_api_call`
- `agent/turn_api_error.py::handle_api_error`
- `agent/conversation_loop.py::_run_api_retry_loop`
- `tests/hermes_cli/test_oneshot_fallback.py`
- `tests/gateway/test_custom_provider_request_overrides.py`

## 10. Next

Entering Stage 6: Even after a single turn is completed, SessionDB relies on the SessionDB to create a replayable ledger for messages, admission, lease, compression, and recovery of facts.
