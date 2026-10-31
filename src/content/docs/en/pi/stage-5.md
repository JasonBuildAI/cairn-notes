---
title: "Stage 5: Model Integration"
description: "Use model adaptation layers to isolate vendor differences and understand streaming output and routing."
---

> **Position in this stage**: In stage 2, the loop can already "request a model, receive a response, and execute tools." Stage 3 has already explained what context should be included in the request. Now to answer: who exactly does the model request go to, and why changing to a different vendor doesn't require rewriting the loop?
> **Source code directory**: `$PI_SRC`. Core materials: `packages/ai/`, `packages/coding-agent/docs/providers.md`, `models.md`, `custom-provider.md`, `virtual-models.md`, `packages/coding-agent/src/core/model-runtime.ts`.
> **One-sentence main line**: The loop only recognizes a single unified interface; `packages/ai` translates authentication, protocols, model information, and streaming events from different vendors into the same internal language.

## 1. What is being solved in this stage

If we think of an Agent as a car, then:

- The loop is the engine's control logic;
- Tools are the wheels and robotic arms;
- Context is the fuel and driving records;
- **The model is the engine itself**.

The problem is that in reality, there are dozens of different "engines," and each vendor has a different interface:

- Some use API keys, some use OAuth, some use temporary cloud credentials;
- Some return `choices[].delta.content`, some `content_block_delta`, some `candidates[].content.parts`;
- Some return tool call parameters in JSON strings in fragments, others return them as separate events;
- Each vendor has different context windows, maximum output, support for images, pricing, and reasoning levels.

If the loop itself parses these differences, then every time a new vendor is integrated, you would need to change the loop, change the interface, change compression logic, and change error handling. The code would quickly become a pile of `if provider === ...`.

Therefore, what the model integration layer needs to solve is:

> **Block the differences of "how different vendors speak" outside the engine, so the loop only sees a unified model, a unified request, and unified events.**

After studying this chapter, you should be able to distinguish between vendor, protocol, model, credentials, and adapter, and know whether adding a new model requires changing the configuration, changing the directory, or writing a new adapter.

---

## 2. Five terms that must be separated

### 2.1 Provider, API, Model, Credential, Adapter

First, look at the table:

| Term | Explanation in simple language | Example |
| --- | --- | --- |
| Provider | The company or service from which you get the model | OpenAI, Anthropic, Google, DeepSeek, OpenRouter, local llama.cpp |
| API | The agreed "speaking format" between both parties | OpenAI Completions, OpenAI Responses, Anthropic Messages, Google Generative AI |
| Model | The actual model responsible for generating content | `gpt-...`, `claude-...`, `gemini-...`, some local model |
| Credential | Proof that you have the right to use the service | API Key, OAuth token, cloud platform credentials |
| Adapter | Code that translates a protocol into Pi's internal events | `openai-completions.ts`, `anthropic-messages.ts` |

The easiest confusion is between the first two.

### 2.2 Provider is not equal to API

The same vendor can use different protocols, and different vendors can also use the same protocol.

```text
Provider:DeepSeek
API:openai-completions
             ▲
             It is talking about that set of 'dialects'

Provider:OpenAI
API:openai-responses
             ▲
             The same company can also have another agreement.
```

So "integrating DeepSeek" does not necessarily mean "writing a DeepSeek protocol from scratch." If it supports an OpenAI-compatible interface, Pi can reuse existing `openai-completions` adapters.

This is why the model integration layer can converge: **what really needs adapting are protocol differences, not company names.**

### 2.3 What a model entry includes

The internal `Model` in Pi is not just a string. A complete model at least needs:

| Field | Why it is needed |
| --- | --- |
| `provider` | Who provides this model |
| `id` / `name` | Model identifier and display name |
| `api` | Which protocol adapter should be used |
| `baseUrl` | Which address to send requests to |
| `input` | Supports text, images, or both |
| `contextWindow` | Maximum number of tokens in context, affects compression |
| `maxTokens` | Maximum tokens generated at one time |
| `reasoning` | Whether thinking mode is supported |
| `thinkingLevelMap` | How Pi's thinking level maps to this model |
| `cost` | Cost for input, output, and cache read/write |
| `headers` / `compat` | Special request headers or compatibility options required by the endpoint |

This information is not "metadata for display." It directly participates in:

- Compression threshold;
- Whether images can be sent;
- Thinking level selection;
- Cost statistics;
- Model filtering;
- Construction of request parameters.

So whether a "model can be used" depends not just on whether it can return text, but also on whether these capability descriptions are reliable.

---

## 3. How a model request proceeds in code

Magnifying the loop from stage 2 reveals a chain like this:

