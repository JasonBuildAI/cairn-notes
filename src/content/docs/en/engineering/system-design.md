---
title: "System Design Methods and Cases"
description: "From requirements clarification, capacity estimation, and interface design to fault analysis, use constraint-driven architecture selection."
---

System design is not about stacking caches, message queues, and microservices on a diagram, but about starting from requirements and explaining how data flows, where capacity comes from, and what the system does when failures occur. Both whiteboard questions in interviews and real projects follow the same sequence: first clarify the problem, then estimate, then draw the minimal path, and finally eliminate bottlenecks one by one.

## 1. Clarify Requirements First

### 1.1 Functional Scope

Break down "build a chat system" or "build an e-commerce platform" into a limited set of functions:

- Who uses it, and what are the roles?
- What are the core operations?
- Which features must exist in the first version, and which can be added later?
- How long is data retained, and is deletion and export allowed?

The vaguer the questions, the easier it is to draw an architecture that can do anything but has no focus. Start with a main path, for example, "a user sends a message, and another online user receives it," rather than designing a complete social platform from the beginning.

### 1.2 Non-functional Requirements

| Dimension | Questions to Ask |
| --- | --- |
| Scale | Daily active users, request volume, data volume, read/write ratio |
| Latency | Which operations must be fast, and what is the target percentile |
| Availability | How long is downtime acceptable, which features are prioritized |
| Consistency | Which data cannot be stale, how long eventual consistency is allowed |
| Security | Authentication, authorization, auditing, sensitive data |
| Cost | Budget, infrastructure limits, unit economics |
| Operations | Can the team maintain these components |

"High availability, high concurrency, low latency" are not requirements but wishes. Specific numbers, percentiles, and failure tolerance must be provided to make trade-offs.

## 2. Capacity Estimation

Estimation does not need to be precise, but the order of magnitude should guide the design.

### 2.1 Common Conversions

```text
1 day ≈ 86,400 seconds, approximately 10^5 seconds
1 million daily requests ≈ 11.6 QPS average
100 million daily requests ≈ 1,157 QPS average
```

Peak value is usually several times the average. If the business is concentrated within a few hours, the peak will be higher. For example, 1 million daily requests average about 12 QPS, but if 80% of the traffic is concentrated within 4 hours, the peak averages about `0.8 × 1,000,000 / (4 × 3600) ≈ 56 QPS`, then multiplied by the burst coefficient.

### 2.2 Concurrent Requests

Estimate using Little's Law:

```text
Concurrent requests ≈ Arrivals QPS × Average processing time (seconds)
```

100 QPS, average processing time 200 ms, about 20 requests processed simultaneously. If Yi relies on slowing down to 2 seconds, concurrency will increase to 200, and the connection pool and thread pool may be exhausted first.

### 2.3 Storage

```text
Daily new data ≈ Daily record count × Average bytes per record
Total storage ≈ Daily additions × Retention days × Replica/index expansion factor
```

For example, 1 million records per day, each 1 KB, retained for 365 days, is about 365 GB in raw data; adding indexes, replicas, and backups, it may require several TB. Growth rate and archiving also need to be considered.

### 2.4 Bandwidth

```text
Bandwidth ≈ Requests per second × Average response size
```

1,000 QPS, with each response being 50 KB, requires about 50 MB/s of outbound bandwidth, and peaks and retransmissions will be higher. Large files or media streams must be estimated separately.

## 3. Interfaces and Data Models

Interfaces define system boundaries, while data models define the structure of facts.

### 3.1 API First

Use a small number of core interfaces to describe the main process:

```http
POST /messages
GET  /conversations/{id}/messages?cursor=...
GET  /users/{id}
```

Clearly write for each interface:

- Input, output, and error codes.
- Identity, permissions, and tenant boundaries.
- Pagination, idempotency, and timeouts.
- Data consistency requirements.

### 3.2 Data Model

```text
User 1 ─── N ConversationMember N ─── 1 Conversation
Conversation 1 ─── N Message
User 1 ─── N Message
```

First, determine the primary key, time, status, and index, then consider caching. For users, messages, and sessions, what serves as the source of truth for each? Is deleting a message a physical delete, a soft delete, or only hidden for certain people? These semantics directly affect the API and storage.

## 4. Draw the minimal main link

A complete request link usually includes:

```text
Client
  → CDN/WAF
  → Load Balancing/API Gateway
  Application Services
  Cache/Database/Queue
  External Dependencies
```

First draw the minimal version, then question the necessity of each component:

- No CDN, where do static resources come from?
- No caching, can the database handle it?
- No queue, will long tasks block requests?
- No replicas, how to recover from a single-machine failure?

Each component adds deployment, monitoring, and failure surfaces. When a single database can solve it, there is no need to deploy a distributed search engine first.

## 5. Finding bottlenecks and failure points

### 5.1 Read-write ratio

If reads are more frequent than writes, use caching, replicas, and CDN; if writes are more frequent than reads, focus more on batch processing, queues, sharding, and index costs. Do not apply the same cache to all interfaces.

### 5.2 Hotspots

Popular content, popular users, and large tenants can cause pressure on a single key or single partition. Solutions may include local caching, request merging, read replicas, hotspot splitting, and rate limiting. Shard key design should avoid having all traffic fall on the same shard.

### 5.3 Long tail

Overall throughput is sufficient, but a few requests are very slow. Timeouts, concurrency limits, degradation, and observability are needed. A slow query occupying the connection pool will slow down other requests on the same instance.

### 5.4 Failure propagation

