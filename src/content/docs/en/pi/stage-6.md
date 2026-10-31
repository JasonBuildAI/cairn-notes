---
title: "Stage 6: Expansion and Skills"
description: "Extensions, Skills, and MCP: How New Capabilities Enter the System Without Polluting the Kernel."
---

> **Position of This Stage**: The first five stages have already established loops, context, tools, and model integration. Now, let's look from another perspective: if a capability is not needed by everyone, how can Pi allow it to grow without changing the core?
> **Source Code Directory**: `$PI_SRC`. Core materials: `packages/coding-agent/docs/extensions.md`, `skills.md`, `prompt-templates.md`, `mcp.md`, `codemode.md`, `packages.md`.
> **One-sentence Main Line**: **Only keep general mechanisms in the core; specific capabilities are accessed through pluggable resources.**

## 1. First Understand Why Pi Insists on a "Small Core"

An Agent product can easily drift toward "putting everything into the main program":

- Add an internal company tool;
- Add a special approval process;
- Add a command used only in a specific project;
- Add a new model provider;
- Add a team-specific code review guideline.

If these features are all written directly into the core, the outcome will be:

- Slower and slower startup;
- Longer and longer tool instructions;
- Harder to judge security boundaries;
- Any team's requirement forces everyone to upgrade together;
- Modifying a local feature may affect the entire loop.

Pi's choice is the opposite:

```text
Core: loops, sessions, context, tool pipelines, model interfaces, events
  ↑
  ├── Extension: Executable New Capability
  Skills: On-demand loading of instructions and materials
  ├── Prompt Template: Reusable Input Text
  ├── MCP: Existing external tool services
  └── Pi Package: Package and distribute the above resources
```

So what this chapter really wants you to learn is not 'how to write more APIs,' but: 

> **When encountering a new requirement, which layer should it be placed in?**

---

## 2. Six Types of Resources, First Distinguish Their Uses

### 2.1 A Decision Table

| What You Want | Preferred Method | Reason |
| --- | --- | --- |
| A fixed review/writing/troubleshooting workflow | **Skill** | It is instructions and materials, no need to write code, can be loaded as needed |
| A prompt that is repeatedly input | **Prompt Template** | Just a reusable command, the lightest option |
| New executable actions, event interception, or interfaces | **Extension** | Requires real code execution |
| Already existing external tool services | **MCP** | No need to rewrite the tool, just integrate via protocol |
| Calling multiple tools in one script, filtering intermediate results | **codemode** | Intermediate results do not need to be fully sent back to the model |
| Packaging the above for others to install | **Pi Package** | Unified packaging, versioning, and distribution |

### 2.2 The most important boundary: Instructions vs Code

```text
Skills and Tips Template: Telling the Model 'How to Do It'
Extensions and MCP Tools: Making the System 'Really Work'
```

This distinction is not conceptual, but related to security:

- Skills themselves are mainly text and do not automatically gain execution capabilities; however, they can instruct the model to run accompanying scripts.
- Extensions are TypeScript/JavaScript code that run directly in the Pi process, usually having the same operating system permissions as Pi.
- MCP services may be independent processes or remote services, but tool calls still go through Pi's tool pipeline.
- codemode scripts run in a more restricted JS sandbox, but the tools they call can have real effects.

Therefore, the risk levels of "installing a skill" and "installing an extension" are completely different.

---

## 3. Extensions: Adding New Behaviors at Runtime

### 3.1 What is an Extension

