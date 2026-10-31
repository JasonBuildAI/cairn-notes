---
title: "Stage 9: Rebuilding a mini agent"
description: "Rebuild a mini agent from scratch to test your understanding of the system."
---

> **Position of this stage**: The first eight stages have already explained Pi's seven components separately. This stage does not introduce new knowledge points, but rather reassembles the seven components to create a **small yet complete** Agent.  
> **Reference for source code directory**: `$PI_SRC`. It is best to implement your work in a separate directory, without directly modifying the learning area source code.  
> **Final goal**: Even without looking at Pi's source code, you should be able to explain why an Agent is structured this way, and be able to create a mini agent that can run, be tested, and clearly explain trade-offs.  

## I. What the graduation project actually requires you to do

It is not about copying a few examples from Pi, nor creating a product with many functions, but about completing an **end-to-end minimal slicing**:

```text
User Input
  → Chat Records
  Activity Branch Projection
  → Model Request
  Streaming response
  Tool Invocation
  → Tool result backfill
  Next round
  Final answer
  → Event Output and Testing
```

Minimum Deliverables:

- [ ] A loop: supports model responses, tool calls, tool result reintegration, natural stopping, and abortion;
- [ ] A session record: saves at least messages, tool results, and one compressed summary; can explain the tree, branches, and active paths;
- [ ] A context projection: can generate model messages from the active path, retaining the original text after compression;
- [ ] Two tools: one read-only tool and one tool that produces side effects, with explanation of checksums and risks;
- [ ] A model adapter: connects to at least one provider, capable of handling streaming text, tool calls, and errors;
- [ ] An interface: CLI or JSON event output, at least able to observe the execution process externally;
- [ ] A trace record: exports the event sequence of a complete request, can explain messages, tools, and stop reasons step by step;
- [ ] A set of tests: using a dummy model to test loops, tools, branches, and error paths;
- [ ] A design document: depicts seven structural blocks, explaining three key trade-offs.

**Do not** add at the beginning:

- Multi-user and permission systems;
- Distributed task queues;
- Vector databases;
- Complex front-end;
- A dozen tools and a dozen providers.

First, complete one vertical slice clearly before considering expansion.

---

## II. Overall Structure of the Mini Agent

### 2.1 A General Diagram

```text
CLI / JSON
    │ Input, Commands, Event Subscription
    ▼
MiniSession
    │ Manage a run, active leaf, queue
    ├──────────────► SessionStore
    │                 entry tree, only append
    │
    ├──────────────► Projector
    │ Active Branch + Compress + Edit → Model History
    │
    ▼
MiniLoop
    ├──────────────► ModelAdapter
    Unified Requests and Streaming Events
    │
    └──────────────► ToolRegistry
                      Validation, Permission, Execution, Truncation
```

There is also an event stream beside it:

```text
Loop / Session Generate Event
  → CLI Print
  → JSON mode output JSONL
  → Test collection and assertion
```

This diagram corresponds one-to-one with the seven components of Pi:

| Seven Components | Corresponding Elements in the Mini Agent |
| --- | --- |
| Loop | `MiniLoop` |
| Context | `SessionStore` `Projector` |
| Tools | `ToolRegistry` two tools |
| Model Integration | `ModelAdapter` |
| Extensions | You can initially leave a simplest hook interface |
| Interface | CLI and JSON event output |
| Engineering | Fake model tests, event tests, design documents |

### 2.2 Recommended Directory

```text
mini-agent/
├── src/
│   ├── session-store.ts
│   ├── projector.ts
│   ├── loop.ts
│   ├── model-adapter.ts
│   ├── tool-registry.ts
│   ├── tools/
│   │   ├── read-file.ts
│   │   └── write-note.ts
│   ├── events.ts
│   └── cli.ts
├── test/
│   ├── loop.test.ts
│   ├── projection.test.ts
│   ├── tools.test.ts
│   └── branch.test.ts
├── DESIGN.md
└── package.json
```

The names can be different, but the boundaries should be as close as possible: session storage is not responsible for calling the model, model adaptation is not responsible for tool execution, and the interface is not responsible for deciding when the loop stops.

---

## 3. Define Five Core Objects First

### 3.1 Entry: A row in the session ledger

```ts
type Entry =
  | {
      type: "message";
      id: string;
      parentId: string | null;
      timestamp: number;
      role: "user" | "assistant" | "toolResult";
      content: unknown;
    }
  | {
      type: "compaction";
      id: string;
      parentId: string | null;
      timestamp: number;
      summary: string;
      firstKeptEntryId: string;
    };
```

