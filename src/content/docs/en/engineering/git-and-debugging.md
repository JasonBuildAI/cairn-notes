---
title: "Git and Debugging"
description: "Understand commit graphs, branches, and remote collaboration, and use a chain of evidence to locate the real fault."
---

Git saves history and helps debug to find the cause. The two seem unrelated, yet they share the same fundamental capability: turning the current state into an observable, revertible, and comparable state. Without version control, it is hard to know 'which change introduced the problem'; without reproducible steps, it is also difficult to judge whether the problem has really been fixed.

## 1. Git saves snapshots as a graph

Git is not a sync drive that 'backs up files.' Its core objects are roughly divided into four categories:

| Object | What it represents |
| --- | --- |
| blob | The content of a file |
| tree | Directory structure, recording filenames, permissions, and corresponding blob/tree |
| commit | A complete snapshot, with parent commits, author, time, and commit message |
| tag | A named reference to an object, often used for release versions |

Commits are linked into a directed acyclic graph via parent pointers. Branches and `HEAD` are just references to commits, not copied folders.

```text
A ← B ← C ← D   main
        ↑
        └── E   feature
```

When `main` and `feature` each advance separately and then merge, a new merge commit is created, or the commits can be rearranged through rebasing. Understanding this diagram is necessary to know "whether code will be lost if a branch is deleted," "why commits are not on the mainline," and "what the difference is between merge and rebase."

## 2. Working Directory, Staging Area, Local Repository, and Remote

| Location | Meaning | Common Commands |
| --- | --- | --- |
| Working Directory | Current files on disk | `git diff` |
| Staging Area | Contents prepared for the next commit | `git add`, `git diff --staged` |
| Local Repository | Graph of committed commits | `git commit`, `git log` |
| Remote-tracking References | The state last fetched from the remote | `git fetch`, `git branch -vv` |

`git add` is not "uploading files," but putting the current content into the staging area. A file can have both staged and unstaged changes simultaneously. Commits only record the snapshot in the staging area, so it is important to check `git diff --staged` before committing.

```bash
git status
git diff
git add src/request.ts
git diff --staged
git commit -m "fix: handle request timeout"
```

A good commit message explains what was changed and why. Personal projects don't need to follow all the conventions of large teams, but should avoid descriptions like `update` and `fix bug` that cannot be searched later.

## 3. Branches, Merges, and Rebases

Creating a branch is just creating a new reference:

```bash
git switch -c feature/login
```

After completing the modifications, common integration methods include:

- **Merge**: Retain both histories and generate a merge commit. The history is accurate, but the graph can be more complex when there are many branches.
- **Rebase**: Reapply the commits of the current branch onto another base. The history is more linear, but it rewrites commit hashes.
- **Squash**: Combine multiple commits into one, suitable for keeping a single change for a feature.

Commits that have been shared with others should not be rebased or force-pushed casually. Rewriting history changes commit identities and can complicate collaborators' work based on the old history. Personal branches can tidy up history, but the public mainline should prioritize traceability.

### 3.1 Conflicts Are Not Git Breaking

Conflicts occur when both sides modify the same area, and Git cannot automatically determine the correct semantics. The resolution steps are not simply choosing "my version," but:

1. Consider the intentions and context of both sides.
2. Keep the changes needed from both.
3. Remove conflict markers.
4. Run formatting, type checks, and tests.
5. `git add` Mark as resolved, then complete the merge or rebase.

Conflict markers are as follows:

```text
<<<<<<< HEAD
current version
=======
incoming version
>>>>>>> feature
```

These markers should not remain in the final document. Just because the machine can automatically merge does not mean the semantics are necessarily correct; after resolving conflicts, revalidation is required.

## 4. View History and Restore

```bash
git log --oneline --graph --decorate --all
git show <commit>
git diff <old>..<new> -- path/to/file
git blame -L 20,40 path/to/file
```

`log` View the commit graph, `show` view a specific snapshot, `blame` see which commit last introduced each line. `blame` is for locating context, not for assigning blame; a line of code may just be a format adjustment, while the actual semantic change happened in an earlier commit.

### 4.1 reset, revert, and reflog

| Command | Function | Suitable Scenario |
| --- | --- | --- |
| `git revert <commit>` | Add a reverse commit | History that has already been shared |
| `git reset --soft` | Move the branch pointer, preserving the staging area | Reorganizing commits locally |
| `git reset --mixed` | Move the pointer, preserving the working directory | Re-selecting commit content |
| `git reset --hard` | Reset pointer, staging area, and working directory together | When you are sure you do not want to keep local changes |
| `git restore` | Restore files in the working directory or staging area | Undo uncommitted changes |

