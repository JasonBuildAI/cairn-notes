---
title: "Stage 8: Engineering and Trusted Delivery"
description: "Testing, release, rollback, and security boundaries: making uncertain Agents trustworthy."
---

> **Position of this stage**: The first seven stages address "how the system works." This stage addresses "after making changes, how to know nothing is broken and still dare to continue making changes in the future."  
> **Source code directories**: `$PI_SRC`. Core materials: root directories `AGENTS.md`, `CONTRIBUTING.md`, `test.sh`, `package.json`, `scripts/`, `.husky/pre-commit`.  
> **One-sentence main line**: **Model outputs can be uncertain, but testing, boundaries, and release processes must be as certain as possible.**

## 1. Why engineering the Agent project is more difficult

Ordinary functions are easy to test:

```text
Input 2 + 3 → The output must be 5
```

Agents are different:

- The wording of the model may vary each time;
- The same question may take different tool paths;
- Network, rate limiting, and context length can change results;
- Tools may modify real files;
- A result that "looks correct" might not have actually executed the necessary steps internally.

So, you cannot just test whether "the final text looks right." A more reliable approach is to test **structure and invariants**:

- Did the tool call happen?
- Were the parameters validated?
- Did the tool results return to the session?
- Is the event sequence correct?
- Did it abort correctly on failure?
- Was the original text preserved after compression?
- After branch switching, is the active path correct?

The core at this stage is not memorizing commands, but establishing an engineering judgment:

> **Which parts can be tested with complete certainty, and which parts require a small amount of real integration verification?**

---

## 2. Read the two "contracts" first

### 2.1 `AGENTS.md`: Operation Manual

It mainly tells developers and Agents:

- Code style and TypeScript constraints;
- What checks to run after modification;
- Which commands should not be run casually;
- Tests must use a fake provider;
- What Git operations are off-limits;
- How to write the changelog;
- How to handle dependencies and the lockfile.

This document is not just background information but a behavioral contract for development within the repository. When using the Agent to modify Pi, it should work in the repository root directory to automatically read these rules.

### 2.2 `CONTRIBUTING.md`: External Contribution Threshold

It emphasizes:

- **core is minimal**: Features outside the core should preferably be made as extensions;
- **You must understand your own code**: You can write with AI, but PRs with unexplained code will be closed;
- New contributors' issues/PRs have automatic closing and manual review mechanisms;
- PRs must pass `npm run check` and `./test.sh` before submission;
- Do not modify `CHANGELOG.md` in upstream PRs; maintainers handle them centrally.

The common point of the two documents:

> Engineering is not about "running a few more commands," but about making it clear to others why your change exists, what it affects, and how to verify it.

---

## 3. Testing Pyramid: Do not use the real model for everything

### 3.1 Three levels

```text
        e2e / real provider
       Less, slow, expensive, affected by the internet
              ▲
        Integration test: loop + session + faux provider
        Fast, stable, able to cover the entire request chain
              ▲
        Unit Testing: Pure Functions and Local Modules
        Most, fastest, easiest to locate
```

### 3.2 Unit Testing

Suitable for testing:

- The behavior of truncation functions under different row and column limits;
- Path parsing and permission checks;
- Message conversion;
- Tree branch backtracking;
- Parameter schema;
- Cost calculation.

These tests do not require a model and should not access the network.

### 3.3 Integration Testing

Suitable for testing:

- A complete flow of "user message → model tool call → tool result → next round → final answer";
- Event sequences;
- Session writing and recovery;
- Compressed projection;
- Abort and retry;
- Interception of extension hooks.

Integration tests run real loops and sessions, but **the model is fake**.

### 3.4 E2E / Real Model Testing

Real models are only suitable for limited validation:

- Whether a certain provider's request format still works;
- Whether streaming parsing is compatible with the real service;
- Whether authentication and endpoints are available.

They are not suitable as regression assurance for most logic because:

- Costly;
- Dependent on the network;
- Output is uncertain;
- Failures may come from the model service, not your code.

---

## 4. Faux Provider: Why There Are "Fake Models" Everywhere in Tests

### 4.1 What It Solves

A faux provider is an in-memory fake model. Tests can pre-arrange it to return sequentially:

```text
Article 1: A paragraph of text
Article 2: A tool invocation
Article 3: Final Answer Based on Tool Results
```

Thus, the test can definitively verify:

- Whether the loop sent a second request;
- Whether the tool parameters are correct;
- Whether the result proceeds to the next round;
- Whether it stops in the end;
- Whether the event sequence matches expectations.

It has no network, no cost, and won't change the path because the model's "mood" is different today.

### 4.2 Why you can't just use a mock to replace `prompt()`

If you directly mock the entire session, you can only prove that "mock was called," but you can't test:

- The real loop;
- The real projection;
- The real tool pipeline;
- The real event sequence;
- The real session writes.

The advantage of a faux provider is that it only replaces the "model service" layer; everything else is real.

### 4.3 What to assert when testing an Agent

Prioritize asserting:

- State changes;
- Event sequences;
- Tool call counts and parameters;
- Session tree structure;
- Whether error results appear;
- Whether it ultimately `agent_settled`.

Do not prioritize asserting:

- Complete natural language sentences;
- How the model "should phrase" something;
- Any unstable timing numbers.

Tone and wording can be evaluated manually, but should not become fragile unit tests.

---

## 5. Why running the full vitest directly is dangerous

The repository contains both regular tests and e2e tests. e2e may actually call the model when detecting endpoint/auth environment variables.

This means:

```text
You happen to have API Key on your machine
  Some e2e tests are activated in full-scale testing
  → Really send a request
  Spending money, relying on the internet, results are unstable
```

So the correct entry point is not to casually `npx vitest`, but rather:

- Non e2e full run: execute `./test.sh` at the root of the repository;
- Single test: run the specified test file from the root directory of the corresponding package;
- Modified test file: you must run it and iterate until it passes.

### 5.1 What `test.sh` does

It does not simply execute `npm test`, but first creates an isolated world:

- Temporary HOME;
- Temporary TMP;
- Independent npm configuration and cache;
- Does not read the real global Git configuration;
- Disables interactive credential prompts;
- Only inherits essential environment variables from the platform.

This way, tests will not pollute your real:

- `~/.pi` settings;
- Login credentials;
- Session files;
- npm cache.

After the tests are finished, the script only deletes the temporary directories it has marked, with defensive path checks.

### 5.2 How to run on Windows

`test.sh` is a Bash script. Running it directly in PowerShell will not work; Git Bash should be used.

```bash
cd $PI_SRC
./test.sh
```

This step might be relatively slow and is suitable to run when preparing to submit or making major changes.

---

## 6. `npm run check`: Eight Automatic Checks

According to `package.json`'s `check`, eight types of checks are performed in sequence:

| Checkpoint | What it prevents | Explanation in plain language |
| --- | --- | --- |
| Biome | Formatting, linting, and auto-fixable issues | Inconsistent code style, obvious errors |
| pinned deps | Direct dependency version drift | Installing today and tomorrow results in different versions |
| runtime deps | Missing runtime dependency declarations | Works locally but breaks after release |
| TS imports | Broken relative import conventions | Build output paths get messed up |
| entry graphs | Abnormal entry size and dependency graph | Bundle keeps getting bigger or includes unwanted dependencies |
| install lock | Installation lock inconsistent with build scripts | Users get different dependencies during install |
| TypeScript | Type errors | Interface mismatches, wrong field usage |
| browser smoke | Basic browser environment operability | Some packages break when bundled for the browser |

Some easy-to-slip details:

- Biome **writes files**, so you need to check `git status` after running it;
- Warnings/info cannot be ignored; the repository requires a clean state;
- Documentation changes do not necessarily require code checks, but any code changes must follow the contract;
- Do not use `--no-verify` to bypass commit hooks.

### 6.1 Adding another layer with pre-commit

Pre-commit hooks will:

1. Check if the lockfile was modified unexpectedly;
2. Run `npm run check` again;
3. Perform additional browser smoke checks when relevant files change;
4. Re-add staged files modified by formatting back to the staging area.

In other words, passing `npm run check` does not mean you can submit freely; pre-commit will still enforce dependency and staging boundaries.

---

## 7. How to Make a "Small but Safe" Change

### 7.1 Reproduce first, then modify

Don't start by changing the implementation. First, leave a reproducible proof:

```text
What is the input?
What is expectation?
What is reality
What are the minimum reproduction conditions?
```

If it is a bug, it's best to first write a test that will fail. This way, after you make changes, you can prove that:

- The old code indeed fails;
- The new code indeed passes;
- Others won't accidentally revert it in the future.

### 7.2 Find the root cause, not just apply a superficial fix

For example:

```text
Phenomenon: The results of reading large files occasionally exceed the context
Surface patch: unified truncation before model request
The root cause may be: a certain tool did not use a unified truncation tool
```

Root cause fixes usually result in smaller long-term complexity. Surface patches may prevent errors today but allow other tools to continue missing issues.

### 7.3 Minimal Diff

A good small change generally includes:

- One root cause fix;
- A test that can catch the problem;
- Type or documentation updates if necessary;
- Changelog entries added according to the rules (if the repository requires).

Do not casually refactor unrelated code, and do not mix in hundreds of lines of noise from formatting in the fix.

### 7.4 Regression Tests Should Target Real Risks

If it is fixing a GitHub issue, the test should indicate the issue number. The test should ideally answer:

> If this fix is removed, will the test actually fail?

A "regression test" that does not fail is just decoration.

---

## 8. Git Hygiene: The Reality of Multiple People/Agents Working Simultaneously

The Pi repository's development rules explicitly assume: multiple agents may modify different files in the same working directory at the same time.

Therefore:

- Only commit files you have changed yourself;
- Use explicit paths `git add <path>`;
- Review before committing `git status`;
- Do not use `git add -A` / `git add .`;
- Do not use `git reset --hard`, `git clean -fd`, `git stash`;
- Do not `--no-verify`;
- Use the agreed format for commit messages: `fix(coding-agent): ...`.

These rules are not about being "overly fastidious". In a parallel working environment, a single `git add -A` could commit someone else's unfinished changes.

---

## 9. Release Boundaries: Why You Cannot Just Re-run Releases

During the learning phase, actual releases are not required, but you should understand why the release process is strict:

```text
Fixed dependencies and model directory
  Upgrade version
  → Update changelog
  Run check and test
  Build Artifacts
  Tag
  → CI Publish and Verify
```

A few key points:

- Published version paragraphs cannot be modified;
- Once a tag is released, the release script should not be run again to overwrite it;
- When CI fails, retry the failed job instead of redoing the entire release;
- The release artifact and source code version must match.

The ultimate goal of engineering is to make what "others receive" consistent with what "you have verified."

---

## 10. Practical Exercises

### Exercise 1: Explain Isolation Testing

Open `test.sh` and answer in your own words:

1. Why change HOME and TMP?
2. Why not let Git read the global configuration?
3. Why should the test directory have marker files?
4. If there is no isolation, what real data could the tests contaminate?

### Exercise 2: Go through eight checkpoints

Run:

```powershell
cd $PI_SRC
npm run check
```

Output for comparison, match each paragraph to the eight types of checks above. After the checks, run:

```powershell
git status
```

Check whether formatting has changed any files.

### Exercise 3: Read a Small Fix

Pick a small fix from the changelog of `[1.3.0]`, look at its diff, and answer:

- What is the issue?
- Where is the root cause?
- What tests were added?
- Does the change go beyond the scope of the problem?

### Exercise 4: Write a "Verification Plan"

You don't need to actually change the code; first, write a plan for a hypothetical requirement:

```text
Requirement: When the tool output exceeds the limit, the result must include the full output path.

Unit Test:
Integration Testing:
Required event assertions:
Reasons for not needing a real model:
How to reproduce when it fails:
```

Being able to write this plan is closer to real engineering ability than blindly running through a test.

---

## 11. Common Misunderstandings

| Misunderstanding | Correct Understanding |
| --- | --- |
| The model outputs different results each time, so Agents can't be tested | Test the structure, state, events, and invariants, not fixed wording |
| Using mocks for everything is fastest | Only mock the model layer; loops and sessions should still run for real |
| e2e is the most realistic, so it should be run a lot | e2e is slow, expensive, and affected by the network; it is only suitable for a small amount of compatibility verification |
| Full coverage testing is `npx vitest` | The repository has dedicated isolated entry points `./test.sh` |
| `npm run check` only checks types | It also handles format, dependencies, imports, entry graphs, and lock files |
| Commit hooks can be temporarily bypassed | `--no-verify` should not be used; if checks fail, fix the root cause |
| Small changes don't need testing | Without regression tests, small changes can easily come back unnoticed |
| Fixing a bug means a major refactor is necessary | First do the minimal root cause fix, then discuss refactoring separately |
| AI-generated code just needs to run | Contributors must be able to explain the code and its impact |

---

## 12. Self-Check for Passing

Please answer:

1. Why should Agent tests assert events and states instead of full natural language outputs?
2. What do unit, integration, and e2e tests each cover?
3. Why is a faux provider more valuable than mocking the entire `prompt()`?
4. What real risks does the isolation in `test.sh` address?
5. What do the eight checkpoints in `npm run check` each prevent?
6. Why can't we just run full vitest directly?
7. What parts does a proper small fix usually include?
8. Why can't `git add -A` be used in a multi-Agent workspace?

Suggested deliverables:

- [ ] A testing pyramid with two suitable test examples for each layer;
- [ ] A description of the isolated testing environment;
- [ ] A comparison table for the eight checkpoints in `npm run check`;
- [ ] A complete walkthrough record of "write failing tests first, then fix the root cause";
- [ ] A 3-minute explanation segment showing that "Even if the model is uncertain, engineering verification can still be certain." 

Next step is Stage 9: Reassemble the seven modules into your own mini-agent and use the ability to "explain without notes" as the final acceptance criterion.

---

*Supporting [learning path](../learning-path/) Stage 8 · based on v1.3.0 (`71023aec`)*