An extension is a module that exports a default factory function. When Pi loads it, it passes `ExtensionAPI` to this function, and the extension registers capabilities within the factory:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Display a greeting",
    handler: async (name, ctx) => {
      ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
    },
  });
}
```

Save as:

```text
~/.pi/agent/extensions/hello.ts
```

During development, it can be loaded directly:

```powershell
cd $PI_SRC
.\pi-test.ps1 --extension $HOME\.pi\agent\extensions\hello.ts
```

Then enter `/hello` in the interactive interface.

Note: Here we are registering a **command**, not a tool for the model to call. Commands are triggered by humans, tools are triggered by models, and the two should not be mixed.

### 3.2 What extensions can contribute

You can remember it as "which layer it wants to access":

| Contribution point | API | Typical use |
| --- | --- | --- |
| Event handling | `pi.on()` | Observe or modify lifecycle, intercept tools, inject context |
| Model tools | `pi.registerTool()` | Add an action callable by the model |
| Slash command | `pi.registerCommand()` | Add `/xxx` manual command |
| Shortcut / CLI toggle | `pi.registerShortcut()` / `pi.registerFlag()` | Change interaction or startup parameters |
| Send messages | `pi.sendUserMessage()` / `pi.sendMessage()` | Actively send content into the session |
| Persist custom state | `pi.appendEntry()` | Save extension data not entering model context |
| Control active tools/models/thought levels | `pi.setActiveTools()`, etc. | Dynamically switch capabilities depending on the task |
| Register provider / virtual model | `pi.registerProvider()` / `pi.registerVirtualModel()` | Integrate new model service or routing |
| Register MCP server | `pi.registerMcpServer()` | Integrate external tool services within extension |
| Custom rendering | `pi.registerToolRenderer()` / `ctx.ui` | Change terminal display |
| Inter-extension communication | `pi.events` | Collaboration among multiple extensions |

For beginners, don't try to memorize all the APIs. First ask:

> Do I want to add an "action", a "command", an "observer", or an "interface"?

### 3.3 Events: the most common extension entry point

Pi events can be understood grouped by topics:

| Topic | What you care about |
| --- | --- |
| Trust and resource discovery | Whether the project can load, which skills and extensions are available |
| Session | New session, restore, switch, compress, close |
| Prompts and execution | Input, start execution, turn end, truly idle |
| Messages and context | Message finalization, context conversion, custom message injection |
| Tools | Pre-call, modify results post-call, dynamically expose tools |
| Model flow | Observe raw events from the provider |
| User input and UI | Edit input, shortcuts, dialog, status bar |

A few of the most important boundaries:

- `before_agent_start`: Before a run starts, can add instructions or messages;
- `tool_call`: Before tool execution, can check, modify parameters or intercept;
- `tool_result`: After tool execution, can modify results or add information;
- `agent_end`: End of low-level loop, but automatic work may still exist;
- `agent_before_settle`: Can still append content or request continuation at the end;
- `agent_settled`: Truly idle, suitable only for notifications, not for starting automatic work;
- `session_shutdown`: Clean up resources, must strive to be idempotent.

### 3.4 Lifecycle: the factory is not the place to "start everything"

The extension factory may run in commands that "only load resources, do not create sessions". Therefore:

- Do not start long-running processes, sockets, watchers, or timers in the factory;
- When long-lived resources are needed, start them in `session_start` or in the command/tool that actually uses them;
- Close connections and clean up subscriptions in `session_shutdown`;
- `/reload` will replace the extension runtime, old context and state cannot continue to be used.

This is the root cause of many extensions being "fine on first load, but leaking upon reload".

### 3.5 Intercepting tools: a practical example

Dangerous commands should not rely solely on model self-awareness. Below is a simplified approach:

```ts
export default function (pi: ExtensionAPI) {
  const dangerous = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i];

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = String(event.input.command ?? "");
    if (!dangerous.some((pattern) => pattern.test(command))) return undefined;

    if (!ctx.hasUI) {
      return { block: true, reason: "Dangerous command is blocked in non-interactive mode" };
    }

    const approved = await ctx.ui.confirm("Allow execution of dangerous commands?", command);
    return approved ? undefined : { block: true, reason: "User refused to execute" };
  });
}
```

This reflects an important principle: **When there is no interface inquiry, the default is to block, not to allow.**

---

## 4. Skills: Bring in the 'ways of doing things' as needed

### 4.1 What is a skill

A skill is usually a directory, which contains `SKILL.md`:

```text
review-checklist/
├── SKILL.md
├── references/
│   └── security.md
└── scripts/
    └── scan.sh
```

`SKILL.md` The beginning is metadata:

```markdown
---
name: review-checklist
description: Used when reviewing code changes, with a focus on security, error handling, concurrency, and regression risks.
---

# Code Review Checklist

