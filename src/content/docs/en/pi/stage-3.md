---
title: "Stage 3: Context and Conversation Tree"
description: "From conversation trees to context compression, understanding the memory boundaries of an Agent."
---

> **Position of this stage**: Stage 2 already knows that the context must be "reconstructed" in each iteration of the loop. Now answer: where does the context come from, where is it stored, and what exactly is the relationship between compression and projection.
> **Source code directory**: `$PI_SRC`. Core files: `packages/coding-agent/src/core/session-manager.ts`, `src/core/compaction/compaction.ts`, `src/core/system-prompt.ts`, `src/core/resource-loader.ts`.
> **Official materials**: Sections on Context and Sessions in `packages/coding-agent/docs/session-format.md`, `compaction.md`, `sessions.md`, `how-pi-works.md`.

## 1. First, remember a main thread

Stage 2 says "the model request is stateless," which raises a question: if the model doesn't remember, what exactly does Pi send to it each time?

The answer is not "send the entire session file," but:

```text
Session File (Full Ledger)
  Current active branch (a continuous path)
  → Apply the latest compression and context editing
  Projection (dialog history visible to the model)
  → convertToLlm (internal format → model format)
  → Request Model
```

There are four easily confused concepts in this line:

| Concept | What it is | Persisted | Function |
| --- | --- | --- | --- |
| Session Tree | The complete record composed of all entries | Yes | Stores facts, supports backtracking, branching, and recovery |
| Compression | Summarizes old history into a summary and appends a record | Yes | Reduces tokens while retaining key information |
| Projection | Model-visible conversation history calculated from the active branch according to rules | No | Determines what conversation content the model sees this time |
| Context | All content actually sent to the model in this request | No | The content the model actually reads |

**Compression is not projection, and projection is not the compressed tree.** Compression is a summary record in the tree; projection is a temporarily generated view of the conversation history for each request, with the summary being just one part of the input.

---

## 2. Why use a tree instead of a linear chat record?

A linear chat record can only represent "what has happened." But in real work, one often needs to:

- Go back to old messages and try a different approach;
- Keep the original attempts for comparison;
- Compress old history without deleting the original text;
- Copy a work from some intermediate state.

A tree structure satisfies all of these needs.

### 2.1 Entry: the "row" in a session file

Session files are JSONL: each line is a JSON object. Common fields are:

- `id`: Identifier of this record;
- `parentId`: Which was the previous record;
- `timestamp`: Time.

The first line of the file is the session header and does not belong to the tree:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2026-10-19T...","cwd":"D:\\..."}
```

Tracing back from the current node along `parentId` all the way to the root is the **active branch**. The current position is called a **leaf**.

### 2.2 A tree can have multiple continuous branches

The tree looks branched, but each branch itself is continuous:

```text
Root
└─ m1 user
   └─ m2 Assistant
      ├─ m3 user → m4 assistant ← branch A
      └─ m5 user → m6 assistant ← branch B
```

`m2` is an old node shared by two branches. When you go back to `m2` and send a new message, Pi does not overwrite the original `m3`; instead, it appends a new entry with `m2` as the parent node. As a result, both paths coexist in the same session file.

**In one sentence**: A tree is a 'collection of multiple consecutive branches,' not 'a way to chop up a conversation.'

The 'branch' here does not mean cutting the conversation into segments, but adding new children to the same old node. Branches A and B share the first half from the root to `m2`, and extend separately in the second half; selecting a leaf will only read along the path from that leaf to the root. So each branch itself remains a continuous conversation from root to the current message.

When switching branches, Pi can also generate a `branch_summary`: it summarizes the key points after the split from the branch you just left and appends it to the new branch. This way, the new branch can know 'what the other path did,' but the original text of the old branch will not directly enter the projection of the new branch.

---

## 3. What exactly is in a session file?

Pi's entries are not just messages. Understanding 'what goes into the model context' is more important than memorizing field names.

| Type | Purpose | Goes into model context? |
| --- | --- | --- |
| `message` | User, assistant, tool results, or system messages | Yes |
| `compaction` | Compressed summaries and system checkpoints | Yes, replacing the old messages that were summarized |
| `context_edit` | Appended modifications to an old entry | No, but it will change the projection result of the target |
| `branch_summary` | Key points retained when switching branches | Yes |
| `custom_message` | Injected expansion messages | Yes |
| `model_change` | Model switch records | No, but affects future requests |
| `thinking_level_change` | Thought-level records | No, but affects future requests |
| `usage` | Usage and cost records | No |
| `custom` | Extended state data | No |
| `label` | Bookmarks/markers | No |
| `session_info` | Session name and other information | No |

They can be divided into three categories:

1. **Content**: `message`, `compaction`, `branch_summary`, `custom_message`;
2. **State**: `model_change`, `thinking_level_change`, `usage`, `session_info`;
3. **Modification/Marker**: `context_edit`, `label`, `custom`.

### 3.1 Practical test: Drawing the session file as a tree

```powershell
$dir = Get-ChildItem "$HOME\.pi\agent\sessions" -Directory |
  Where-Object Name -like "*pi-1.3.0*" |
  Select-Object -First 1