`revert` does not delete history, so it is safer for public branches. `reset --hard` will lose uncommitted content, so you must confirm before executing.

`git reflog` records `HEAD` and where branch references were last moved. If a branch is accidentally deleted or a wrong commit is reverted, you can often retrieve the old hash through reflog. It is a local recovery tool, not equivalent to a permanent backup; whether the object still exists depends on garbage collection and whether it has been pushed to the remote.

### 4.2 bisect: Let history help locate issues

When a problem was introduced in a version long ago, you can bisect the commits:

```bash
git bisect start
git bisect bad HEAD
git bisect good v1.4.0
# Mark after each test
git bisect good
git bisect bad
git bisect reset
```

Git halves the range each time and eventually points to the first suspicious commit. The premise is that the problem can be reliably determined, and there is no unworkable environment gap between the "good version" and the "bad version".

## 5. Remote is not automatically synchronized

`origin/main` is the locally saved "last seen remote main," not the real-time status. It can only be updated when fetch or pull is executed.

```bash
git fetch origin
git log --oneline HEAD..origin/main
git log --oneline origin/main..HEAD
```

`pull` is roughly equivalent to `fetch` plus merge or rebase, depending on the configuration. Fetch first, then check the differences, which is usually easier to understand than blindly pulling what will happen.  

When a push is rejected, first determine the reason:  

- The remote has new commits: integrate before pushing.  
- Insufficient permissions: check your account, keys, and repository permissions.  
- Branch is protected: go through code review or adjust branch policies.  
- Incompatible history: confirm whether you are force-pushing based on an old history.  

Do not habitually use `--force` just because a push fails. When you need to overwrite the remote, prioritize using `--force-with-lease`, which at least lets you see if the remote has been modified by others since your last fetch.  

## 6. Things That Should Not Enter the Repository  

`.gitignore` is a boundary, not a cleanup tool. Sensitive information that has been committed, even if later deleted, still exists in history; you need to rotate keys and clean up history.  

Common things to ignore:

```text
node_modules/
.venv/
dist/
coverage/
.env
*.log
*.pem
*.key
models/*.bin
```

Large files, build artifacts, and dependency directories can bloat the repository and create meaningless differences. Binary assets should have clearly defined sources, licenses, and storage methods. Review `git status` and `git diff --staged` at least once before committing.

## 7. Debugging is a chain of evidence

Debugging is not 'guessing a place to change based on experience.' A more reliable process is:

```text
Reproduce the issue
  ↓
Propose a falsifiable hypothesis
  ↓
Choose the smallest observation that can test the hypothesis
  ↓
Narrow the scope
  ↓
Fix the root cause
  ↓
Add tests and verify there are no regressions
```

Every step should leave evidence: minimal input, environment version, logs, requests, traces, files, or commit differences. Judgments without evidence are just guesses.

### 7.1 Reproduce First

Reproduction records should at least include:

- Actual operations and inputs.
- Expected result vs actual result.
- Operating system, runtime, dependencies, and configuration versions.
- Error occurrence time, frequency, and impact scope.
- Whether it can be reproduced reliably; whether it is related to account, data, network, or concurrency.

Do not mark intermittent issues as "resolved" just because they were not reproduced once. Record failure probability, occurrence window, and trigger conditions, and continue to gather samples.

### 7.2 Narrow Scope by Layers

A typical web request can be investigated by the following layers:

| Layer | Questions to ask | Typical evidence |
| --- | --- | --- |
| Browser | Are there JS errors, request failures, rendering lags | Console, Network, Performance |
| Network | Are DNS, TCP, TLS, proxies normal | DNS records, certificates |
| Entry | Does the gateway forward, rate-limit, or reject | Status codes, access logs, routing configuration |
| Application | Which code segment or dependency is slow or failing | Structured logs, traces, breakpoints |
| Data | Are queries, locks, indexes, connection pools abnormal | Slow queries, execution plans, metrics |
| System | Are CPU, memory, disk, or file descriptors exhausted | System metrics, process status, logs |

Do not change five variables at once. Change only one condition at a time to know the cause of the result.

## 8. Browser Debugging

Browser developer tools mainly focus on five areas:

- **Console**: JavaScript errors, warnings, and temporary output; excessive output can slow down the page itself.
- **Network**: Request URL, method, status code, request headers, response, duration, and cache.
- **Sources**: Source code, breakpoints, call stack, and scope; Source Map can help locate minified code.
- **Performance**: Long tasks, layout, painting, main thread, and frame rate.
- **Application**: Cookies, Local Storage, Session Storage, IndexedDB, Service Workers, and cache.