1. First, read the callers affected by the changes.
2. Check failure paths, not just success paths.
3. Search to see if similar implementations already exist.
4. Provide reproducible verification steps.
```

### 4.2 What does lazy loading mean

If there are a hundred skills in the system, putting the full text of each skill into the context would be very wasteful. Pi's approach is:

```text
At startup: Only put the path of each skill's name + description +  into the system prompt
When needed: the model reads the full text corresponding to SKILL.md
When information is needed: read references/ again or run scripts/
```

This is called **on-demand loading**. It allows for a large number of skills while only paying the cost for relevant skills for the current request.

Therefore, whether `description` is written accurately directly determines if the skill can be correctly selected. Simply writing "helps handle documents" is usually too vague; specifying "what scenario, what to do, and when not to use it" is what gives routing value.

### 4.3 Skills Are Not 'Automatically Executed'

The main content of a skill is an instruction for the model and will not automatically run just because the file exists. Skills can guide the model to call tools, read attached files, or run scripts, but the actual actions still go through the tool pipeline.

This also means: **when reviewing unfamiliar skills, you should examine its attached scripts and instructions**. It may require the model to perform high-risk operations.

### 4.4 How to Choose Between Skills, Prompt Templates, and Extensions

| Question | Skill | Prompt Template | Extension |
| --- | --- | --- | --- |
| Mainly text instructions? | Yes | Yes | No |
| Requires multiple files, scripts, or references? | Very suitable | Not suitable | Possible |
| Requires executable new tools? | Cannot provide directly | Cannot | Possible |
| Needs to be automatically selected by task? | Yes (based on description) | Usually entered manually | Can listen to events |
| Cost | Low, on-demand loading | Lowest | Medium to high, requires code trust |

In short:

> **If it can be written as a process description, write a skill first; only write an extension if executing code is necessary.**

---

## 5. MCP: Integrate External Tools into the Same Pipeline

### 5.1 What Problem MCP Solves

MCP can be understood as a "universal plug for tool services." If someone has already encapsulated GitHub, databases, file systems, or internal systems into an MCP server, you no longer need to write a Pi-specific tool—you just configure the connection.

```text
Pi tool pipeline
    │
    ├── built-in read/bash/edit/write
    Extended Registered Tools
    └── MCP tools exposed by the server
```

For the model, they are ultimately all tool calls; for permissions, validation, truncation, and session backfilling, the same pipeline should also be followed.

### 5.2 How to connect

```powershell
cd $PI_SRC
.\pi-test.ps1 mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
.\pi-test.ps1 mcp list
```

User-level configuration is usually at `~/.pi/agent/mcp.json`, and project-level configuration is at `.pi/mcp.json`. Project-level configuration will only be loaded after the project is trusted.

MCP tools are usually named:

```text
mcp__<server>__<tool>
```

For example:

```text
mcp__filesystem__read_file
```

### 5.3 Why MCP Tools May Not Appear Directly in the Model's Tool List by Default

An MCP server might expose dozens of tools at once. If all were declared directly, tool descriptions would occupy a large amount of context.

Therefore, Pi supports different exposure methods:

- `codemode` (default): called by codemode scripts, usually not declared directly to the model;
- `deferred`: not declared initially, found by `tool_search` when needed;
- `direct`: declared directly to the model like built-in tools, and can also be called from codemode;
- `hidden`: registered but inaccessible.

The list here is `exposure` of the MCP server. `model-only` belongs to another layer of concept for extension tools and should not be mixed with MCP server exposure methods.

The significance of using `codemode` by default is: **the tools are still available but do not include all tool descriptions in every request.**

### 5.4 MCP Does Not Bypass Permissions

Whether tools come from built-in, extension, or MCP, as long as they go through Pi's tool pipeline, they should undergo parameter validation, `tool_call` interception, result handling, and session recording.

MCP only represents "where the tool comes from," not a reason to "skip security rules."

---

## 6. codemode: Let Scripts Perform "Multi-Step Miscellaneous Tasks" for the Model

### 6.1 Why Codemode Is Needed

Suppose the model needs to accomplish:

```text
Search 20 files → Read 8 hits → Summarize errors for each file → Return only the summary
```

If each step is returned to the model as a tool call:

- All intermediate results are included in the context;
- Loops need to run many rounds;
- A large amount of irrelevant text occupies tokens;
- Costs and latency both increase.

Codemode has switched to a different approach:

```text
The model writes a paragraph JavaScript
  The script calls multiple tools in a sandbox
  The script filters and summarizes by itself
  → Only the script output returns to the model