$file = Get-ChildItem $dir.FullName -Filter *.jsonl |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

$file.FullName

Get-Content $file.FullName | ForEach-Object {
  $j = $_ | ConvertFrom-Json
  $parent = if ($null -ne $j.parentId) { $j.parentId } else { "----" }
  "{0,-9} {1,-22} {2}" -f $j.id, $j.type, $parent
}
```

You don't need to immediately understand every entry. First, observe: messages are linked together with `parentId`, while `compaction`, `context_edit`, etc., are recorded in between.

---

## 4. From Conversation Tree to Model Context: Four-Step Deduction

This section is the core of Stage 3. The source code corresponds to four levels in `session-manager.ts`.

### Step 1: Find the Active Branch

`buildSessionPath()` traces back from the current leaf along `parentId` to the root, obtaining a continuous path.

This path defines the scope for all subsequent deductions. **Other branches, even if still in the file, will not be read.**

### Step 2: Apply the Latest Compression

`buildContextEntries()` processes compressed records along the active branch. The rules can be simplified as:

- There may be multiple compressions on the branch, but only the latest one is effective;
- Old entries before the latest compression and outside the retention scope are replaced by summaries;
- Original text is preserved starting from `firstKeptEntryId`;
- Entries after compression continue as is;
- Status records like `label`, `usage`, etc., can remain in the list, but will not be transformed into model messages during projection.

You can think of compressed entries as a card:

```text
c1: "Summary of m1~m5"
    firstKeptEntryId = m6
```

So the path:

```text
m1 → m2 → ... → m8 → c1 → m9 → m10
```

It will be read as during projection:

```text
[c1 summary] + m6 + m7 + m8 + m9 + m10
```

The original m1~m5 entries are still in the conversation tree, but they no longer enter the conversation history of this request; m6~m8, since they fall within the reserved range, still appear in their original text.

### Step 3: Apply Context Edits

`context_edit` is an additive patch to the old entry:

- `targetId` points to the modified entry;
- `replacement` is the new content;
- `replacement: null` indicates omission from the current context;
- For the same target, the latest edit on the active branch prevails;
- The original entry remains unchanged; only the projection result changes.

Normal chat rarely produces `context_edit`, which is more used for overflow recovery compression, expansion, and fine-grained context management in the SDK. But it is the purest embodiment of the "projection" concept: **the original record stays the same, while the view changes according to rules.**

### Step 4: Convert Entries into Messages

`buildSessionProjection()` and subsequent conversions divide entries into different results:

| entry | projection result |
| --- | --- |
| `message` | becomes an internal message as is |
| `compaction` | system checkpoint summary message |
| `branch_summary` | branch summary message |
| `custom_message` | custom message |
| others | usually do not produce model messages |

Finally, `AgentMessage[]` is obtained, and then transformed via `convertToLlm` into `Message[]` that the provider can accept.

### 4.1 Complete Example

Assume the active branch is:

```text
m1 User: Refactor utils.ts
m2 Assistant: First read the file + read call
m3 tool result: file content
m4 Assistant: Start modifying + edit call
m5 tool result: modified
m6 Assistant: Refactoring completed
m7 user: Continue, and also organize the types
m8 Assistant: Okay
c1 Compression: summary m1~m5, firstKeptEntryId = m6
m9 user: Which files were just modified?
m10 Assistant: Mainly changed utils.ts...
```

The projection for the next request is roughly:

```text
[c1 summary] + m6 + m7 + m8 + m9 + m10
```

Not:

```text
m1 + m2 + ... + m10
```

Not really:

```text
[c1 summary] + [another projected payload]
```

The correct understanding is: **The summary itself is an item within the projection; the projection is responsible for generating the entire model-visible conversation history, and other parts such as system prompts, tool declarations, etc., together with it, form the complete context.**

---

## 5. What exactly does compression do?

### 5.1 Why compression is needed

The context window is limited, and the longer the history:

- The requests are slower;
- Costs are higher;
- Irrelevant information increases, making the model more prone to noise interference;
- Truly important recent content may be pushed out.

The goal of compression is not to "delete history" but to **retain sufficient task information with fewer tokens**.

### 5.2 When it is triggered

- Automatically triggered when the context approaches the model's limit;
- Manually executed `/compact`;
- Retry after compression when a request fails due to context overflow;
- Triggered to restore when some outputs are cut off due to length.

### 5.3 Does compressed content enter the context?

Yes, but three things need to be distinguished (here referring to the conversation history part within the projection):

- **Summary**: will enter subsequent projections;
- **Original messages retained after the compression point**: will enter subsequent projections;
- **Original messages covered by the summary**: no longer enter the conversation history in subsequent projections, but remain in the conversation tree.

Expressed in formula:

```text
Model-visible conversation history = latest compressed summary
             Original message retained after compression
             Messages added later
             Necessary system checkpoint
