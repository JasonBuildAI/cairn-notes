---
title: "Stage 2: Agent Assembly and LangGraph Loop"
description: "Stage 2: Agent assembly and LangGraph loop. Follow the main source code line to understand facts, contracts, observable evidence, and failure recovery."
---

> Course: DeerFlow Source Code Class · Stage Exam
> Prerequisite: Stage 1, understanding LangGraph's graph/checkpoint
> Corresponding overview: `run-lifecycle.md`, `core-mechanisms.md`
> Goal of this phase: Follow from `make_lead_agent()` all the way to model invocation and tool iterations.

## 1. What this phase addresses

Run is just the shell; the real work is done by the assembled graph:

~~~text
make_lead_agent(config)
  → assemble_lead_agent
  → Analysis Model/Agent Configuration
  → Create Tool
  Building middleware order
  → create_deerflow_agent
  Compile graph
  → worker astream
~~~

Assembly is not about shoving all capabilities in at once, but about first determining identity, permissions, and running mode, and then deciding which tools, middleware, and budget enter this round.

## 2. First, remember a judgment

**The model only sees the assembly result, not the assembly process.**

In `messages`, there is no "why this tool is hidden" or "why this middleware is before approval," but these assembly decisions directly change the model's available actions. When troubleshooting Agent behavior, first look at the assembly description, then at the model output.

## 3. Source Code Mainline

1. `agents/__init__.py::make_lead_agent` is the LangGraph compatible entry point.
2. `lead_agent/agent.py::assemble_lead_agent` freezes in checkpoint mode and returns `LeadAgentAssembly`.
3. `_assemble_lead_agent` parses user, agent, model, thinking/reasoning, subagent, and skill configurations.
4. Tools are merged according to permissions from `tools/`, sandbox tools, memory tools, MCP, skills, etc.
5. `build_middlewares()` assembles dynamic context, skill, tool policies, sub-agent restrictions, budget, final-state protection, etc., based on runtime conditions.
6. `agents/factory.py::create_deerflow_agent` assembles model, tools, middlewares, and state into a graph.
7. Workers consume values/updates/messages patterns via `astream` and convert them into journal/SSE facts.

## 4. Key Objects and Contracts

| Object | Function | Key Points |
| --- | --- | --- |
| `LeadAgentAssembly` | Graph Assembly Description | Lets observers not have to guess private runtime fields |
| `build_middlewares` | Behavior Chain | The sequence determines "who sees/rewrites the call first" |
| `create_deerflow_agent` | General Graph Factory | Responsible for structure, not for taking product orders |
| `SubagentLimitMiddleware` | Concurrency/Total Limits | Capability ceilings cannot be relaxed by the model itself |
| `TerminalResponseMiddleware` | Empty Response/Silent End Protection | Avoids "not answering but showing success" |
| `ClarificationMiddleware` | Cleanup Gate | Fixed at the end of the chain to prevent later tampering |

## 5. An Observable Link

~~~text
config
  → model_name Analysis and Authorization
  → tools merge
  → middleware order
  → create_deerflow_agent
  → graph.astream
  → AIMessage(tool_calls)
  → tool middleware/execute
  → ToolMessage
  Next-generation model
  → Final state or clarification
~~~

Don't just look at the return value of `agent.astream()`; What truly determines tool visibility, budget, and end-state is the toolsheet and middleware chain formed during assembly. 

## 6. Experiment

### Experiment A: Print assembly descriptions

Observe on the path where the assembly observer exists `build_assembly_descriptor()`. Reference acceptance: You can see summaries of namespace, model, tool schema, middleware, and policy. 

### Experiment B: Verify the middleware sequence

In the record list before and after `build_middlewares()`, focus on the relative positions of `SubagentLimitMiddleware`, `TokenBudgetMiddleware`, `TerminalResponseMiddleware`, and `ClarificationMiddleware`. Reference observation: Limiting and terminal state protection remain active in model/tool rounds, not just once. 

### Experiment C: Contrast Planning Patterns

Create diagrams using `is_plan_mode=false` and `true` respectively, comparing `TodoMiddleware` and the tool set. The acceptance point is that the difference comes from the assembly strategy, not from the model "deciding for itself." 

### Experimental Reference Answers

1. The description should include namespace, model, tool schema, middleware, and policy summaries, which can be explained by configuration/assembly code rather than runtime self-reporting. 
2. Constraints, budgets, end-states, and clarifications should be made of the relative order of middleware; These must remain effective throughout model and tool rounds, and changing sequence will change who is truncated and who closes first. 
3. Planning patterns should change behavior through different middleware/tool assembly; If only prompts are used to "stop running," it does not count as assembly-level isolation. 

## 7. Failure and recovery

| Assembly failure | Root cause layer | Recovery method |
| --- | --- | --- |
| Model configuration is empty | Configuration/Authorization | Fix configuration first, do not modify the drawing |
| Tool Name Conflict | Tool Registration | Naming and Deduplication Rules |
| Sub-agent overlimit | Capacity/Policy | Adjust server capacity, not relax validation |
| Null reply is treated as successful | Terminal state middleware | Check `TerminalResponseMiddleware` |
| Checkpoint mode inconsistency | Runtime mode | Maintain process-level freeze mode consistent |

## 8. Pass through customs and self-test

1. What are `make_lead_agent`, `assemble_lead_agent`, and `create_deerflow_agent` each responsible for? 
2. Why does middleware sequencing change the security semantics? 
3. Why is the model's thinking switch decided during assembly? 
4. Why can't the concurrency limit for child agents be set by the model itself? 

### Reference answers

1. `make_lead_agent` is the LangGraph-compatible Graph factory entry; `assemble_lead_agent` is responsible for freezing the runtime mode and returning the graph and assembly description; `create_deerflow_agent` is responsible for combining models, tools, middleware, and state structures into executable graphs. Order acceptance, permissions, and product entry points are not included in these systems. 
2. Because middleware can see and rewrite model requests, tool calls, and results. If approval is placed after a hook for parameter rewrite, approval does not see the original call; If budget is placed after terminal protection, it may not be enough to prevent overruns. The order itself is a contract. 
3. Thinking/reasoning affects model capabilities and requested shapes, and also influences whether certain visual/contextual middleware is enabled; Parse and authorize first to make consistent decisions when building models and assembly tools. 
4. Concurrent sub-agents consume the same run's capacity, event namespace, and budget. Capacity is a host resource, not a model's wish; The model can only make requests, and the server must execute at the maximum freeze at startup. 

## 9. Source code coordinates

- `backend/packages/harness/deerflow/agents/__init__.py`
- `backend/packages/harness/deerflow/agents/lead_agent/agent.py`
- `backend/packages/harness/deerflow/agents/factory.py`
- `backend/packages/harness/deerflow/agents/middlewares/`
- `backend/packages/harness/deerflow/agents/assembly_descriptor.py`

## 10. Next

Entering Stage 3: The graph already calls the model, but what messages, memories, and budgets does the model actually see this round?
