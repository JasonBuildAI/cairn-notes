---
title: "Stage 4: Tools and Side Effects"
description: "How tools are registered, invoked, approved, and observed determines what the Agent can do."
---

> **Position of this stage**: In the loop of Stage 2, there is a sentence "execute tool," and Stage 3 explains how tool instructions and results enter the context. Now, let's break down this middle section completely.  
> **Source code directory**: `$PI_SRC`. All paths in this article are relative to this directory.  
> **Core issue**: The model only generates text. When it says it wants to read a file or run a command, how does Pi determine whether this statement can be executed, how to execute it, and how to safely send the result back to the model?  
> **Remember one sentence first**: **The model proposing a tool call does not mean the tool has been executed.** There is a whole pipeline between "proposal" and "actually happening."

## 1. What exactly is being learned in this stage

If you were to summarize in one sentence the difference between an Agent and a regular chat bot, it would be:

> A normal chat bot can only "answer the world," whereas an Agent can "change the world" through tools.

Here, "change" can mean reading a file, searching code, or modifying files, running commands, and calling external services. The greater the capability, the greater the risk. Therefore, this chapter on tools is not simply about "how to hook up a few more APIs," but also aims to answer three questions at the same time:

1. **How does the model know which tools are available?**
2. **Once the model says "I want to call," how does Pi turn it into a trustworthy execution?**
3. **How does the execution result get back to the model without overloading the context or breaking the system?**

After studying this chapter, you should be able to draw the following line and explain each segment:

```text
There is a 'Tools Menu' in the system prompt.
          │
          ▼
Model output toolCall: Tool name + parameters
          │
          ▼
Find tool → Validate parameters → Permission check → Actual execution
          │
          ▼
Truncate large results → Generate toolResult → Write to session
          │
          ▼
In the next round of projection, bring toolResult along with the → model to continue the judgment
```

### Passing Criteria

- Can clearly explain why "tool invocations by a model" and "actual execution" are not the same thing;
- Can explain what parameter validation, permission checks, execution methods, truncation, and backfilling each prevent;
- Can independently write a custom tool and successfully invoke it in a real conversation;
- Can point out the dangerous boundaries of a tool, rather than just saying "it's very useful".

---

## 2. First, explain the word "tool" in plain language

### 2.1 A tool is not part of the model

The model itself only predicts the next piece of text based on context. It cannot directly open your hard drive, nor can it start processes on its own.

What can actually do things is a program running in the Pi process. For easier understanding, a tool can be thought of as a menu in a restaurant:

| Things on the menu | Corresponding part in the tool | Function |
| --- | --- | --- |
| Dish name | `name` | The model uses this name to "order" the dish |
| Dish description | `description` | Tells the model when to use it |
| Optional ingredients and format | `parameters` (schema) | Specifies what the parameters look like |
| The kitchen actually cooks | `execute()` | Performs real actions after receiving parameters |
| Serving the dish | Returned result | Becomes `toolResult` that goes back to the model |

The model sees the **menu**, not the kitchen. It outputs "I want a tomato scrambled eggs, with less salt," rather than cooking the dish itself.

### 2.2 A single tool invocation contains two completely different things

This is the most important distinction in this chapter:

| Stage | Who does it | Product | Has real impact already? |
| --- | --- | --- | --- |
| Model proposes invocation | Model | `toolCall { name, arguments }` | No, it's just text |
| Pi executes invocation | Pi and tool code | `toolResult { content, details, ... }` | May have already read/write files, started processes |

So when seeing the model say "I will delete this file," it must never be interpreted directly as "the file has been deleted." Pi still needs to find the tool, check parameters, go through hooks, and finally decide whether to actually execute it.

### 2.3 Tool declaration and tool result are two types of messages

In context, they also occupy different positions:

- **Tool declaration**: placed in system prompts or the list of available tools, telling the model "what you can use";
- **Tool invocation**: a `toolCall` in an assistant message, indicating "what I want to use";
- **Tool result**: a `toolResult` message, indicating "what actually happened";
- **Tool rendering**: the display format shown to humans in the terminal, which does not affect what the model sees.

If these three are mixed together, questions like "how does the model know the file content" or "why did the tool error but not crash" will repeatedly arise.

---

## 3. The eight gates of a single tool invocation

First, look at the overview. Different tools are implemented differently, but the main process goes through a similar procedure:

```text
① Definition        What name the tool has, description, parameters, execution function
② Exposure        This request allows the model to see which tools
③ Verification: Check whether the parameters written for the model are legal and complete
④ Permissions        Whether this action is allowed by rules or users
⑤ Execution        Sequential execution or parallel execution
⑥ Truncation        How to cut big results down to a range that the context can handle
⑦ Backfill        How does the result turn into toolResult and enter the conversation
⑧ Rendering        How people see calls and results in the terminal
```

This table first establishes an overall impression:

| Checkpoint | Questions to Answer | What Happens If It Fails |
| --- | --- | --- |
| Definition | What exactly is this tool? | Without a manual or execution logic, the model cannot use it reliably |
| Exposure | Can the model see it this time? | Too many tools waste context; tools not enabled should not be called |
| Validation | Are the parameters trustworthy? | Returns incorrect results, prompting the model to correct in the next round |
| Permission | Is this action allowed to occur? | Execution is blocked, generating a "blocked" result |
| Execution | Who runs it, can it run in parallel? | Potential conflicts, freezes, or side effects |
| Truncation | Will the result be too large? | Could overflow context, slow down requests, and increase costs |
| Backfill | How does the result enter history? | The model cannot see the result, breaking the loop's ability to judge |
| Rendering | Can humans understand what happened? | Does not affect the model, but seriously affects debugging and trust |

Next, we go through each checkpoint. Do not memorize function names; first remember what problem each checkpoint is preventing.

### 3.1 First Checkpoint: Definition—The Tool Must Have a "Manual" and an "Executor"

A tool must have at least four things:

```ts
{
  name: "hello",
  description: "Greet the specified person",
  parameters: Type.Object({
    name: Type.String({ description: "The name of the person to greet" }),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text", text: `Hello, ${params.name}!` }],
    details: { greeted: params.name },
  }),
}
```

Among them:

- `name` is the unique name used when calling the model;
- `description` is the "when to use, what limitations" written for the model;
- `parameters` is the description of the parameter structure, and also serves as the basis for runtime validation;
- `execute()` is the code that actually executes.

Note that `description` is not a decorator. The model can only use it to determine whether to call this tool, so vague descriptions like "read file" are far less useful than "read text or image; for large files use offset/limit to continue reading."

A tool can also have:

- `outputSchema`: the structured result shape visible to the program caller;
- `promptSnippet` / `promptGuidelines`: additional usage rules in system prompts;
- `renderCall` / `renderResult`: terminal display method;
- `executionMode`: whether this tool can run in parallel with other tools;
- `prepareArguments`: compatibility adjustments before formal validation.

### 3.2 Second Stage: Exposure — Which tools does the model actually see in this request

"Tool exists in the system" and "the model can see it this time" are two different things. Pi has an **active tool set**, and only active tools are declared to the model.

Default tools are usually `read`, `bash`, `edit`, `write`. They can be changed through settings or command line.

```powershell
# Read-only access only, suitable for code review
.\pi-test.ps1 --tools read, grep, find, ls --print "Review this project"

# Add codemode to the default tool
.\pi-test.ps1 --tools +codemode

# This run does not give any tools at all
.\pi-test.ps1 --no-tools --print "Answer only based on the text I give you"
```

Both user-level and project-level `defaultTools` also affect the activity set. If a list only contains `+name` or `-name`, it indicates additions or deletions on inherited selections; writing ordinary names means reassigning a group.

Why control exposure?

- The more tools, the more tokens are used for tool descriptions;
- Tools that are not used can distract the model's attention;
- Disabling write tools in read-only scenarios can reduce the risk of accidental operations.

But note: **reducing tool exposure is a capability constraint, not a security sandbox.** As long as a tool is still available, it usually runs with the OS permissions of the Pi process.

### 3.3 Stage Three: Validation — You cannot directly trust the parameters the model outputs

The model may provide:

- Missing required fields;
- Writing numbers as strings;
- Extra fields that the schema does not recognize;
- JSON that gets truncated halfway through generation;
- Paths or commands that look reasonable but are actually out of bounds.

Therefore, schema validation must be performed before execution. `parameters` is not just instructions for the model, but also a runtime contract for checks.

If validation fails, the normal path is not to crash the whole process, but to generate an error `toolResult`:

```text
Tool read failed: missing required property "path"
```

In the next round, when the model sees this error, it might resend the correct parameters. This reflects the characteristic of the Agent loop: **errors are inputs for the next round of decision-making, not exceptions that necessarily terminate the system.**

