---
title: "From Requirements to Stable Operation: An Engineering Overview"
description: "Use a study materials collection app to link environment, browser, backend, data, architecture, deployment, models, and delivery into a complete chain."
---

The previous notes explained concepts by breaking them down by topic. This one takes a different approach: using only one case to put the scattered knowledge back into a complete chain. The goal is not to list technical terms again, but to show you how a feature answers specific questions at each layer—from requirements, code, and data to the browser, server, and production environment.

The case is deliberately kept small. It is not a complete product, but already includes saving, querying, permissions, failure handling, deployment, and optional model capabilities. Once you go through this chain, switching to payments, chat, content platform, or agent tasks only changes the business rules and processing costs; the points where you troubleshoot issues remain the same.

## 1. First, create a panoramic diagram that can be narrated

An online system can first be understood in the following order:

```text
User Goal
  ↓
Browser interaction
  ↓
DNS / TLS / CDN / WAF
  ↓
Load Balancing / API
  ↓
Application Services
  ↓
Database / Cache / Queue / Object Storage / Model Service
  ↓
Deployment, logs, metrics, trace, backup and rollback
```

Requests go downward, feedback goes upward. The results users see are only the final layer; what truly determines whether a system can run stably is how each layer handles input, stores state, returns output, and recovers from failures.

This diagram is not a component list. Every additional box in the diagram represents an extra set of deployment, monitoring, permissions, and failure modes. Small systems do not need caches, message queues, microservices, and vector databases from the start. A more reliable approach is to first draw the minimal main path, and then add components based on evidence.

There are also several capabilities that span all layers:

- **Identity and Access Control**: Who can read, write, and delete what.
- **Security**: Are inputs, files, network requests, keys, and model outputs trustworthy.
- **Testing**: How to verify normal paths, exception paths, and boundary conditions.
- **Versioning and Delivery**: Can code, configuration, and database migrations be released and rolled back together.
- **Observability**: Is the system actually working online as designed.
- **Cost**: Are the requests, storage, model calls, and maintenance man-hours sustainable.

## 2. Case: A Learning Materials Collection

Suppose we want to create a collection used only by ourselves or a small team, for saving learning materials, writing a few notes, and tagging them.

The first version only does these things:

- Save a piece of material: URL, title, notes, tags.
- Browse by time, filter by keywords and tags.
- Modify, archive, and delete one's own materials.
- All materials are private by default; cannot see others' content.

Explicitly not included: real-time multi-user editing, public sharing pages, recommendation feeds, offline cross-device sync, automatic summaries. They are not rejected forever but just not included in the first version.

We also need to write down quantity assumptions. Without numbers, architecture discussions easily become "the higher the concurrency, the better": 

| Dimension | First Version Assumption |
| --- | --- |
| Users | 1,000 registered users, 100 concurrent online |
| Data | 100,000 items, about 2 KB each including index |
| Traffic | Peak about 20 QPS, reads significantly more than writes |
| Latency | Save p95 less than 500 ms, list p95 less than 300 ms |
| Availability | 99.5% monthly, short-term read-only or feature degradation allowed |
| Backup | RPO 24 hours, RTO 2 hours |

Estimate according to these numbers:

```text
Concurrent requests ≈ 20 QPS × 0.1 seconds ≈ 2
Raw data ≈ 100,000 × 2 KB ≈ 200 MB
```

The first version only requires one application service and one PostgreSQL instance. This conclusion does not mean 'never scale,' but rather that the current solution matches the current constraints. Upgrades should be triggered by metrics, such as the database connection pool consistently nearing its limit, query p95 consistently exceeding the budget, excessive row scans during searches, or model requests blocking the main interface, rather than being triggered by 'hearing that large companies do this.'

Related notes: [System Design Methods and Cases](../system-design/), [One-Page Guide to Computer Systems](../computer-systems/).

## 3. From Source Code to Running Process

An HTTP request sent from a browser ultimately becomes bytes on the network card; service code is scheduled into processes by the operating system; data passes through memory, the file system, and disk; cross-machine communication also goes through DNS, routing, and TLS. Normally, you don't need to remember every hardware detail, but you must be able to determine which layer a problem occurs in during a failure.