The most important fields are not `content`, but:

- `id`: who this record is for;
- `parentId`: which record it follows;
- `type`: whether it is content, a summary, or some other state.

Appended only means: entries that have already been written are not modified or deleted. To change "what you currently see," you change the active leaf or projection rules, not the historical files.

### 3.2 SessionStore: Managing the tree and leaf

It must at least have these capabilities:

```ts
append(entryInput): Entry
setLeaf(id): void
getActivePath(): Entry[]
getChildren(id): Entry[]
save(): Promise<void>
load(): Promise<void>
```

`getActivePath()` Trace back from the current leaf along `parentId` all the way to the root, then reverse the order. It returns a continuous branch, not the entire tree.

### 3.3 Projector: Turning a branch into a model message

```ts
project(branch: Entry[]): ModelMessage[]
```

Its input is the active branch, and its output is the 'model-visible conversation history.' It does not write files or modify the original entry.

### 3.4 ModelAdapter: Unified Model Interface

```ts
interface ModelAdapter {
  stream(request: {
    messages: ModelMessage[];
    tools: ToolSpec[];
    signal: AbortSignal;
  }): AsyncIterable<ModelEvent>;
}
```

At least include:

```text
text_delta
toolcall_start
toolcall_delta
toolcall_end
done
error
```

Specific fields can be simplified, but the semantics must be retained: text increment, complete tool invocation, normal termination, error termination.

### 3.5 ToolRegistry: Unified entry point for tools

```ts
interface ToolDefinition {
  name: string;
  description: string;
  schema: unknown;
  execute(args: unknown, signal: AbortSignal): Promise<ToolResult>;
}
```

At least include:

```text
content     Text/images for the model to view
Whether failed
details     Data for the interface or debugging
```

The tool registry is responsible for:

- Finding tools by name;
- Validating parameters;
- Calling permission hooks;
- Executing;
- Truncating results;
- Generating tool result messages.

---

## 4. Implementation Order: Each Step Should Be Runnable

Do not follow the approach of 'finish all modules first, then integrate and debug.' Each step should have a verifiable minimal loop.

### Milestone 1: Dummy Model – Minimal Loop

Do not connect to the real model yet; write a scripted dummy model:

```text
First call: returns 'Hello'
```

The loop only needs to:

1. Append the user message;
2. Call the model;
3. Append the assistant message;
4. End.

Acceptance: One input should produce a definite output, and emit `agent_start` / `agent_end`.

### Milestone 2: Model Streaming Events

Change the mock model to generate in chunks:

```text
"you"
text_delta("good")
done (full message)
```

Acceptance: The CLI can display text in real time, and the final message is based on the complete content in `done`.

### Milestone 3: Tool Invocation   Backfill

Have the fake model return a tool invocation in its second response:

```json
{
  "name": "read_file",
  "arguments": { "path": "README.md" }
}
```

The loop should:

1. Find the tool;
2. Validate parameters;
3. Execute;
4. Generate `toolResult`;
5. Then request the model.

Acceptance: The tool's results indeed appear in the next request, and the loop can provide a final answer based on them.

### Milestone 4: Conversation Tree and Branches

Replace the memory message array with `SessionStore`:

- Each message has `id` / `parentId`;
- The current leaf determines the active branch;
- When continuing from an old node, append a new child rather than overwrite the old subsequent nodes.

Acceptance experiment:

```text
m1 user
  └─ m2 Assistant
      ├─ a3 User → a4 Assistant (Branch A)
      └─ b3 User → b4 Assistant (Branch B)
```

Switch back to `m2`, then send a new message, you should get branch B; branch A is still in the file, but will not enter B's projection.

### Milestone 5: Projection

Implementation:

```ts
project(branch) =>
  branch
    .filter(isModelVisible)
    .map(toModelMessage)
```

Acceptance:

- Only include active branches;
- Do not include other branches;
- Do not turn non-content entries like `label`, `usage` into messages;
- Output order should be consistent from root to leaf.

### Milestone 6: Compression

Manually trigger a compression once first:

```text
Activity Branches: m1 ... m8
Compression result: append c1
Keep the original text starting from m6
```

Projection rules:

```text
Model-visible conversation history =
  c1.summary
  + m6, m7, m8
  New messages after compression
```