```

If it has never been compressed, there is no summary and the content on the active branch is used directly. 

### 5.4 Why doesn't compression directly delete old messages?

Because the conversation tree is not the "current context," but the "complete fact ledger." Keeping the original text conveys: 

- Backtracking: The original text can still be seen before returning to the compression point; 
- Branchable: Retrace a route from the old node; 
- Auditable: Know exactly what was said at the time; 
- Restorable: Raw material remains when compression errors occur. 

This is also why Pi uses "compression" as an addend, rather than overwriting the file. 

--- 

## 6. System Prompts, Context Files, and Skills

The model context is not just conversational messages, but also system prompts and tool declarations. 

### 6.1 What are the components of a system prompt?

Pi's system prompts usually consist of multiple sections, for example: 

- Basic behavioral instructions; 
- Tool description; 
- Project rules; 
- Documentation/Additional notes; 
- Context files; 
- Skill description; 
- Current work directory, etc. 

The specific section names and spelling rules are listed in `system-prompt.ts`, but the first reading only requires understanding: **The system prompt is the "work manual" for each round of requests**, not visible chat content for users. 

### 6.2 Context File

Context files like `AGENTS.md` in the project enter part of the system prompt. They let the model know the rules, commands, and conventions of the repository. 

Note: The context file is not a "permanent memory," but part of the system prompt for each reassembly request. 

### 6.3 Why are skills too lazy to load?

There may be many skills, and each skill's full description is quite lengthy. If you put all of them into the system prompt: 

- Occupying a large number of tokens; 
- Most skills are currently unnecessary; 
- The model is interfered with by irrelevant instructions. 

So Pi usually only lists skill names and descriptions in system prompts; Only when truly needed does the full skill description load. This is called "on-demand loading." 

--- 

## 7. Branches, Forks, and Clones: Don't Confuse "New Sessions" with "New Branches."

| Operation | Result | File |
| --- | --- | --- |
| `/tree` Return to old message and continue | New branches grow in the same session | Unchanged |
| `/new` | Brand new sessions | New files, new trees |
| `/fork` | Create a new session from an old message | New file, new tree, record source |
| `/clone` | Copy the current active branch as a new session | New file, new tree |

`/fork` and `/clone` copy historical content; after copying, the two sessions evolve independently and do not synchronize with each other. 

--- 

## 8. Common Misconceptions

| Misconceptions | Correct understanding |
| --- | --- |
| The session file is the model context | The model only reads the dialogue history projected by the active branch, not the full file |
| Compression will delete old messages | Do not delete; Only add summary records, the original text remains |
| Projection is the process of converting the entire tree into a message | Projection is based only on the current active branch and applies compression/editing |
| The compressed summary and the projection are two separate entities | The summary is part of the projection |
| A session has only one branch | The same file can have multiple branches |
| A new session is a new branch from the same tree | A new session is a new file, a new tree; A branch is only within the same file |
| The full skill text is always in the system prompt | Usually, only the description is included, and the full content is loaded as needed |

--- 

## 9. Self-inspection during customs clearance

Please skip reading the documentation and complete the following three tasks: 

1. From an active branch containing 8 messages, 1 compressed record, and 1 edit record, derive the message list for the next request; 
2. Explain why "the compressed summary is already in context" and "projection is the historical part of the context" are not contradictory; 
3. Open a real session file, draw its `id`/`parentId` chain, and indicate the current leaf. 

Recommended outputs: 

- [ ] A graph of "Session Tree → Active Branch → Projection → Model Message"; 
- [ ] A pre- and post-compression context comparison table; 
- [ ] A paragraph explaining the differences between "tree, compression, projection, and context"; 
- [ ] A tree record of a real session file. 

The next stop is Stage 4: The tool description in context is just a "manual." After the model actually calls the tool, how does Pi verify, execute, truncate, and safely backfill? See [Stage 4](../stage-4/). 

--- 

*Supporting [Learning Route](../learning-path/) Stage 3 · Based on v1.3.0 (`71023aec`)*