For example:

- `connection refused` is more like the process is not listening, the port is wrong, or it is blocked by a firewall.
- TLS handshake failures are more likely due to certificate, domain, time, or proxy configuration issues.
- If a request has entered the service but is slow, you need to look at the application, database, cache, or downstream dependencies.
- If the service is killed by the system, you need to check memory, resource limits, and process logs, not just change business code.

A more complete hierarchy can be found in [One-Page Guide to Computer Systems](../computer-systems/).

### 3.1 Making the Environment Reproducible

'It works on my machine' usually means that the running conditions were not recorded. At a minimum, you need to fix:

```text
Operating system or container image
Language runtime version
Dependency List and Lock File
Database version
Startup Command and Port
Configuration Item Name
Database Migration and Initialization Data
```

Separate configuration and keys. The repository can contain variable names and examples without sensitive information:

```dotenv
APP_ENV=development
APP_PORT=3000
DATABASE_URL=postgres://user:password@localhost:5432/bookmarks
SESSION_SECRET=replace-me
MODEL_API_KEY=optional
```

`MODEL_API_KEY` can only exist on the server side and cannot enter browser code, logs, or Git history. The real value is injected through environment variables or a secrets management service.

It is recommended to write startup, migration, testing, and health check as explicit commands instead of relying on someone remembering a series of steps. Containers can help fix the runtime environment, but they are not backups and will not automatically solve configuration, data migration, or network issues. Related notes: [Reproducible Environment](../reproducible-environment/), [Linux and Deployment](../linux-containers-deploy/).

### 3.2 Using the Repository to Save the "Why"

Git records more than just file differences. A good commit should explain what problem this change solves, and when necessary, include interface, migration, testing, and documentation in the same change. Database schema changes, in particular, must not just be changed online without leaving a migration script.

Do not commit real `.env`, database files, user data, or keys. Before committing, check `git status` and `git diff` to ensure no debug output, temporary files, or credentials are included.

When debugging, narrowing the scope in the following order is much more effective than reinstalling dependencies, clearing caches, and changing code at the same time:

1. Write down the expected results and actual results.
2. Find the minimal steps that can consistently reproduce the issue.
3. Determine which layer the request stops at: browser, network, service, database, or external dependency.
4. Only change one variable at a time and record the results.
5. After fixing, verify with tests and real requests, rather than just checking that the logs no longer report errors.

Related notes: [Git and Debugging](../git-and-debugging/), [Reproducible Environment](../reproducible-environment/).

## 4. How the Browser Turns an Action into a Request

When the user opens a page, the browser fetches HTML, CSS, and JavaScript, parsing them into the DOM and CSSOM, then goes through layout, painting, and compositing to display. Front-end frameworks may also involve component rendering, state updates, and hydration. After clicking "Save," JavaScript handles the event, organizes the request, waits for a response, and then updates the interface.

This path determines that the front end must handle not just "success":

```text
Idle → Saving → Saved
              ↘ Failed → Retry / Edit input
```

During saving, duplicate submissions should be disabled, and a clear status should be displayed; if it fails, preserve the user's input and provide actionable errors; when there is no data, show an empty state instead of a blank screen. Do not pretend the data is saved before the network request succeeds.

Related notes: [Browser Execution Model](../browser-model/), [Frontend Engineering and Application Design](../frontend-for-ai/).

### 4.1 Define the interface first, then write code for both ends

A clear contract is required between the frontend and the server. Saving favorites can use the following request:

```http
POST /api/bookmarks
Content-Type: application/json
Cookie: session=<opaque-token>
Idempotency-Key: 7c3e4b1d-8b7a-4f6d-9e63-2f9a30c7c711

{
  "url": "https://example.com/http-cache",
  "title": "Cached Notes",
  "note": "Organize cache hits and misses",
  "tags": ["http", "cache"]
}
```

Returns `201 Created` on success:

```json
{
  "id": "b_01J8Z6Q4R2",
  "status": "active",
  "createdAt": "2026-10-31T09:20:00Z"
}
```