If it is resent after compression `m9`:

```text
Conversation tree: m1 ... m8 → c1 → m9
Projection:  [c1 Summary] + m6 + m7 + m8 + m9
```

Note:

- `m1...m8` The original text is still in the tree;
- `c1` It is a new compressed entry, not a deletion or overwrite;
- `firstKeptEntryId` Determines from where to retain the original text;
- The projection is calculated temporarily and is not saved separately to disk.

Acceptance:

- The number of tokens decreases before and after compression;
- The summary enters the context;
- The original entry can still be read;
- It is still possible to branch from old nodes before the compression point.

### Milestone 7: Two Real Tools

Recommendations:

1. `read_file(path)`: Read-only, restricted to the working directory;
2. `write_note(path, text)`: Has side effects, writes a small text file.

The two tools must reflect different risks:

| Tool | Validation | Risk Control |
| --- | --- | --- |
| `read_file` | Path exists, is a file, size limit | Prevent directory traversal; truncate large files |
| `write_note` | Path is valid, content size limit | Serial writes to the same file; explicit overwrite behavior |

Acceptance:

- Parameter errors return `isError`, loops do not crash;
- Large files are truncated and the model is informed how to continue;
- The write tool does not pretend success if it fails;
- Two write operations in the same assistant message do not overwrite each other.

### Milestone 8: CLI and JSON Events

Minimal CLI:

```text
mini-agent 'read README and summarize'
mini-agent --json "read README and summarize" > events.jsonl
```

An event must have at least:

```text
run_start
turn_start
text_delta
tool_start
tool_end
message_end
run_end
run_settled
```

These are simplified event names of the mini agent itself, used to practice structure; they roughly correspond to Pi's `agent_start`, `turn_start`, `agent_end`, `agent_settled`, but do not confuse these names with Pi's actual events.

`--json` mode rules:

- stdout outputs only JSONL;
- logs write to stderr;
- each record is one line;
- final state see `run_settled`.

### Milestone 9: Testing and Design Documentation

Cover with fake models:

- plain text response;
- a single tool call;
- tool parameter error;
- tool execution failure;
- multiple tools in parallel/series;
- abortion;
- branch switching;
- compressed projection;
- event order.

Finally write `DESIGN.md`, see next section.

---

## 5. How Loops Should Be Written

Expressed in pseudocode; core logic simplified compared to Pi, but structure should be consistent:

```ts
async function run() {
  emit("run_start");
  store.append(userMessage);

  try {
    while (true) {
      emit("turn_start");

      const branch = store.getActivePath();
      const messages = project(branch);
      const assistant = await callModel(messages, tools, signal);

      store.append(assistant.message);
      emitMessage(assistant.message);

      const calls = assistant.message.toolCalls;
      if (calls.length === 0) {
        break;
      }

      const results = await executeToolCalls(calls);
      for (const result of results) {
        store.append(result);
        emitMessage(result);
      }
    }
  } finally {
    emit("run_end");
    emit("run_settled");
  }
}
```

This pseudocode omits retrying, steering, follow-up, and compression triggers, but already reflects three key points:

1. **Re-project in each round** instead of maintaining a continuously appended global message array;
2. **Tool results are first written to the session before proceeding to the next round**;
3. **The loop naturally ends only when there are no tool calls**.

### 5.1 Adding Abort

Pass `AbortSignal` to both model requests and tool executions:

```text
User presses Ctrl C
  → abortController.abort()
  Model stream stopped
  The running tool has received a cancellation signal
  The loop ends with aborted
```

Aborting is not "just throwing the Promise away," but rather giving network requests, subprocesses, and event listeners a chance to clean up.

### 5.2 Adding steering / follow-up (optional advanced)

First, implement the two simplest queues:

- steering: inserted after the current assistant turn ends, to affect the next step as soon as possible;
- follow-up: start a new round only after the current work is completed.

If you can't implement it, it doesn't affect graduation; but you should be able to explain why they cannot be treated exactly like ordinary user messages.

---

## Six, Four Sentences You Must Clearly Explain About Projection and Compression

This is the easiest part to get confused in the whole course. The mini agent must implement it properly:

1. **The session tree is a complete ledger.** All branches, original text, summaries, and tool results are in it.
2. **An active branch is a continuous path.** From the root to the current leaf, follow only the `parentId` links.
3. **Compression means adding a summary entry to the tree.** It does not delete the original text.
4. **Projection is the conversation history visible to the model, calculated temporarily for each request.** Summaries are only one input for projection; projection is not another tree.

