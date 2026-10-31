---
title: "OpenClaw 2026.10.9 Source Code Class · Introduction"
description: "OpenClaw 2026.10.9 Source Code Course Guide: Gateway, Session/Run, Seven Responsibility Blocks, and Learning Completion Standards."
---

:::note[Independent Study Notes]
These are independent study notes based on the 2026.10.9 release archive source code and public documentation of [OpenClaw](https://github.com/openclaw/openclaw), not official documentation. This site does not include upstream source code or archives; below, $OPENCLAW_SRC represents your own local source code directory.
:::

> Baseline: release archive `openclaw-2026.10.9`, `package.json` version is `2026.10.9`.
> The archive does not include `.git`, so this article uses the release package version, source code symbols, and directories as the baseline, without fabricating commits/tags.
> Runtime environment: Node `>=24.22.1 <25 || >=26.12.1`, package manager `pnpm@12.15.0`.
> All paths in this article are relative to `$OPENCLAW_SRC`.

## Understanding OpenClaw in One Sentence

**OpenClaw is a personal agent runtime centered around a long-running Gateway: it consolidates entry points such as WhatsApp, Telegram, Slack, Discord, Signal, iMessage, WebChat, TUI, Node devices into the same Session/Run system, then uses a replaceable Agent Harness to call models, execute tools, perform approvals, write back transcripts, and send the results back to the original channel.**

You can think of it as a "resident dispatch center" rather than a chat window:

```text
Channel news / WebChat / TUI / Mobile / Node
                 │
                 ▼
        Gateway (Authentication, session routing, idempotence, events)
                 │
                 ▼
     Session / Run admission (serial, queueing, takeover)
                 │
                 ▼
       Agent Harness (Built-in / Plugin / CLI)
                 │
       ┌─────────┼──────────┐
       ▼         ▼          ▼
     Model     Tools     Context
       │         │          │
       └──── transcript / events / approvals
                 │
                 ▼
          Reply Dispatcher
                 │
                 ▼
        Original Channel / UI / Caller
```

## Seven Main Tables

| Component | Question to Answer | OpenClaw's Answer | Main Source Code |
| --- | --- | --- | --- |
| Loop | How does a single Agent Turn advance, when does it continue or stop? | Model flow, tool batches, steering checkpoint within `runAgentLoop()` and `prepareNextTurn()` | `packages/agent-core/src/agent-loop.ts` |
| Context | What does the model see each time, how is it compressed/cleaned? | system prompt, workspace bootstrap, transcript; compaction rewrites history, cache-TTL pruning only changes prompt projection | `src/agents/system-prompt.ts`, `src/agents/bootstrap-files.ts`, `.../compaction/compaction.ts` |
| Tools | What can the model do, who approves, where is it executed? | Assemble tools according to capability/policy; `before_tool_call` executes loop admission, trusted policy, approval, hook sequentially; sandbox backend handles isolated execution | `src/agents/agent-tools.ts`, `src/agents/agent-tools.before-tool-call.policy.ts`, `src/agents/sandbox/` |
| Model Integration | How are multiple providers, auth, fallback, harness unified? | Logical model ref → static/dynamic model resolution → auth profile → harness selection → failure handled by rotate/fallback/surface decision | `src/agents/embedded-agent-runner/model.ts`, `src/agents/harness/selection.ts` |
| Extensions | How to integrate new channels, providers, tools, skills? | Native Plugin capability, hook, MCP, Skills, subagent; plugins only use `openclaw/plugin-sdk/*` | `src/plugins/`, `src/mcp/`, `src/skills/`, `src/agents/subagents/` |
| Interface | How do humans, scripts, channels, devices share the same engine? | Gateway HTTP/WS, Control UI/WebChat, TUI, CLI, mobile, Node all go through the same Session/Run contract | `src/gateway/`, `ui/src/`, `src/tui/`, `src/cli/` |
| Engineering | Why don't changes break the system? | schema/contract, device pairing, writer fence, idempotency, architecture checks, type checks, cross-platform testing | `scripts/check.mts`, `src/state/`, `src/gateway/`, `package.json` |

Three vertical lines run through each block:

1. **Unified Entry**: Different channels, but all ultimately enter the same `SessionKey / Agent / Run / ReplyDispatcher` semantics.
2. **Single Ownership**: Gateway owns sessions and routing; session writer owns transcript; plugin capability owner owns vendor adaptation; Approval owner controls release.
3. **Recoverable Execution**: runId, idempotency keys, writer fence, terminal outcome, and transcript provide clear boundaries for "repeated requests, concurrent takeover, restart recovery."

## Reading Order

| Order | Document | What You Will Get |
| --- | --- | --- |
| 0 | [Global Map](overview/) | Product positioning, process topology, core objects, directory responsibilities, trust boundaries |
| 1 | [Life of a Message](message-lifecycle/) | Complete main line from channels/`chat.send` to Agent Loop, tools, transcript, and reply |
| 2 | [Core Mechanisms](core-mechanisms/) | Loop, context, tool approval, model/harness, plugin/MCP/Skills, Gateway protocol |
| 3 | [Engineering Practice](engineering/) | Debug path, source code experiments, failure matrix, extension exercises, and engineering levels |

## Stage Lessons (Deep Dive into Source Code)

After the overview, follow the [Stage Guide](learning-path/) from stage 0 to stage 9. `00`–`03` establish global and mechanism intuition; stage volumes dissect ownership, state transitions, failure recovery, and observable experiments from real source code, with each self-test and exercise including reference answers.

## Recommended Reading

- **First pass, only track one thread**: `dispatchInboundMessage` or `chat.send` → `agentCommandFromIngress` → `runEmbeddedAgent` → `runAgentLoop` → reply.  
- **Second pass, follow up on ownership**: Which session does this message belong to? Who has the authority to write the transcript? Who approves the tool? After failure, which receipt can prove which step was completed?  
- **Third pass, conduct experiments**: Let the same session run concurrently twice and observe the queue; let the provider fail first and then fallback; let a tool wait for approval; compare differences in transcripts between compaction and pruning.  

## Five Most Easily Confused Things

1. **Gateway is not an Agent**: Gateway handles authentication, sessions, routing, RPC, events, and lifecycle; the actual model and tool invocation is done by the Agent Harness.  
2. **Channel is not a Session**: Channel is the message source/reply outlet; Session is the long-term contextual identity owned by the Gateway. A session can span channels, while group chats are isolated by default.  
3. **Compaction is not Pruning**: Compaction generates summaries and rewrites the transcript view; cache-TTL pruning only clears old `toolResult` prompt projections, without rewriting the original history.  
4. **Plugin is not an MCP Server**: Plugin is a native in-process extension that can register providers/channels/tools/hooks; MCP is an external tool protocol, and MCP tools still go through the same tool policy and approval.  
5. **Successful sending does not equal Turn completion**: `chat.send` returning `in_flight` only indicates acceptance; termination state, transcript commit, reply delivery, and writer handoff are separate subsequent events.  

## Learning Completion Criteria

After reading, you should be able to answer without looking at the documentation:  

- Where do a Telegram message and a Control UI `chat.send` converge? Why do they share the same Agent executor?  
- How are two concurrent requests in the same session serialized? Why can't the first writer continue when the second takes over?  
- What do `steer`, `followup`, `collect`, `interrupt` respectively change and not change?  
- Why is model fallback not the same as harness fallback? How does `auto` choose between built-in and plugin harness?  
- Why can't tool approval sequences be arbitrarily changed? What are the differences between `deny`, `defer`, `report`, `request`?  
- In one automatic compaction and one cache-TTL pruning, what is modified and what is retained respectively?  

### Reference Answers for Learning Completion Criteria

1. **Two entry points converge at the unified agent command / embedded runner, then proceed into the same `runAgentLoop()`.** Telegram uses `dispatchInboundMessage → finalizeInboundContext → dispatchReplyFromConfig`; Control UI uses `chat.send → admission/ACK → detached dispatch`. They share Session/Run, model and tool policies, approvals, writer fence, transcript, and response delivery, so they must share the executor; the channel layer is only responsible for inbound normalization and `ReplyDispatcher` outbound.
2. **The same session is first executed serially by the session lane, then the writer fence determines the transcript write rights.** A new run uses CAS to compare `sessionId` before writing to `activeWriterRunId`; if an old writer is found, it is explicitly marked as `superseded`. The old run cannot continue writing because its write rights have been revoked; if silently ignored, the old process may still append interleaved history or duplicate side effects, and it cannot audit who owns the final state.
3. **`steer`** injects messages within a security boundary into the current run, and running tools will complete them; calls at the end of the serial lane that have not started may generate paired skipped/error results, and parallel batches that have entered the execution boundary will not be skipped due to steering, nor will a second run be created; **`followup`** does not interrupt the current run, queuing the message to the next turn after its completion; **`collect`** after the quiet window merges multiple messages with compatible routing, authorization, and execution into one follow-up turn without changing the current run, while durable ingress channels may still maintain independent turns; **`interrupt`** cancels the active run of that session, then executes the latest message, without restarting the old turn via the Gateway. All four change the timing of queuing/injection without changing Session ownership or committed history facts.
4. **Model fallback still switches models/credentials/routing within the same harness; harness fallback switches the execution runtime.** The former retains the tool loop and session protocol, while the latter may change steering, session mapping, tool policies, and runtime capabilities. `auto` enumerates registered plugin harnesses, filters by support conditions such as provider/model and tool policy, then selects the highest priority one (same priority by id); if no plugin harness is available, it falls back to built-in OpenClaw. When explicitly specifying the plugin runtime, the default is fail closed unless the plugin declares OpenClaw as a lossless fallback.
5. **The order is loop admission → owner probes → voice confirmation → trusted policies → approvals → normal hooks → final owner approval.** Approvals must occur before normal hooks, otherwise hooks can first modify tool parameters or fabricate evidence before the approval sees the "washed" call; the final owner approval must also independently release after hooks. **`deny`** directly denies; **`defer`** defers decision to the execution boundary; **`report`** only reports without blocking; **`request`** immediately requests manual approval; non-interactive surfaces can directly deny.
6. **Compaction rewrites the history/transcript view**: summarizing earlier content while keeping the recent tail, belongs to harness/`packages/agent-core`; failures must not lose recent originals. **Cache-TTL pruning only changes this prompt projection**: replacing expired tool results with placeholders, leaving disk transcript unchanged, which can be reconstructed from the original after a restart, belonging to the embedded-agent runner's truncation layer. The former changes the "ledger view," the latter only changes "what the model sees this time."

---

*Based on OpenClaw 2026.10.9 source release · 2026-10-31*