Mistakes are also part of the contract. Don't just return a piece of natural language:

```json
{
  "error": {
    "code": "INVALID_URL",
    "message": "Must be an http or https address",
    "requestId": "req_01J8Z6R7K9"
  }
}
```

The API should be clearly documented:

- Authentication methods and allowed roles.
- Field lengths, required fields, and normalization rules.
- Pagination methods, e.g., cursor pagination instead of an indefinitely growing offset.
- Whether an idempotency key is required, and what is returned for duplicate requests.
- Timeout, rate limiting, error codes, and retry recommendations.
- Whether deletions take effect immediately, are soft deletions, or are delayed cleanups.

Client-side validation improves user experience, while server-side validation ensures security. The frontend cannot trust any data from the address bar, forms, clipboard, or third-party APIs.

## 5. How the server handles a single save

When a request reaches the service, it can be understood in the following order:

```text
Receiving port
  → Analysis HTTP and Routing
  → Verified User
  Rate Limiting and Basic Protection
  Validate and normalize input
  Check object-level permissions
  Transaction writes to the database
  Send asynchronous task after submission
  → return result and requestId
```

Authentication answers 'Who are you', authorization answers 'Can you operate on this data'. A user being logged in does not mean they can access another user's favorites. When querying, the resource ID and the current user's scope should be included in the condition, rather than querying first and then comparing in the code.

The save logic can be expressed in pseudocode first:

```text
handleSave(request):
  user = authenticate(request)
  input = validate(request.body)
  return db.transaction:
    existing = findBookmark(owner=user.id, url=input.canonicalUrl)
    if existing:
      return existing

    bookmark = insertBookmark(owner=user.id, input)
    outbox.add("bookmark.created", bookmark.id)
    return bookmark
```

This pseudocode has a major flaw: two concurrent requests might both find no records and then both try to insert. Ultimately, you still have to rely on the database's unique constraint as a fallback, returning the existing record after a conflict. Doing a "check before write" only at the application level is not enough.

`Idempotency-Key` Solves a different problem: browser timeouts leading to retries, or a gateway resending the same request. The server stores "user   idempotency key   request summary" so that retries return the result of the first attempt, avoiding duplicate creation or task triggering.

Before returning the response, do not include summary generation, image download, or model calls in the main workflow. These can go into a queue to be executed by background workers. The main request should only confirm that the data has been reliably saved. Relevant notes: [Requests and API](../backend-requests/), [Concurrency and Caching](../backend-scale/), [Language and Structure](../backend-structure/).

## 6. The Data Model Determines What the System Can Answer

This application requires at least two types of data: users and favorites. First, focus on the favorites table:

```sql
CREATE TABLE bookmarks (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id),
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX bookmarks_owner_url_active
  ON bookmarks (owner_id, canonical_url)
  WHERE deleted_at IS NULL;

CREATE INDEX bookmarks_owner_created
  ON bookmarks (owner_id, created_at DESC);

CREATE INDEX bookmarks_tags_gin
  ON bookmarks USING GIN (tags);
```

Every decision here has meaning:

- `owner_id` Put object permissions into the data model; queries must not miss them.
- `canonical_url` This is a normalized URL to avoid duplicate records caused by casing or trailing slashes.
- Some unique indexes only constrain non-deleted records, allowing the same address to be bookmarked again after deletion.
- `created_at` Supports 'My bookmarks sorted in reverse chronological order.'
- `tags` GIN index supports tag inclusion queries.
- `deleted_at` Indicates soft deletion, making it easier to restore and audit, but actual deletion still requires a separate process.

URL normalization should not arbitrarily discard query parameters, because they may determine page content. The rules should be fixed by testing, not by string truncation.

### 6.1 Transactions, Asynchronous Processing, and Consistency

Saving bookmarks and writing outbox events should happen in a single transaction. This prevents a partially successful state where 'there are bookmarks in the database, but the background never generates summaries.' The worker uses at-least-once delivery, so event processing must be idempotent by event ID.

Not all reads require strong consistency:

- If you refresh the list right after saving, you should see your own data. You can read from the primary database or wait in the session for replication to catch up.
- Public statistics viewed by others can lag a few seconds.
- Search indexes may lag briefly, but the interface should indicate 'results may be delayed.'

Consistency is an operation-specific requirement, not a label for the entire system.

### 6.2 Search and Data Lifecycle

With small data volumes, simple keyword queries may suffice; as the data grows, `LIKE '%word%'` often scans a large number of rows. You can choose full-text indexes, trigram indexes, or a separate search service based on needs, but you must limit the number of results and continue to respect user scope.

You also need to answer in advance:

- How long after deletion will data disappear from backups and search indexes?
- Is it allowed to export all of your own data?
- Has the backup ever been restored in a drill, not just showing 'success'?
- Do analytic events include note content, sensitive parameters in URLs, or user identities?

User data, analytic data, and reconciliation data have different sources of truth. Analytic tables can be redundant, but they must not determine what users see. Related notes: [Databases and Storage](../data-storage/), [Metrics and Governance](../data-products/).

## 7. Where to Start When the System Grows

The first version can be a single deployment unit:

```text
Browser → Application Service → PostgreSQL
                    └→ outbox → worker → optional summary task
```

This is not an outdated 'monolith', but a modular monolith with clear module boundaries. Its advantages are simple transactions, fewer deployments, and shorter troubleshooting paths. Microservices trade code coupling for network calls, data consistency, and independent operation and maintenance costs, and are only worthwhile when there are clear needs for team boundaries, independent scaling, or failure isolation.

The order of scaling should be determined by evidence:

| Phenomenon | Verify First | Consider Afterwards | Don't Do First |
| --- | --- | --- | --- |
| List slows down | Query plans, indexes, returned fields | Caching, read-only replicas | Split into microservices directly |
| Write conflicts | Transaction scope, unique constraints, hot rows | Batch processing, partitioning | Switch to a distributed database directly |
| Long tasks occupy requests | Timeout, blocking points, concurrency | Queue, worker pool, backpressure | Add unlimited threads |
| Read concentration | Hit rate, hot keys, permission granularity | In-process cache, shared cache | Full caching without expiration policy |
| Multi-region access | Actual latency and compliance requirements | CDN, regional replicas | Dual-masters without design |

### 7.1 Reliability is the behavior that can still be explained when failures occur

Reliability is not just about 'deploying a few more instances.' It should at least handle:

- **Timeouts**: Each external call has an upper limit; a slow dependency should not hold up the entire request.
- **Retries**: Only retry operations that can be safely retried; set the number of attempts, backoff, and jitter to avoid retry storms.
- **Circuit breakers and isolation**: Pause calls when downstream continuously fails to protect threads, connections, and memory.
- **Degradation**: Still save and search summaries when failures occur; fallback to keyword results when models are unavailable.
- **Backpressure**: Limit new tasks when queues are congested instead of accepting infinitely until memory is exhausted.
- **Graceful shutdown**: Stop accepting new requests during release or scaling down, and wait for ongoing requests to finish or safely cancel.
- **Backup and recovery**: Regularly verify that recovery within the target RTO is possible, not just that backup files exist.

Common failures can be inferred as follows:

| Failure | Correct Behavior |
| --- | --- |
| Database unavailable | Return a clear `503`, do not pretend save was successful; keep retry instructions |
| All cache fails | Rate-limit and fetch from source to protect the database, provide degraded read if necessary |
| Queue backlog | Continue main save, delay summary and notifications, show pending state on UI |
| Model timeout | Return keyword search results or 'please retry later', do not let the main interface fail too |
| Duplicate requests | Return the same result using idempotency key and unique constraints, do not execute tasks repeatedly |
| Rollback of new version | Keep data migration backward compatible, old version can still read required parts in the new structure |

Related notes: [Distributed and High Availability](../architecture-reliability/), [System Design Methods and Cases](../system-design/).

## 8. Going live is not just copying code to the server

A roll-backable release generally includes:

```text
Submit code
  Static Checking and Testing
  → Construct Immutable Products
  Check database migration
  Small-scale deployment
  Health Checkup and Indicator Monitoring
  → Expand traffic or rollback
```

Database migration recommends using "extend—migrate—contract": first add compatible fields or tables, doublewrite or backfill, switch reads, confirm that the old version no longer depends on it, then delete the old structure. Do not delete fields, modify code, and rollback mechanisms all within a single release. 

Linux, containers, and network boundaries still apply: processes need to listen for the correct ports, containers require resource limiting and health checks, data cannot be stored only in temporary container layers, and services must go through DNS, TLS, firewalls, and security groups for cross-network access. Containers address runtime environment encapsulation, not automatic persistence, backup, or permission issues. 

Related notes: [Linux and Deployment](../linux-containers-deploy/), [Network and Cloud Security](../network-cloud-security/). 

### 8.1 Permissions and Attack Surface

The most realistic threat to this app is not a "hacker movie-style hack," but a common bug: 

| Risk | Specific Issues | Control |
| --- | --- | --- |
| Unauthorized reading | Only query by collection ID, without the current user's | All object queries include `owner_id`, and test the other person's ID |
| XSS | Render notes or titles as HTML | Render by text by default; Whitelist cleanse when rich text is required
| CSRF | Submitted on behalf of a third-party site under the cookie session | SameSite, CSRF token, check request source |
| SSRF | The server automatically crawls the URL entered by the user | Restricts protocols, blocks internal addresses after parsing, restricts redirects and response size |
| Key Leak | Inserting model or other service keys into the frontend | Keys are only placed on the server side; logs and error messages are desensitized |
| Abuse | Batch save, unlimited search, model call scaling | Authentication, rate limiting, quotas, auditing, and anomaly detection |

Permission checks should cover reading, modifying, deleting, and exporting, not just saving interfaces. Related notes: [Security and Delivery](../security-and-delivery/). 

### 8.2 Observe a Request Once

At least three types of signals are required online: 

- **Logs**: Time, request ID, user scope, interface, status code, error code, time consumption; Do not record keys or complete sensitive text. 
- **Metrics**: Request rate, error rate, latency quantile, database connection pool, cache hit rate, queue backlog, model call time and cost. 
- **trace**: The time distribution of a request across access layers, applications, databases, and downstream. 

Health checks are divided into liveness and readiness: a process is alive but does not mean it can receive traffic. When database connections are not ready, migration is incomplete, or dependencies are unavailable, readiness checks should block new traffic. 

Below is a fault that links the frontend, database, deployment, and observation: 

1. The new version adds keyword search, and after release, the interface P95 has increased from 300 ms to about 2 seconds, with an error rate exceeding 3%. 
2. The dashboard shows that the browser and CDN are normal, with latency concentrated in the API; The trace shows that most of the time is spent on database queries. 
3. Logs show that searches use `LIKE '%keyword%'`, with no available indexes, and no paging limit; If concurrency is slightly high, it fills the connection pool. 
4. First, turn off the search function switch, restore the main path, then roll back the incompatible parts; Do not use infinite connections to mask slow queries. 
5. The fix method is to add appropriate full-text or trigram indexes, limit the number of entries returned and query timeouts, perform stress testing based on the actual data volume, and then republish it using grayscale. 
6. Post-release add p95, connection pool, and slow query alerts, and add the "Query Plan on 100,000 Rows of Data" to the release check. 

In this example, caching might temporarily reduce requests, but the root cause is query patterns and indexes. The value of monitoring is to help you locate, not to make alerts look more professional. Related notes: [Observability](../observability-incidents/). 

## 9. Modeling capabilities can be added as needed

Models are not a necessary layer for every application. Collections, lists, and permissions are cheaper and more stable with deterministic code. They are only added when the task itself is vague and requires natural language understanding or generation, for example: 

- Generate summaries for long notes. 
- Based on a description, find information with "similar meanings." 
- Provide sourced answers for multiple sources. 

Take "Answer questions based on favorites" as an example: the complete process is still the standard system process, just with an added model in between:

```text
User Question
  Authentication and User Scope
  → Keyword Recall + Vector Recall
  Merge and remove duplicates
  Permission Filtering
  Reorder candidates
  → Organizational Context and Prompt Words
  Model Generation
  Structural validation and reference checking
  → Return answer or fallback result
```

The request can be:

```json
{
  "question": "When will the cache become invalid?"
}
```

The response should be able to explain the basis and the degraded status:

```json
{
  "answer": "The data mentions three situations: expiration, proactive invalidation, and cache key changes.",
  "sources": ["b_01J8Z6Q4R2", "b_01J8Z8T1M6"],
  "degraded": false
}
```

Related notes: [Large Models and Multimodality](../llm-foundations/), [RAG and Agent](../rag-and-agents/).

### 9.1 What prompts, retrieval, and agents are each responsible for

- **Retrieval** decides which information should be included in the context. Text must be segmented and indexed first, and candidate items must be recalled and re-ranked during queries. Permission filtering must be completed before candidates enter the model.
- **Prompts** are responsible for task instructions, output constraints, and a small number of examples. Treat the content of already bookmarked web pages as "information," not as "system instructions"; there may be prompt injections hidden in web pages.
- **Agents** are suitable for tasks that require multiple steps and tool calls, such as searching first, then opening documents, and finally summarizing. They need maximum step counts, timeouts, tool permissions, failure handling, and important operations should be confirmed manually.
- **Structured output** facilitates program validation, but the JSON returned by the model may still have missing fields or not comply with business rules, so it must be verified and cannot be written directly to a database.

A simplified prompt constraint can be written as:

```text
Answer only based on the content in <sources>.
If there is insufficient information, answer 'The existing information cannot be confirmed,' and do not add external facts.
Attach the source ID to each conclusion.
Output JSON: {"answer": string, "sourceIds": string[]}
```

Prompts cannot replace database permissions or solve expired indexes. They are only part of the model layer. 

### 9.2 Model Layer Failures and Evaluations

| Failure | Handling |
| --- | --- |
| Model timeout or rate limiting | Returns keyword search results, marked `degraded`, allowing retry |
| Output format error | If a structural repair or retry still fails, it returns a pure search result |
| Insufficient information or answers without sources | Clearly state that it cannot be confirmed, do not fabricate citations |
| Prompt to inject | Webpage content is only for data, tool permissions are minimized, and dangerous actions must be confirmed |
| Cross-user leakage | Before searching, filter by user, cache key includes permission range |
| Cost runaway | Limit context length, concurrency, and quotas; asynchronous tasks are metered separately

Before launch, prepare a set of fixed questions, expected sources, and unacceptable answers, and record recall, citation accuracy, delay, and cost. After the model or prompt changes, conduct offline evaluation, then conduct small-scale traffic comparisons; After launch, collect manual feedback and failure samples. Related notes: [Model Lifecycle](../model-lifecycle/). 

The model layer does not change the previous conclusion: it still receives input through interfaces and still needs databases, queues, permissions, timeouts, degradation, logs, testing, and rollbacks. It simply shifts some uncertainty from code to models and retrieval. 

## 10. Lock in changes with testing and delivery

The test in this case should not only cover "saved successful": 

| Hierarchy | Example | Main findings |
| --- | --- | --- |
| Unit testing | URL normalization, tag cleaning, permission determination | Boundary rule errors |
| Integration testing | API + database + transactions + idempotency keys | Interfaces are inconsistent with real storage |
| End-to-end testing | Save, refresh, search, delete | Disconnect from browser and backend link |
| Contract testing | Request fields, error codes, pagination format | Frontend and backend versions are incompatible |
| Stress testing | 2x peaks, slow databases, queue backlog | Overload and resource exhaustion |
| Security Testing | Others' resource IDs, script injections, internal URLs | Unauthorized access and SSRF |
| Model Evaluation | Recalls, Citations, Refusals, Timeout Downgrades | True Quality Beyond Demos |

A complete change can be advanced in the following order: 

