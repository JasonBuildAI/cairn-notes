---
title: "Stage 7: Plugins, Channels, Protocols, and UI"
description: "Stage 7: Plugins, channels, protocols, and UI. Understand facts, contracts, observable evidence, and failure recovery along the main line of the source code."
---

> Course: OpenClaw Source Code Class · Stage Exercises
> Prerequisite: Stages 1–6
> Corresponding Overview: Expansion and UI parts of `core-mechanisms.md`
> Goal of This Stage: Understand what Plugin, MCP, Skills, channels, Gateway events, UI, and subagents each extend and what they do not.

## 1. What This Stage Solves

OpenClaw has many entry points and extensions. If every new channel, model, or tool copies a set of Session/Run logic, the system will quickly fragment. This phase answers:

- What is the difference between native Plugin and MCP Server?
- What capabilities do channel extensions and Agent extensions register respectively?
- How do Gateway's ACK, events, snapshots, seq/stateVersion support offline recovery?
- Why are Control UI, WebChat, and TUI not a second Agent?
- How do Skills and subagents affect context and execution without changing Session ownership?
- When MCP is disconnected, why is tool directory and execution availability not the same thing?

## 2. Remember One Rule

**Extensions can only add capabilities or entry points, they cannot create a new source of truth.**

Provider/channel/tool/hook can register, MCP can add external tools, Skill can add working methods, subagent can open sub-sessions; but the boundaries of Session/Run, writer, approval, transcript are still owned by Gateway/runner.

## 3. Source Code Mainline

1. `src/plugins/` Register native capabilities such as provider, channel, tool, hook, and expose controlled API via `openclaw/plugin-sdk/*`.
2. `src/mcp/` and `agent-bundle-mcp-runtime.ts` Manage external MCP server, tool directory, connections, backoff, and recovery.
3. `src/skills/` Parse skill documents and resources, injecting "how-to" into agent context.
4. `src/agents/subagents/` Create child session with independent writer/run lifecycle and announce.
5. `src/gateway/server-methods/` Expose chat, session, approval, agent RPC; events contain `seq`, snapshots contain `stateVersion`.
6. `ui/src/`, `src/tui/` Consume Gateway/runner contracts; channel adapters only handle ingress/egress and ReplyDispatcher.
7. `src/auto-reply/` Maintain channel reply rhythm, do not directly modify transcript.

## 4. Key Objects and Contracts

| Extension | Adds What | Does Not Have |
| --- | --- | --- |
| Plugin provider | Model/provider adaptation | Session routing and writer |
| Plugin channel | Inbound/outbound channel | Transcript facts |
| Plugin tool | New tool execution | Side effects without approval |
| Plugin hook | Extend observation/adjustment | Replace final approval owner |
| MCP server | External tool protocol | Gateway session routing |
| Skill | Working methods/resources | Permissions and side-effect facts |
| Subagent | Independent child session | Parent session's write rights |
| UI/TUI | Consume state and call RPC | Second set of history |

### Channels and Sessions

A Telegram group, a WebChat page, or a TUI can all map to sessionKey; but a channel itself is not a session. Group chat also has default isolation, thread routing, and reply targets, which cannot be guessed by the Agent itself.

### Gateway Event Recovery

- `seq` Ensures incremental event order; missing numbers mean client missed events and need resync;
- `stateVersion` Ensures snapshots' freshness; old snapshots cannot overwrite new state;
- ACK indicates acceptance, final state must be confirmed by events/snapshots;
- Offline reconnect first fills events/snapshots, does not re-execute run.

### MCP Directory and Execution

After server disconnection, previously discovered tool directories can be kept for display/prompt, but actual invocation requires live connection. Tools may appear but return unavailable and reconnect with backoff; "directory still exists" does not mean "execution is available".

## 5. An Observable Link

```text
Channel / UI / plugin channel
  → Gateway RPC / normalized ingress
  → sessionKey/sessionId
  → run admission
  → agent loop
  → tool registry(plugin/MCP/skill)
  → approval/policy
  → transcript
  → events(seq) / snapshot(stateVersion)
  → ReplyDispatcher / UI
```