```text
Loop
  │  Unified context: messages +  tools +  options
  ▼
StreamFn / Models.streamSimple()
  │ Select provider, parse credentials, find API implementation
  ▼
Adapter
  │ Convert internal messages into vendor requests
  ▼
HTTP / SSE / WebSocket
  │ The manufacturer returns its own streaming data
  ▼
Adapter Parsing
  │ translate into unified AssistantMessageEvent
  ▼
Loop continues to check:
  Plain text? Tool call? Error? Truncated?
```

There are three layers of 'events' here, don't confuse them:

| Layer | Example | Who generates |
| --- | --- | --- |
| Vendor raw stream | SSE data blocks, JSON increments, WebSocket messages | Model service |
| Unified model layer events | `text_delta`, `toolcall_delta`, `done`, `error` | Adapter of `packages/ai` |
| Agent session events | `message_update`, `tool_execution_start`, `agent_settled` | Loop and session layer |

The JSON events seen in Stage 1 belong to the third layer. Their underlying sources may come from completely different vendor protocols, but by the time they reach the interface and the program, their format has already been unified.

---

## Four, the five drawers of `packages/ai`

You don't need to memorize every file; first, know the five types of responsibilities:

### 4.1 Contract: Unified data shapes

`src/types.ts` defines:

- Which API types exist;
- What `Model` looks like;
- Unified message format;
- What events `AssistantMessageEvent` include;
- How errors and stop reasons are represented.

This is the 'contract' for the entire access layer. Loops depend on the contract, not on any particular vendor implementation.

### 4.2 Model collection: registration, lookup, and dispatch

`src/models.ts` is responsible for:

- Creating a model collection;
- Registering providers;
- Finding models according to `provider + id`;
- Parsing credentials;
- Dispatching streaming requests to the corresponding API implementations;
- Calculating cost and reasoning levels.

It can be understood as a 'telephone switchboard': the loop only says 'I want to find this model,' and the switchboard finds the correct line.

### 4.3 Authentication: Where the keys come from

`src/auth/` handles API Keys, OAuth, credential storage, and refresh. It doesn't care what the model output looks like; it only ensures the request carries the correct identification.

### 4.4 API implementation: translator for each protocol

Each file under `src/api/` usually corresponds to a protocol, such as:

- `openai-completions.ts`
- `openai-responses.ts`
- `anthropic-messages.ts`
- `google-generative-ai.ts`
- `bedrock-converse-stream.ts`

These files are responsible for converting 'internal message → vendor request → vendor stream → internal event.'

### 4.5 Provider factory and model catalog: combining identity, credentials, protocol, and model

A vendor under `src/providers/` usually does four things:

```ts
createProvider({
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
  models: Object.values(DEEPSEEK_MODELS),
  api: openAICompletionsApi(),
})
```

Translate into plain language:

> This is DeepSeek; the address is here; the key comes from the environment variable; the list of models is these; requests are sent according to the OpenAI Completions protocol.

Note the last sentence: **When integrating a new vendor, what you often truly need to write is just this "assembly list," rather than re-implementing the protocol.**

---

## 5. Authentication: Get the key first, then send requests

### 5.1 Priority order of credential sources

Pi's typical resolution order is:

```text
--api-key for this run overrides
        ↓
Stored auth.json credentials (API Key or OAuth)
        ↓
apiKey configured in models.json
        ↓
Environment variables or cloud platform environment credentials
```

But there is a key detail here:

> **As long as a provider already has "stored credentials," the stored credentials belong to that provider.** If the refresh fails, it will not silently fall back to environment variables.

This is to avoid the confusion of "logged into account A, but quietly using account B because the B Key is still in the environment."

### 5.2 Credentials Are More Than Just Keys

Common authentication methods include:

- API Keys in environment variables;
- API Keys saved to `auth.json` from `/login`;
- OAuth login and automatic refresh;
- Command-line retrieval written in `models.json`;
- Cloud platform profiles, roles, or temporary credentials.

Credentials are not part of the model directory. The directory can be public, but credentials cannot.

### 5.3 Security Rules

In practical development, three rules must be followed:

1. Do not write tokens, full request headers, or full vendor responses into ordinary logs;
2. Do not submit `auth.json` into the repository;
3. Custom provider code and extensions run with the same permissions and must only load trusted code.

"Works locally" does not equal "safe to share." Model adaptation layers often have access to credentials, so they naturally lie on the trust boundary.

---

## 6. Model Directory: Why It Is "Generated at Build Time"

### 6.1 Model Metadata Cannot Be Guessed Temporarily

Before sending a request, Pi needs to know:

- How large the context window of this model is;
- Whether it supports images;
- The maximum output at one time;
- Whether it supports reasoning;
- The cost per million tokens.

If it fetches this online at every startup, three problems arise:

1. Cannot use it without internet;
2. Slow startup and vulnerability to network failures;
3. Types and fields are unstable, making code difficult to check.

Therefore, Pi uses the method of "generating the directory at build time:

```text
Upstream model data
   → Generate Script
   → packages/ai/src/models.generated.ts
   Released with the package, readable offline
```

At runtime, you can also override the updated directory from pi.dev and keep the cache. This way, you have offline fallback while still updating new model information.

### 6.2 Why not directly edit generated files

`models.generated.ts` is a generated product. Direct manual edits will be overwritten the next time it is generated and will also break the 'single source of truth.'

The correct sequence is:

```text
Change generation logic or upstream data
  → Run model data update/generation command
  Check generated differences
  Run tests and checks
```

During the learning phase, you only need to know this boundary; you don't need to memorize every field in the script.

### 6.3 Why disambiguation is needed when selecting a model

Different providers may offer models with the same name. For example, the same `sonnet` name may come from different cloud platforms or proxies.

Therefore, Pi supports:

```powershell
pi --model anthropic/claude-...
pi --model claude-... --provider anthropic
```

The selection rules are roughly as follows:

1. When `provider/model` is explicitly specified, prioritize using this provider;
2. When there is no prefix, prioritize selecting a match with available credentials;
3. If there are still multiple candidates, use `--provider` for disambiguation.

This is not a small issue of "name matching." Choosing the wrong provider could mean incorrect pricing, endpoints, capabilities, or credentials.

---

## 7. How streaming events are normalized

### 7.1 Different vendors, the same set of actions

Each vendor's streaming protocol looks different, but after abstraction, there are actually only a few types of actions:

```text
Start responding
Output a piece of text
Output a piece of thinking
Start a tool call
Add a set of tool parameters JSON
End a content block
Successfully Completed / Error / Aborted
```

Pi uses `AssistantMessageEvent` to uniformly represent these actions:

| Unified Event | Meaning |
| --- | --- |
| `start` | Stream start |
| `text_start` / `text_delta` / `text_end` | Text block start, increment, end |
| `thinking_start` / `thinking_delta` / `thinking_end` | Thought block start, increment, end |
| `toolcall_start` / `toolcall_delta` / `toolcall_end` | Tool call start, parameter increment, complete call |
| `done` | Normal end, with stop reason and complete message |
| `error` | Error or aborted, with error message |

The adapter's job is to translate the vendor's "dialect" into the actions in this table.

### 7.2 Why tool parameters need to be chunked

When the model generates a tool call, the parameters are often a piece of JSON, and they appear bit by bit during streaming output:

```text
toolcall_start
toolcall_delta  {"path": "src/
toolcall_delta  main.ts", "limit":
toolcall_delta   50}
toolcall_end    { path: "src/main.ts", limit: 50 }
```

The loop will not execute the tool on the first `delta`. It must wait until `toolcall_end`, obtain the complete parameters, and only then proceed to validation and execution.

### 7.3 Why Errors Are Encoded into the Stream

Model requests may encounter:

- Network disconnection;
- Authentication failure;
- Rate limiting;
- Context overflow;
- User interruption;
- Irrecoverable errors returned by the vendor.

According to Pi's streaming interface convention, failures at the model request layer are generally expressed through the final error message or error events, rather than letting the stream consumer receive only an unhandled rejection. This way, the upper-level loop can uniformly decide:

- Whether to automatically retry;
- Whether to retry after compression;
- Whether to inform the user of the error;
- Whether to restore queued messages.

This is also why you will see events like `error`, `auto_retry_start`, `auto_retry_end` in JSON events.

---

## 8. Connecting a New Model: Start with the Minimal Solution

Many people's first reaction is "I want to write a provider." In fact, you should first assess the need:

| Requirement | Minimal Solution |
| --- | --- |
| The service already has OpenAI / Anthropic / Google compatible interfaces | Configure the endpoint in `models.json` |
| Only change the address or request header of a built-in provider | `models.json` override or a very minimal provider configuration |
| Need dynamic model discovery | Provider extension `refreshModels` |
| Need a custom login process | Provider extension authentication implementation |
| Need a completely different online protocol | Implement a new `stream` / `streamSimple` |
| Want to route models to different backends per request | Virtual model |

Principle: **If it can be configured, don't write code. If an existing protocol can be reused, don't create a new protocol.**

### 8.1 Zero-Code Integration of an OpenAI-Compatible Endpoint