1. Clearly state user outcomes, constraints, and non-objectives. 
2. Write the API contract, data migration, and acceptance conditions. 
3. Prepare the environment, seed data, and repeatable tests. 
4. First, implement a minimal vertical link, then add boundaries. 
5. Override errors, duplication, overreach, and dependency failures. 
6. Check whether migrations are backward compatible and rollback possible. 
7. Grayscale releases to observe requests, errors, delays, and resources. 
8. Record trade-offs, clean up temporary switches and old code. 

Code quality and design patterns serve understandability and modifiability, not just to make directories look complicated. Only recurring, well-defined issues are worth abstracting. Third-party libraries, models, and data sources also check licenses, maintenance status, and data usage boundaries. Related notes: [Code & Testing](../code-testing-design/), [Security & Delivery](../security-and-delivery/). 

## 11. Consolidate the entire chain into a single framework

When understanding unfamiliar systems, you can consistently ask six questions: 

1. What goals do users want to achieve? Which results are unacceptable? What are the current non-goals? 
2. Which data is the source of facts? Who owns it, how long is it retained, and how is it deleted and recovered? 
3. What boundaries does a request pass through? What are the inputs, outputs, and timeouts for each layer? 
4. What happens during repeat, concurrency, timeout, overload, and dependency failures? 
5. Who can read, write, delete, and export? What are the worst consequences of overreach? 
6. How to verify, deploy, observe, downgrade, roll back, and continue to evolve? 

This framework can be described as:

```text
System = User Goal
     Data and Status
     Request link
     Failure Handling
     Permission boundary
     Operation Feedback
     Evolution cost
```

The nine chapters can also be placed back into this chain:

| Chapter | What it answers in a case | Corresponding notes |
| --- | --- | --- |
| Computer Systems | Where the program runs, why memory, I/O, and network affect performance | [Computer Systems at a Glance](../computer-systems/) |
| Development Environment & Tools | How to reproduce the environment, manage versions, and locate faults | [Reproducible Environments](../reproducible-environment/), [Git & Debugging](../git-and-debugging/) |
| Browser & Frontend | How user actions turn into requests, how pages handle waiting and errors | [Browser Runtime Model](../browser-model/), [Frontend Engineering & Application Design](../frontend-for-ai/) |
| Server & Backend | How requests are authenticated, validated, written, and safely returned | [Requests & API](../backend-requests/), [Concurrency & Caching](../backend-scale/), [Languages & Structures](../backend-structure/) |
| Data | Where data is stored, who can access it, how to ensure indexing, transactions, and lifecycle | [Databases & Storage](../data-storage/), [Metrics & Governance](../data-products/) |
| Architecture & System Design | When to scale, split services, and degrade, how to document trade-offs | [Distributed & High Availability](../architecture-reliability/), [System Design Methods & Cases](../system-design/) |
| Infrastructure & Operations | How to deploy, network, protect boundaries, and observe production | [Linux & Deployment](../linux-containers-deploy/), [Network & Cloud Security](../network-cloud-security/), [Observability](../observability-incidents/) |
| Model Systems | When a model is needed, how retrieval, prompts, Agents, and evaluation are integrated | [Large Models & Multimodal](../llm-foundations/), [RAG & Agent](../rag-and-agents/), [Model Lifecycle](../model-lifecycle/) |
| Engineering Literacy | How to turn changes into reliable results using code, tests, security, and delivery | [Code & Testing](../code-testing-design/), [Security & Delivery](../security-and-delivery/) |

If you can only remember one sentence: first determine the user outcome and source of truth, then follow a real request across all boundaries, and finally check failures, permissions, observability, and rollback. The tech stack may change, but this sequence of questioning will not.

### Three Exercises

1. Add a "public share link" to favorites. Write out the new data fields, permission rules, revocation methods, cache, and search engine risks.
2. Suppose traffic grows 100x. First list the metrics to measure, then select only the two smallest architecture changes and explain why the other changes are not done at this stage.
3. Add "answer questions based on favorites" to a case. Draw the path for recall, permission filtering, model calls, and degradation, then list three situations where model output cannot be written directly to the database.

If you can independently complete these three exercises, you can basically connect the scattered concepts into a full chain that can be used for design, troubleshooting, and delivery.