It is necessary to distinguish between two types of errors:

| Error Type | Example | Handling |
| --- | --- | --- |
| Call errors that can be fed back to the model | Missing parameter fields, tool does not exist, file does not exist | Turn into a `isError: true` result and continue the loop |
| System-level failure | Process crash, session file corruption, unrecoverable runtime errors | May terminate the current run or report an error upwards |

An ordinary failure inside a tool should usually also 'return a failure result,' rather than just writing the error into the main text. This way, the model, interface, and program caller all know that it was a failure, not just a piece of regular text.

### 3.4 Fourth Gate: Permission — Valid parameters do not mean the action should occur

This is the most easily underestimated gate.

Parameter validation answers 'Is the format correct?', while permission validation answers 'Should it be allowed to happen?'. For example:

```text
The command format is completely valid: rm -rf ./important-folder
```

The format is fine, but the consequences may be unacceptable.

Pi provides `beforeToolCall` as a hook at this level, and extensions can listen to `tool_call`, check the tool name and parameters, and then return:

```ts
{ block: true, reason: "This command requires manual confirmation" }
```

Blocked calls will not be executed; instead, they become an error result returned to the model. In non-interactive mode, if there is no interface to ask the user, the correct default behavior is usually **to intercept dangerous actions**, rather than silently allowing them. 

Here, it is necessary to distinguish between two concepts:

| Concept | What it governs | What it does not govern |
| --- | --- | --- |
| Project trust | Whether to load project-provided settings, extensions, skills, and other resources | Does not limit which files the enabled tools can access |
| Runtime permissions/approval | Whether a particular tool call is allowed to execute | Not an OS-level sandbox |

The official Pi documentation clearly reminds: **Project trust is not a complete security boundary; tools and extensions still run with the permissions of the Pi process.** To truly isolate risks, OS-level measures such as containers, virtual machines, or restricted accounts are needed.

### 3.5 Level Five: Execution — Sequential or Parallel, Not Arbitrary

A single assistant message can request multiple tool calls simultaneously. For example:

```text
Please read a.ts, b.ts, and c.ts in parallel, and then compare their differences.
```

Pi supports two execution modes:

- **Sequential**: one tool prepares, executes, and finishes before starting the next;
- **Parallel**: first prepare and check in order, then allow tools that can run in parallel to execute simultaneously.

Why can't everything run in parallel?

- Two tools might modify the same file at the same time;
- One tool might depend on the state just created by another tool;
- Shared memory states can be corrupted by concurrency;
- Some external services are not suitable for multiple simultaneous requests.

So besides the default strategy, you can also set `executionMode: "sequential"` for individual tools. Built-in file modification tools also use a file-level mutex queue to avoid read/write conflicts on the same file.

There's another detail with parallel execution: `tool_execution_end` may appear in the order of completion, but tool result messages must ultimately be written into the session in the order of calls in the assistant message. Otherwise, the model will get confused about "which result belongs to which call."

### 3.6 Level 6: Truncation—More Tool Output Is Not Always Better

Suppose a command outputs 10 MB of logs. Roughly estimating "4 characters per token," that's millions of tokens. The output may directly exceed the model's context limit; even if it doesn't, it will make requests slower, more expensive, and noisier.

Pi's built-in file and command tools generally use two limits, truncating based on whichever is reached first:

- Up to 2000 lines;
- Up to 50 KB.

Different tools retain different parts:

- `read` is more like "reading a file from the start," so it retains the beginning and prompts to use `offset` to continue;
- `bash` is more like "looking at command output," so usually it retains the end, because errors and summaries are often at the end;
- The full truncated output can be written to a temporary file, with the result telling the model where the complete file is.

This forms an important design principle: **truncation does not discard data, but separates the "summary the model currently must see" from the "full data available if needed."**

### 3.7 Level 7: Backfilling—How Results Return to Context

After a tool executes, Pi generates a tool result message, with key fields including:

| Field | Viewed by | Enters model context |
| --- | --- | --- |
| `content` | Model | Yes, text or image |
| `details` | Interface, state restoration | Usually not model main content |
| `structuredContent` | Codemode and other program callers | Not model main content |
| `isError` | Model and program | Yes, indicates failure |
| `usage` | Cost statistics | Not directly main content |

A common misconception is that "all tool return values go into the model." In fact, they do not:

- The model mainly reads `content`;
- `details` can be kept for interface rendering or state restoration;
- `structuredContent` is used by scripts and other programmatic callers;
- How the renderer displays it does not alter the model context.

Once tool results are written to the session, the next projection includes them, and the model decides:

- If enough information is available, provide the final answer;
- If something is missing, continue to call tools;
- If an error occurs, try a different approach.

### 3.8 Level 8: Rendering—Models See "Content," Humans See "Process"

A single tool call has two types of audiences:

- The model needs results that are understandable;
- Humans need to know "what it did, how long it took, where it failed."

`renderCall` can show call parameters, `renderResult` can fold long results, highlight errors, and show elapsed time. Issues in rendering usually do not change the Agent's decisions but can seriously affect human trust.

A mature tool typically separates "semantics" and "display:"

```text
execute() determines what actually happened
content   determines what the model can see
details determine what the interface can supplement
The renderer determines how people see it
```

---

## 4. Why does the loop continue after a tool fails

Beginners often ask:

> The tool reported an error, so why doesn't Pi just stop?

Because many errors are **recoverable information** for the model:

```text
First call: read("src/old-name.ts")
Result: File does not exist
Next step for the model: first ls("src"), find the real file name, then read it
```

If one terminates whenever encountering a "file not found" error, the Agent loses its most basic error-correction capability.

However, there are three types of situations that require special handling:

1. **Parameter validation failure**: Do not execute the tool, return an error result;
2. **Permission interception**: Do not execute the tool, return the reason for being blocked;
3. **User cancellation**: Cancel the running tool and subprocesses through `AbortSignal`, and mark the result as aborted.

Therefore, "tool failure" and "run failure" are not synonyms. The former often serves only as a clue for the next round, whereas the latter means the entire run cannot continue.

---

## 5. Settings, Trust, and Platform: Do Not Confuse into One Layer

### 5.1 The Hierarchy of Tool Selection

When actually starting, tool selection is roughly influenced by these layers:

```text
Built-in default tool
  → User-level settings
  Project-level settings (after the project is trusted)
  This command line argument
```

Numeric settings usually allow the latter to override the former; for tool lists, you need to distinguish between "replace the entire set" and "only add or subtract." This is also why `["+codemode"]` retains the default tools, while `["read", "grep"]` is changed to a new set of selections.

### 5.2 Trust and Approval Are Not the Same Door

To emphasize again:

- **Project Trust**: Decides at startup whether "this project can load the resources it provides";
- **Tool Approval**: Decides at runtime whether "this specific action can be executed";
- **System Isolation**: Decides "even if executed, which files, networks, and processes it can at most access."

The three address different layers of issues. Marking a project as "trusted" does not automatically make all commands safe; refusing trust in a project does not automatically prevent already enabled tools from accessing paths outside the working directory.

### 5.3 Why Windows Didn't Change the Loop

On native Windows, Pi can additionally provide a `powershell` tool. It shares the framework of "starting subprocesses, streaming output collection, truncating results, and handling interruption" with `bash`, only the specific shell differs.

This shows the tool-layer boundary design is correct:

> The engine only recognizes the "tool interface", and does not need to know whether today it's bash, PowerShell, or another executor.

Platform differences remain in the tool implementation; loops and context layers don't need long branches.

---

## 6. Writing a Minimal Custom Tool by Hand

### 6.1 Where to Place It

The simplest approach is to put it in the user extension directory:

```text
~/.pi/agent/extensions/hello.ts
```

On Windows, it is usually:

```text
C:\Users\<your username>\.pi\agent\extensions\hello.ts
```

### 6.2 A Complete Example

```ts
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const helloTool = defineTool({
  name: "hello",
  label: "Hello",
  description: "Greet the specified person. Only use when the user explicitly requests to test the hello tool.",
  parameters: Type.Object({
    name: Type.String({ description: "The name of the person to greet" }),
  }),

  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `Hello, ${params.name}!` }],
      details: { greeted: params.name },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(helloTool);
}
```

This piece of code does three things:

1. Defines parameters using `Type.Object`;
2. Returns `content` visible to the model using `execute`;
3. Registers the tool into Pi in the extension factory.

### 6.3 Load and Verify

During development, you can load just this file:

```powershell
cd $PI_SRC
.\pi-test.ps1 --extension $HOME\.pi\agent\extensions\hello.ts
```

Then enter in the interactive interface:

```text
Please call the hello tool and greet 'Xiao Ming'.
```