```

This is not "let the model directly execute arbitrary Node programs." It runs in a restricted QuickJS sandbox, without a file system, network, or timers, and can only reach the outside through controlled `tools` and `models` interfaces.

### 6.2 What It Saves

| What It Saves | Reason |
| --- | --- |
| Context | Intermediate results remain in the script, no need to go into the model at every step |
| Round Trips | A script can call multiple tools concurrently |
| Tool Declaration | Can find tools on demand with search |
| Manual Organization | Script can filter, sort, and aggregate before output |

### 6.3 What Risks It Doesn't Eliminate

Tool calls in the script are real calls:

- Writing a file really writes it;
- Sending a request really sends it;
- If the first half succeeds and the second half fails, the earlier side effects are not automatically rolled back.

So the codemode sandbox limits "what the script itself can directly touch," not "tool calls don't have consequences." Permission policies still need to cover tool calls triggered by the script.

---

## 7. Where to Place It: User-Level, Project-Level, and Package

### 7.1 User-Level and Project-Level

| Location | Scope | Project Trust Required |
| --- | --- | --- |
| `~/.pi/agent/extensions/` | All projects | No |
| `<project>/.pi/extensions/` | Current project | Yes |
| `~/.pi/agent/skills/` | All projects | No |
| `<project>/.pi/skills/` | Current project | Yes |
| `~/.pi/agent/prompts/` | All projects | No |
| `<project>/.pi/prompts/` | Current project | Yes |
| Command line `--extension` | This run | No, but must be explicitly specified by you |

Project resources need trust because they may contain executable extensions, script instructions, and model configurations. Trusting a project means agreeing to let these resources enter the runtime.

### 7.2 Pi Package: Distribution Unit

If a set of capabilities includes extensions, skills, prompt templates, and themes, copying them one by one is cumbersome. Pi Package packages and distributes them via npm, git, or local directories.

Typical Structure:

```text
my-pi-package/
├── package.json
├── extensions/
├── skills/
├── prompts/
└── themes/
```

`package.json` can explicitly list `pi` resources:

```json
{
  "name": "my-pi-package",
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./resources/skills"],
    "prompts": ["./resources/prompts/*.md"]
  }
}
```

Rely on Discipline:

- Put the packages already provided by the Pi host into `peerDependencies`;
- Put third-party packages needed for your own runtime into `dependencies`;
- Do not copy host packages into your own dependency tree, otherwise duplicate instances and initialization conflicts may occur.

---

## 8. Core or Extension: Judgment Exercise

When encountering a requirement, ask in order:

1. **Is it just a process description for the model to see?** Yes → Skill.
2. **Is it just a repeated input prompt?** Yes → Prompt template.
3. **Does it need to actually execute code, intercept events, or modify the interface?** Yes → Extension.
4. **Does an external service already provide the MCP tool?** Yes → Connect MCP first.
5. **Does it require multiple tool calls and filtering intermediate results?** Yes → Consider codemode.
6. **Is it essential for all users and all scenarios, and must it change core invariants?** Yes → Only then discuss core changes.

Here are a few examples:

| Requirement | Recommendation | Reason |
| --- | --- | --- |
| Always review according to the same safety checklist | Skill | Pure process, load as needed |
| Generate a fixed-format change summary before each submission | Prompt template or Skill | No new execution ability required |
| Intercept `rm -rf` and require confirmation | Extension | Needs to listen to tool events |
| Connect to company's existing Jira MCP server | MCP | Protocol service already exists, no need to rewrite |
| Batch search 50 files and only return error summaries | Codemode | Multi-step calls, intermediate results should stay in script |
| Add a new messaging protocol for all models uniformly | Core discussion | May change global conventions, extension may not be suitable |

The threshold for core changes should be high because the core is a stable area shared by everyone; extensions are suitable for local, optional, and replaceable capabilities.

---

## 9. Security and Trust: Extensions Require the Most Caution

### 9.1 What Extensions Can See

Extensions run in the same process as Pi and may see:

- User input and model output;
- Tool call parameters;
- File contents;
- Credentials and request headers;
- Session history;
- Working directory and process environment.

So "only install trusted extensions" is not just courtesy, but a security boundary.

### 9.2 Skills and Packages Are Not Risk-Free Either

Skills may instruct the model to run scripts; packages may contain extension code. Project trust only determines "whether to load project resources" and does not guarantee the safety of the resources themselves.

### 9.3 Least Privilege Principle

- If only reading files is needed, do not grant write tools;
- If only one MCP server is needed, do not set all servers to direct;
- Dangerous tools should have interception and confirmation;
- Review source code before installing third-party extensions;
- Place truly high-risk tasks in containers or restricted accounts.

---

## 10. Hands-On Experiments

### Experiment 1: Write a Minimal Command Extension

Put the previous `hello.ts` into the user extension directory, load it, and input `/hello`. Confirm:

- It does not require model invocation;
- It is just a command for human use;
- Removing the file or reloading makes it disappear.

### Experiment 2: Write a Skill

Create:

```text
~/.pi/agent/skills/review-checklist/SKILL.md
```

Write down `name` and `description`, then enter:

```text
/skill:review-checklist Check the code I just modified
```

Observe whether the model reads the skill description and attached materials. Then deliberately write the description very vaguely and see if it can still be automatically selected.

### Experiment 3: Connect to an MCP server

```powershell
cd $PI_SRC
.\pi-test.ps1 mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
.\pi-test.ps1 mcp list
```

Then in the session, use `/mcp` to check tools, exposure methods, and connection status.

### Experiment 4: Comparing Direct Calls and Codemode

Have the model complete the same set of searches and summaries using both "calling tools one by one" and "a codemode script." Compare:

- Number of events;
- Intermediate content entering the context;
- Token usage;
- Whether partial side effects remain if it fails.

---

## XI. Common Misconceptions

| Misconception | Correct Understanding |
| --- | --- |
| All new requirements should be added to the core | Keep the core minimal; local capabilities should preferably be made as extensions/skills/MCP |
| A skill is an automatically executable script | Skills mainly provide instructions and data, actions are still carried out through the tool pipeline |
| Extensions are just configurations | Extensions are executable code, with process permissions similar to Pi |
| MCP tools bypass permissions | As long as they enter the tool pipeline, they should undergo the same verification and interception |
| Codemode is a full Node environment | It is a restricted JS sandbox and can only access external resources through controlled interfaces |
| Codemode does not produce real side effects | The tools it calls execute realistically, and failures do not automatically roll back |
| Project trust guarantees everything is safe | Trust only controls resource loading and does not guarantee resource safety |
| A package is just a collection of files | Packages can include extension code and scripts and should be reviewed before installation |
| More tools are better | Tools occupy context, increase decision difficulty, and raise risks |

---

## XII. Self-Check

Please answer:

1. Why does Pi insist on "keeping the core minimal and externalizing capabilities"?
2. What problems are solved by skills, prompt templates, extensions, MCP, and codemode?
3. What should the extension factory, `session_start`, and `session_shutdown` each do?
4. Why is it unsuitable to start long-running processes in the extension factory?
5. Why do skills load only the description first? How does this benefit context?
6. Why must MCP tools still go through the tool pipeline?
7. What costs does codemode save, and which risks does it not eliminate?
8. Under what circumstances should the core be changed?

Suggested deliverables:

- [ ] An extension command that can be loaded;
- [ ] A skill that can be automatically selected;
- [ ] A "Skill / Extension / MCP / Codemode" decision table;
- [ ] A 3-minute explanation on why "externalizing capabilities" makes the system more stable and what new trust issues it brings.

Next stop is Stage 7: Interface and Integration. Capabilities can now grow, and the next step is to see how the same engine can serve humans, scripts, and external programs.

---

*Accompanying [Learning Path](../learning-path/) Stage 6 · Based on v1.3.0 (`71023aec`)*