Here, "projection" only concerns the conversation history; the full context also includes system prompts, tool declarations, current mode, etc., which are assembled together outside of projection.

To conclude, here is an example:

```text
Original branches: m1 m2 m3 m4 m5 m6 m7 m8
After compression: m1 ... m8 → c1 → m9

Projection = summary of c1 +  from firstKeptEntryId retaining the original text + m9
```

If another branch splits from `m2`:

```text
m1 → m2 → m3 ... m8 → c1 → m9    (branch A)
        └→ b3 → b4 (branch B)
```

When choosing branch B, the projection only goes through `m1 → m2 → b3 → b4` and does not include `c1` and `m9` from branch A.

This is also why 'going back to an old message to continue sending' generates another continuous branch instead of overwriting the original conversation.

---

## 7. Minimal Safe Version of the Tool Pipeline

The mini agent does not need to replicate all of Pi's security mechanisms, but it should at least have:

```text
① Parameter schema validation
② Working Directory Boundary Check
③ Dangerous action confirmation or interception
④ Large Output Clipping
⑤ Error result backfill
⑥ Write operation serialization
```

### 7.1 Parameter Validation

Use TypeBox, Zod, or JSON Schema. When validation fails:

```text
Do not execute → to generate isError results → and let the model correct
```

### 7.2 Path Boundaries

At a minimum, do:

```ts
const absolute = resolve(cwd, inputPath);
if (!absolute.startsWith(cwd + sep)) {
  throw new Error("Path escapes workspace");
}
```

Real products still need to handle details like symbolic links, case sensitivity, and Windows drives; for a graduation project, you only need to clarify the existence of boundaries.

### 7.3 Truncation

You can reuse Pi's approach:

- Dual limits on number of lines and bytes;
- Keep the beginning or the end;
- Write the complete result to a temporary file;
- Tell the model the full path in the result.

### 7.4 Side Effects

When writing a tool, you need to clarify:

- Whether it overwrites or appends;
- Whether a partial file is left on failure;
- Whether a temporary file is needed for atomic replacement;
- How to serialize concurrent writes to the same path.

---

## 8. Minimum Version of Model Adapter

Do not support all vendors from the beginning. Just choose a protocol that you can actually call.

### 8.1 Four types of input that must be handled

```text
Plain Text Increment
Tool invocation started
Tool Parameter JSON Increment
Completed / Error / Aborted
```

### 8.2 Four Boundaries That Must Be Handled

- Tool parameters may arrive in fragments and must be fully received before parsing;
- The model may only return text without calling tools;
- The model may continue to output text after calling tools;
- The stream may fail halfway or be aborted by the user.

### 8.3 Do Not Swallow Errors

The adapter should convert errors into a unified event so that the loop knows:

```text
Is it a network error that can be retried?
Is it authentication failure?
Is it context overflow?
Did the user actively stop it?
```

If all errors are wrapped as "model response is empty," debugging becomes very difficult.

### 8.4 Testing adapters does not require hitting the network every time

You can record a valid SSE sample and feed it to the parsing function to verify:

- Incremental text concatenation;
- Tool parameter concatenation;
- Final message after `done`;
- Stop reason for `error`;
- Abort signals.

The real network is only used for minimal smoke testing.

---

## 9. Test Plan: Verifying an uncertain system in a deterministic way

### 9.1 Fake model script

Arrange precise model response sequences for each test:

```text
Test 1: A text → expects 1 turn
Test 2: Text → Tool Call → Final Text → Expect 2 turns
Test 3: Tool parameter error → Model correction → Final text
Test 4: Tool throws error → Error result → Loop continues
Test 5: abort → tool stopped → run_settled(aborted)
```

### 9.2 Session Testing

- After forking from the old node, both branches exist;
- After switching the leaf, the projection only contains the active branch;
- The original text is still readable after compression;
- The projection does not modify entry;
- The tree structure is consistent after reloading the file.

### 9.3 Event Testing

Do not only look at the final text, assert:

```text
run_start → turn_start → message_end → tool_start → tool_end → turn_start → run_end → run_settled
```

At a minimum, check:

- The order before and after tool calls;
- Whether the tool results appear only once;
- Whether there are any unexpected subsequent turns after termination;
- Whether errors are correctly flagged.

### 9.4 Test Isolation