You should be able to observe:

- The model generated a `hello` tool call;
- The parameters include `name: "Alice"`;
- The tool returned `Hello, Alice!`;
- The model gave the final answer based on the result.

If the model didn't make a call, first check whether the tool is actually loaded and whether the description is clear, rather than immediately suspecting a loop.

### 6.4 Checklist for upgrading from a "toy tool" to a "real tool"

- [ ] `description` clarifies when to use it and when not to use it;
- [ ] Keep the parameter schema as narrow as possible, do not accept a large blob of free text;
- [ ] When potentially generating a large amount of output, use a unified truncation tool and tell the model where the complete result is;
- [ ] For tools that may modify files, handle concurrent writes to the same file;
- [ ] On failure, return `isError: true` or throw an error; do not just write "failed" in the main text;
- [ ] For tools with side effects, consider whether to execute them serially;
- [ ] Before dangerous actions, provide interceptable permission hooks;
- [ ] If needed for codemode, declare `outputSchema` and return the corresponding `structuredContent`;
- [ ] Add a simple rendering for the most important results to avoid seeing just a lump of JSON in the terminal.

---

## 7. Three observation experiments you can do immediately

### Experiment 1: Observe a complete event of a tool call

```powershell
cd $PI_SRC
.\pi-test.ps1 --mode json "Read the first 20 lines of package.json" > tools-events.jsonl
```

Look in the event stream:

1. `toolcall_start/delta/end` in the assistant message;
2. `tool_execution_start`;
3. `tool_execution_end`;
4. Tool result message;
5. Next `turn_start`.

Then answer: **Is the tool result generated by the model, or generated after Pi execution?**

### Experiment 2: The difference between read-only mode and write mode

```powershell
.\pi-test.ps1 --tools read, grep, find, ls --print "Do not modify any files, just explain what this repository does"
```

Compare with the default toolset again. Think about:

- What changes if fewer writing tools are exposed?
- Why does this not equal putting the entire process in a sandbox?

### Experiment 3: Deliberately Causing a Tool Error

Have the model read a non-existent file and observe whether it will first list the directory and then retry. You should focus on:

- Whether the error turns into a tool result;
- Whether the loop continues;
- How the model uses error information to correct the next step.

---

## 8. Common Misconceptions

| Misconception | Correct Understanding |
| --- | --- |
| If the model says to call a tool, the tool has already executed | The model only generates the intent to call; Pi still has to verify, approve, and execute |
| Passing parameter validation means it's safe | Validation only checks format; dangerous actions still require permission policies and isolation |
| If the project is trusted, the tool is safe | Trust only affects project resource loading, not the file system sandbox |
| Tool errors will terminate the entire Agent | Ordinary errors become `isError` results, and the model can retry based on them |
| All return values go into the model context | The model mainly reads `content`; `details` and `structuredContent` serve other purposes |
| Parallel execution is always faster | When there is shared state or write conflicts, sequential execution is required |
| Truncation means losing data | Common practice is to truncate what the model can see while keeping the full output path |
| The renderer affects model judgment | Rendering mainly serves humans; context is determined by content and projections |
| More tools mean stronger capabilities | More tools take up more context and increase the risk surface; select according to the task |

---

## 9. Self-Check

Close the document and try to answer without looking:

1. What is the difference between `toolCall` generated by the model and `toolResult` generated by Pi?
2. What checkpoints does a tool call pass from "finding the tool" to "entering the next round"?
3. Why does valid parameters not mean it can be executed?
4. What scenarios are suitable for sequential execution and parallel execution respectively?
5. Why should large outputs be truncated? Where is the complete content usually stored after truncation?
6. Who uses `content`, `details`, `structuredContent` respectively?
7. Why can't project trust replace a container or OS sandbox?
8. After a tool fails, why can the loop usually continue?

Suggested deliverables:

- [ ] A lifecycle diagram with eight checkpoints;
- [ ] A custom tool that can be truly called in Pi;
- [ ] A JSON event stream marking "call → execute → result → next round";
- [ ] A 3-minute explanation of why tools are the Agent's greatest capability and risk boundaries.

The next stop is Stage 5: Model Integration. Tools are responsible for "doing," while the model adaptation layer is responsible for answering "how different vendors' models and services can be used by the same loop." 

---

*Accompanied [Learning Path](../learning-path/) Stage 4 · Based on v1.3.0 (`71023aec`)*