## 6. Experiment

### Experiment A: Comparison between Plugin and MCP

Track one plugin tool and one MCP tool respectively. Reference acceptance: plugin goes through in-process capability registration; MCP goes through external protocols and connection lifecycles; Both ultimately pass through the same policy/approval. 

### Experiment B: MCP Lost

Disconnect the MCP server. Reference acceptance: The tool directory is still readable, but running returns unavailable; Avoid reconnecting, do not treat the directory as healthy. 

### Experiment C: Sub-agent

Start a subagent. Reference and acceptance: child session key is independent and has its own writer/run; The parent run ending does not automatically mean the child terminates. 

### Experiment D: Event Gap

The simulated client missed one `seq`. Reference acceptance: Client detection and synchronization of skipped numbers are not needed to overwrite the new state with the old snapshot. 

### Experimental Reference Answers

1. The plugin tool registers within the process, while the MCP uses external protocols/connections; Both ultimately pass through the same policy and approval. 
2. When MCP is lost, the directory is still readable but executed unavailable, causing the system to avoid reconnecting; Directory presence does not mean healthy. 
3. Subagent uses independent child session/writer/run; Parent run does not automatically end child. 
4. If the client finds `seq` skipped numbers, it should be resynchronized; The old `stateVersion` snapshot cannot overwrite the new state. 

## 7. Failure and recovery

| Failure | Root cause | Recovery |
| --- | --- | --- |
| Duplicate channel inbound | Ingress | Deduplicate using event/message IDs |
| UI and Gateway inconsistency | Old snapshot/leak event | Resynchronize by seq/stateVersion |
| Plugin bypasses approval | Registered execution entry | Unified tool policy |
| Skill is treated as permission | Only documentation | is injected. Permissions are still determined by tool/approval |
| Subagent writes parent history | child/parent session obfuscation | Bind child session key |
| MCP tool "Visible but Not Available" | Connection lost | Return unavailable and avoid |

## 8. Pass through customs and self-test

1. What is the difference between Plugin and MCP Server? 
2. Why can't Channel and Session be the same? 
3. What do `seq` and `stateVersion` solve? 
4. Why can't Skill replace permission systems? 
5. How does the parent run end affect the subagent? 
6. Why can't the existence of the MCP directory prove that the tool is executable? 

### Reference answers

1. Plugins are native extensions within the process, allowing registration of provider/channel/tool/hook; MCP is an external utility protocol with independent connections/process lifecycles. Both are ultimately subject to unified tool policies and approvals. 
2. Channel is the source/reply outlet, while Session is the long-term contextual identity owned by the Gateway. A session can continue across channels, and group chats/threads have independent routes; Mixing leads to contextual misalignment or the reply sent to the wrong place. 
3. `seq` Ensure the order of incremental events and detect gaps; `stateVersion` Ensure snapshots are new and old, preventing old snapshots from overwriting new states. The former is stream order, the latter is snapshot consistency. 
4. Skill only injects working methods/resources and cannot express the boundaries of permissions, approvals, and side effects for a single call. Overriding tools must still be rejected by policy/approval/sandbox. 
5. Child is an independent session/run, with its own writer, lane, and lifecycle. The parent run does not necessarily terminate the child; It needs to be explicitly canceled/reclaimed or completed by the child itself. 
6. The directory only discovers results and executes the MCP connection, healthy server, and available tools that need to be live. The directory may still be displayed when the connection is lost, but the call will fail. 

## 9. Source code coordinates

- `src/plugins/`
- `src/plugin-sdk/`
- `src/mcp/`
- `src/agents/agent-bundle-mcp-runtime.ts`
- `src/skills/`
- `src/agents/subagents/`
- `src/gateway/server-methods/`
- `src/auto-reply/`
- `ui/src/`
- `src/tui/`

## 10. Next

Entering Stage 8: What inspection, testing, migration, and operation and maintenance measures ensure these boundaries? In what order should faults be located?