When dependencies slow down, upstream threads and connections get occupied, and eventually fail themselves. Use timeouts, circuit breakers, bulkheads, and backpressure to block propagation rather than retry indefinitely.

## 6. Case Study: Short Link Service

### 6.1 Requirements

- Users submit long URLs and get short codes.
- Accessing the short link redirects to the original URL and returns `301/302`.
- Support custom short codes, expiration times, access statistics, and deletion.
- Target availability 99.9%, reads far exceed writes.
- Users cannot view or modify other users' private links.

### 6.2 Estimation

Assuming 1 million new short links per day, an average of 500 bytes per record, retained for 5 years:

```text
Raw data ≈ 1 million × 500 B × 365 × 5 ≈ 0.9 TB
Write QPS average ≈ 12, peak about 120 times 10
If reading is 100 times that of writing, the average is about 1,200 QPS
```

The read volume is significantly larger, suitable for caching and CDN/edge optimization; writes require short code uniqueness and deduplication strategies.

### 6.3 Data Model

```sql
CREATE TABLE links (
  id BIGINT PRIMARY KEY,
  short_code VARCHAR(16) NOT NULL UNIQUE,
  long_url TEXT NOT NULL,
  owner_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);
```

Short codes can be generated randomly and retried, or the unique ID can be encoded into a short string. Random short codes need to check for conflicts; sequential IDs are predictable, and private links still need authentication, and security cannot rely on 'others not being able to guess it.'

### 6.4 Access Path

```text
GET /{code}
  → Read Cache
  → Cache miss, checking database
  Check expiration/delete/status
  → Record asynchronous statistics
  → Return redirect
```

Statistic writes should not block redirection on the main link and can be queued for batch aggregation. Cache keys include short codes and versions; they should be actively invalidated when deleted or updated. Malicious short codes, open redirects, and phishing targets need review and blacklisting.

### 6.5 Scaling

- Read-heavy: CDN, read-only replicas, in-process/distributed cache.
- Write-heavy: shard by owner or short code hash.
- Hotspots: local caching and request merging.
- Statistics: event streams, batch processing, pre-aggregation.
- Availability: multiple instances, database failover, cache degradation.

### 6.6 Failure Modes

| Failure | Behavior |
| --- | --- |
| Cache unavailable | Fallback to origin with rate limiting to prevent database overload |
| Primary database failure | Pause writes, degrade reads according to consistency requirements |
| Statistic queue backlog | Redirection continues, statistics delayed or sampled |
| Malicious target URL | Blacklist, manual/automatic review, blocking |
| Short code conflict | Enforce uniqueness with retry, cannot overwrite old records |

## 7. Case Study: Asynchronous Task Platform

### 7.1 Requirements

- Users submit time-consuming tasks and immediately receive a task ID.
- Tasks have queued, running, succeeded, failed, and canceled states.
- Results are kept for a period, allowing queries and downloads.
- Peak periods cannot indefinitely consume resources.

### 7.2 Architecture

```text
API → Task List → Queue → Worker
       ↑                │
       └──── Status Update ──┘
User → queries/SSE/polls → status and results
```

The task table is the source of truth, and the queue is responsible for scheduling. Task ID serves as an idempotency key; when a Worker picks up a task, it uses visibility timeout and heartbeat to prevent task loss or duplicate execution.

### 7.3 Key Issues

- Task duplication: the processor is idempotent.
- Worker crash: re-queue after lease expiration.
- Queue backlog: limit submissions, schedule by priority, scale out.
- Result storage: object storage for metadata, setting lifecycle.
- Cancellation: mark the intent, Worker checks at safe points.
- Huge output: stream writing, do not load entirely into memory.

## 8. Security, Observability, and Deployment

System design cannot add security as an afterthought:

- All resource accesses check object-level permissions.
- Uploads, URLs, callbacks, and third-party inputs are untrusted.
- Keys are injected in a controlled manner, and logs are sanitized.
- External interfaces are rate-limited, audited, and have defined error boundaries.

Observability should at least include request volume, error rate, latency percentiles, saturation, queue backlog, and dependency health. During design, specify which metric or trace demonstrates each key state.

Deployment should support canary, rollback, and data migration. Is the data written by the new version compatible with the old version? After rollback, what happens to new fields and messages? Addressing these questions in the design phase is cheaper than after release.

## 9. Use ADR to Record Trade-offs

```text
Title: Short Link Read Cache Solution
Background: Reading QPS high, the main database has limited capacity
Plan: Cache-Aside +  short TTL +  actively invalid
Reason: Allows temporary staleness, controllable back-to-source
Risk: briefly seeing old links after deletion
Mitigation: Actively invalidate upon deletion, do not cache sensitive links for long
Verification: cache hit rate, origin fetch QPS, stale read ratio
```

Architecture diagrams show "what it is," ADR explains "why." Without records of trade-offs, it is difficult to determine whether to persist during the next failure.

## Checklist

- Are the functional scope, roles, and main workflows clear?
- Are there numerical targets for scale, latency, availability, and consistency?
- Does the capacity estimation cover QPS, concurrency, storage, and bandwidth?
- Do the interfaces have permissions, idempotency, pagination, and error contracts?
- Does the data model clearly define primary keys, timestamps, status, and sources of truth?
- Does each component have a reason for existence and an explanation of its cost?
- Are hotspots, tail latency, dependency failures, and overload analyzed?
- Does it handle deletion, expiration, auditing, and access control?
- Are there strategies for canary releases, migrations, rollbacks, and compatibility?
- Are key assumptions and trade-offs recorded in ADRs or design documents?