Configure in the user directory `models.json`:

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "my-local": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "local-dummy-key",
      "models": [
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

Every field here is important:

- `my-local`: The name you give to this provider;
- `baseUrl`: The service address;
- `api`: Which protocol adapter to use;
- `apiKey`: Some local services do not validate, but the client still requires a placeholder value;
- `models`: The model ID exposed by this endpoint.

Then select a model in Pi, or specify it directly:

```powershell
cd $PI_SRC
.\pi-test.ps1 --provider my-local --model qwen2.5-coder:7b --print "Introduce yourself in one sentence"
```

If the service is actually not compatible with the OpenAI protocol, do not forcibly apply this configuration; otherwise, the request format, streaming events, and tool calls will all be mismatched.

### 8.2 When you must write a provider extension

Only in these situations is it worth writing:

- The authentication method cannot be expressed using an API Key/existing OAuth;
- The model list needs to be queried dynamically;
- The request body and response stream follow another protocol;
- Vendor-specific processing is required before or after the request.

A provider extension is essentially still an extension: it runs within the Pi process, registering its own provider, authentication, models, and streaming implementation. It can access credentials, requests, and responses, so it must be treated as "trusted code." 

### 8.3 What virtual models are

Virtual models solve a different type of problem:

> Users want to choose a name, but the actual request should be routed to different backends according to rules.

For example:

```text
User selection: company/fast
Actual request: Switch to the A model or B model based on task, cost, or availability
```

It separates 'which model to choose' and 'which model to ultimately dispatch to.' At the beginner stage, it is enough to know that this capability exists; there is no need to write the router first.

---

## 9. Observations You Can Make Immediately

### Experiment 1: Look at the model directory and availability

```powershell
cd $PI_SRC
.\pi-test.ps1 --list-models
```

Ask yourself:

- Which providers have credentials, and which do not?
- Does the same model name appear under multiple providers?
- If a model does not appear, is it because the catalog does not have it, or because the credentials are unavailable?

### Experiment 2: Observe a streaming event

```powershell
.\pi-test.ps1 --mode json "Explain what streaming response is in three sentences" > model-events.jsonl
```

Find in the file: 

1. `message_start`; 
2. Multiple `text_delta`; 
3. `text_end`; 
4. `message_end`; 
5. `turn_end`.  

Then explain: **Why is `message_update` the increment in `message_update` and the final reference `message_end`?** 

### Experiment 3: Find a parameter called by a tool and split it into shards

Have the model read a file and search for `toolcall_start`, `toolcall_delta`, `toolcall_end` in the JSON stream. Confirm: 

- Parameters do not appear all at once; 
- Only complete parameters enter execution; 
- The tool execution event occurs after `toolcall_end`. 

--- 

## 10. Common Misconceptions

| Misconceptions | Correct understanding |
| --- | --- |
| Provider is the API protocol | Provider is the source of services; API is the protocol for request/response |
| After taking over a new company, you must write a new protocol | If it is compatible with existing protocols, you only need to configure the provider and model |
| The model ID is the same, but it's the same model | Different providers, endpoints, capabilities, and prices may differ |
| If you have a model directory, you can use | You also need to have valid credentials and endpoints compatible |
| The model directory is easily captured at runtime | Built-in directories are generated during construction, can be used offline, and supports overwrite and update |
| Seeing `text_delta` can spell out the final message | The final content is based on the authoritative message from `message_end` |
| Tool parameters can be executed in one shard | Must wait for full tool calls and parameter validation |
| If the vendor reports an error, the entire process should crash | Request errors are usually encoded into the stream, and the upper layer decides whether to retry or restore |
| Custom provider is just a configuration | It is code running within the Pi process and has the same permissions |

--- 

## 11. Customs Self-Inspection

Please answer without looking at the document for now: 

1. What are Provider, API, Model, and Credential? Here's an example of "the same protocol being used by multiple providers." 
2. Without a model access layer, what differences will loops be forced to handle? 
3. What are the common sources of credentials? Why can't stored credentials quietly revert to environment variables when they exist? 
4. What do `contextWindow`, `input`, and `cost` in the model metadata respectively affect? 
5. What is the relationship among vendor flow, `AssistantMessageEvent`, and agent events? 
6. In what situations do you only need to change `models.json`, and when must you write a provider extension? 
7. Why does the same model name require `provider/model` or `--provider` disambiguation? 

Recommended outputs: 

- [ ] A link diagram of "Loop → Models → Provider → API → HTTP"; 
- [ ] A `models.json` configuration that can explain each field; 
- [ ] A comparison table for "Vendor Fields → Unified Events"; 
- [ ] A 3-minute explanation explaining why you shouldn't change the loop when changing models. 

The next stop is Stage 6: Scaling. Models and tools can already be replaced; next, let's see how to integrate new capabilities into the same runtime without changing the core. 

--- 

*Supporting [Learning Route](../learning-path/) Stage 5 · Based on v1.3.0 (`71023aec`)*