When troubleshooting request issues, distinguish:

- Request not sent at all: frontend logic, forms, permissions, or event binding.
- Request sent but failed: DNS, network, CORS, TLS, server errors.
- 200 returned but page is incorrect: response structure, state updates, rendering, or cache.
- Browser caching old resources: caching headers, Service Worker, build hash, or hard refresh.

## 9. Server-Side Debugging

Server logs should be structured and include at least time, level, service, environment, request ID, error code, and key latency. Logs should not directly output passwords, tokens, full cookies, or sensitive personal data.

```json
{
  "time": "2026-10-31T12:00:00Z",
  "level": "error",
  "service": "orders",
  "requestId": "req_123",
  "code": "DB_TIMEOUT",
  "durationMs": 5032
}
```

Common troubleshooting tools:

| Target | Method |
| --- | --- |
| Which services the request went through | Distributed trace, request ID |
| Which code is slow | Profiler, flame graph, sampling |
| Why memory is increasing | Heap snapshot, GC metrics, object references |
| Why it is blocking | Thread/coroutine state, lock wait, connection pool |
| Whether it is limited by the system | CPU/memory/file descriptors/disk quota |
| Whether it depends on failures | External call latency, error rate, circuit breaker status |

First look at the symptoms, then choose the tools. High CPU may be a loop, or it may be normal encryption; high latency may be slow code, or it may be waiting for a database connection.

## 10. Breakpoints, Logs, and Bisection

### 10.1 Breakpoints

Breakpoints are suitable for viewing variables and call stacks along a specific path. Conditional breakpoints can pause only for specific users or inputs; log breakpoints can output local information without modifying the code.

But breakpoints pause the process, making them unsuitable for observing long-running, concurrent competitions, or high-frequency requests in production. Remote debugging ports must also be strictly protected and not exposed to the public internet.

### 10.2 Logs

Logs should answer specific questions instead of printing every variable. Before adding logs, ask: can this record confirm or refute a particular hypothesis? Once verification is complete, should it be downgraded or removed?

### 10.3 Bisection

Bisection is not only applicable to commits but also to configurations, inputs, and service chains:

- Disable half of the feature flags.
- Replace half of the dependencies.
- Group requests by user, region, or data size.
- Add timing checkpoints in the middle of the request path.

The premise is that groups have clear boundaries and results can be judged as normal or not.

## 11. Concurrency and Intermittent Issues

Intermittent problems often come from shared state. Check:

- Whether two threads are reading and writing the same object simultaneously.
- Whether lock acquisition order may form a cycle.
- Whether background tasks continue to modify the state after a timeout.
- Whether retries cause the same operation to execute multiple times.
- Whether connection pools or queues have limits and waiting can grow indefinitely.
- Whether time, random numbers, and external service responses make testing hard to reproduce.

Do not use "adding a sleep" to mask race conditions. Sleep only changes the timing probability, it is not a synchronization mechanism.

## 12. After Fixing

Fixing requires completing three things simultaneously:

1. Change the root cause instead of just swallowing exceptions at the error point.
2. Add tests or monitoring that consistently expose the problem.
3. Verify normal paths, boundary paths, and failure paths.

If automatic testing is not possible, at least leave manual reproduction steps and queryable metrics. Closing the issue does not mean knowledge is closed: document key troubleshooting paths in the runbook so the next time it can be faster.

## 13. Minimal Problem Record

```text
Title:
Phenomenon:
Minimum input:
Expectation:
Reality:
Environment and Version:
Time and Frequency of Occurrence:
Recent changes:
Existing evidence (logs / trace / requests / commits):
Excluded hypothesis:
Next Step:
```

The value of this record lies in making conclusions verifiable. Good debugging is not 'I guessed it right,' but that others can reach the same conclusion based on evidence. 

## Checklist

- Can you explain the difference between the workspace, staging area, commit, and remote reference?
- Can you undo changes without breaking the public history?
- Will you check for new remote commits and potential conflicts before merging?
- Are you aware of the risk boundaries of `reset`, `revert`, and `reflog`?
- Can you create a minimal reproducible example instead of just describing 'can't open'?
- Can you narrow down the scope by browser, network, service, data, and system layers?
- Do you have request IDs, structured logs, and traceability?
- Do you change only one variable at a time and retain evidence for conclusions?
- After fixing, have you added tests or monitoring to prevent similar issues from occurring again?