- Use a temporary directory as the workspace;
- Do not read real user configurations;
- Do not access real models;
- Clean up temporary files after the test;
- Do not write test-generated sessions to real directories.

---

## Ten, Six Questions the Design Document Must Answer

`DESIGN.md` It doesn't need to be long, but be specific:

1. **How are the seven blocks divided?** One sentence for each block's responsibility and one line for call relationships.
2. **How does a single request flow?** From input to final output, draw a sequence diagram.
3. **Why use a tree?** How do returning old messages, branching, compression, and auditing each benefit.
4. **What is the relationship between compression and projection?** Use a small example to show summary, original text, and active branches.
5. **Where is the trust boundary of the tools?** Which actions are read-only, which have side effects, and what happens on failure.
6. **Why test this way?** Which parts use fake models, which must be real integrations, and why.

Then write three trade-offs:

```text
Trade-off 1: Why not delete the original text, but add a summary instead?
Trade-offs 2: Why should the tool results be truncated?
Trade-off 3: Why does the interface observe events instead of directly reading the internal state of the loop?
```

Each trade-off should be written as 'Problem → Example → Solution → Cost'; do not just write the conclusion.

---

## 11. Final Acceptance: Explain Clearly Without Looking at Pi Source Code

### 11.1 Ten-Minute Whiteboard Explanation

Close all documents and draw:

```text
Input
  → Conversation Tree / Activity Branch
  Projection
  Model Adaptation
  Utility Pipeline
  → Event
  Next Round / End
```

Draw and Explain:

1. Why the model doesn't remember things, and how the system makes it appear continuous;
2. Why going back to old messages creates a new branch instead of overwriting;
3. Why compression appends a summary instead of deleting the original text;
4. Why projection isn't of the entire tree;
5. Why tool invocation is "propose → verify → execute → backfill";
6. Why the model access layer can keep different vendors outside the loop;
7. Why events are the shared interface between the UI and external programs;
8. Why the model is uncertain, yet testing can still be deterministic.

### 11.2 Five-Minute Q&A

Let others ask randomly:

- What if two tools write to a file at the same time?
- What if the compression summary is wrong?
- What if the tool output is too large?
- What if the model keeps calling the same tool?
- What if the user presses stop midway?
- If the system prompt is changed, will history change?
- If a new session starts, is it a new branch of the same tree?

You need to distinguish:

| Action | Result |
| --- | --- |
| Continue from an old message | Add a new branch in the same session file |
| `/new` or new session | New file, new tree |
| fork / clone | Copy history to a new tree, then evolve independently |

### 11.3 The Real Graduation Criteria

It's not enough that "the code runs"; it must also:

- [ ] Run;
- [ ] Stop;
- [ ] Resume;
- [ ] Branch;
- [ ] Compress but keep the original text;
- [ ] Safely execute two tools;
- [ ] Observe the full process from JSON events;
- [ ] Test stably with a fake model;
- [ ] Explain why each design exists;
- [ ] Identify at least three limitations and next steps.

### 11.4 Final Self-Test

If someone takes all Pi source code, leaving only your blank paper and mini agent, can you explain in 15 minutes:

> How a user message becomes a model request; how the model affects the real world; how results come back; how the system knows to stop; how history branches, compresses, and resumes; why these parts are separated?

If you can, it shows you understand the Agent system, not just memorized a repository.

---

## Twelve. After Finishing: Where to Go Next

Optional advanced steps, don't do everything at once:

1. **Extend hooks**: Add `beforeToolCall`, `afterToolCall` to let external code intercept tools;
2. **Skills / prompt templates**: Extract repetitive processes from code;
3. **MCP**: Connect to an existing external tool service;
4. **Multiple providers**: Add a second model adapter to verify the interface is truly neutral;
5. **Better TUI**: Learn differential rendering and input handling;
6. **Observability**: Record tokens, tool time, failure rate, and compression counts;
7. **Persistent runtime**: Recover after crashes, task queue and recovery strategies;
8. **Evaluation**: Compare different models and prompts with a fixed set of tasks.

But no matter how much you expand, always maintain the main storyline:

```text
The ledger records facts
  Activity branch provides history
  → Projection determines what the model sees
  Loop-driven action
  Tools change the world
  → incident let outsiders see
```

This is the endpoint of this course, and also the starting point for any future Agent projects.

---

*Supporting [learning path](../learning-path/) Stage 9 · Based on v1.3.0 (`71023aec`)*
