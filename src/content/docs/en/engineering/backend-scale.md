---
title: "Concurrency, Caching, and Asynchronous"
description: "Starting from latency, throughput, and queuing, understand threads, asynchronous I/O, caching, queues, rate limiting, and overload protection."
---

Systems slowing down is usually not because of the phrase 'the code is not fast enough,' but because something is waiting: waiting for the CPU, waiting for memory, waiting for locks, waiting for disk, waiting for the database, waiting for the network, or waiting for tasks ahead in the queue. Concurrency, caching, queuing, and rate limiting all handle these waits, just in different ways and at different costs.

## 1. Latency, Throughput, and Queuing

- **Latency**: How long it takes for a single operation to go from start to completion.
- **Throughput**: How many operations can be completed per unit of time.
- **Concurrency**: How many operations are in progress at the same time.
- **Parallelism**: How many operations are actually executed simultaneously.

Asynchronous requests are not necessarily executed in parallel. A CPU core can switch between multiple requests; if one request runs a long loop, other requests still have to wait.

When system load increases, requests do not slow down linearly; they first enter a queue. As the queue lengthens, waiting time increases rapidly, eventually leading to timeouts and retries, which generate more requests and create a positive feedback failure.

You can estimate concurrency demand with a simplified relationship:

```text
Little Law: Concurrency ≈ Arrival Rate × Average Residence Time
```

For example, if `200` requests are received per second and each request takes an average of `0.5` seconds to process, there will be roughly `100` requests simultaneously in the system on average. Peak values also need to account for spikes, long tails, and slowed dependencies.

Averages often hide problems. An interface averaging 100 ms may still feel noticeably laggy to users if 1% of requests take 5 seconds. Observe `p50`, `p95`, `p99`, as well as the maximum values, and clearly define the statistical window and sample size.

## 2. Concurrency Models

### 2.1 Processes, Threads, and Coroutines

- Multi-process: Strong isolation, crashes have less impact, but inter-process communication and memory costs are higher.
- Multi-thread: Shares address space, suitable for CPU parallelism, but shared state requires locks and other synchronization.
- Event loop/coroutines: A few threads manage many I/O waits, suitable for high-concurrency network services, but blocking calls can hold up the entire event loop.

No single model has absolute advantages. CPU-intensive tasks require real parallel computation; many slow network requests rely more on non-blocking I/O; tasks with high isolation requirements may be suitable for independent processes or containers.

### 2.2 Race Conditions

Race conditions occur when the result depends on an uncontrollable execution order:

```text
Thread A: Read balance 100
Thread B: Read balance 100
Thread A: Write 100 - 30 = 70
Thread B: Write 100 - 50 = 50
```

In the end, only one item was deducted. Locks, atomic operations, database condition updates, or serial queues can solve problems in different scenarios, but the scope of the lock and the state of failure must be clearly defined. 

Too many locks reduce concurrency and may lead to deadlocks. Deadlocks need to meet conditions such as mutual exclusivity, hold and wait, non-preemptive, and loop waiting; Prevention methods include fixing lock order, setting wait timeouts, reducing lock granularity, or switching to a shareless design. 

### 2.3 Cancellation and Timeout

After a request times out, backend operations may not automatically stop. If the client has already abandoned the server, the server continues to query the database, call third parties, or occupy threads, and resources will continue to be consumed. 

Cancel signals should propagate from the entry point along the call chain, with reasonable timeouts set for each step. Timeout values should not be overlooked: wait based on dependency delay distribution and business-acceptable wait, rather than setting all layers to 30 seconds. 

## 3. Cache

Caching trades "potentially older data" for lower latency, less database pressure, and higher throughput. Before introducing caching, answer four questions: 

1. What data should be cached, and what keys should be used? 
2. How long is data allowed to be outdated? 
3. Who is responsible for causing cache invalidation when data changes? 
4. How to downgrade the system when cache is unavailable or missed? 

### 3.1 Cache Layer

| Layer | Typical Object | Feature |
| --- | --- | --- |
| Browser | Static resources, API response | Closest to the user, affected by Cookie, CORS, and cache headers |
| CDN | Images, scripts, public content | Edge node cache, needs to handle backsourcing and refresh |
| Within the application process | Configuration, hotspot object | The fastest one, but multiple instances may not be consistent |
| Distributed caching | Sessions and query results | Multi-instance sharing, increasing network and consistency costs |
| Database caching | Pages, query plans | Internal database management, applications usually cannot directly control |

### 3.2 Common Patterns

- **Cache-Aside**: The application first checks the cache, then checks the database only when it misses and backfills. 
- **Read-Through**: The cache layer is responsible for loading when misses occur. 
- **Write-Through**: Updates the cache while updating data. 
- **Write-Behind**: Updates the cache first, writes asynchronously back to the database, may lose data. 

Cache-Aside is the most common, but there is a brief inconsistency between "modify the database first or delete the cache first." Deleting the cache is usually more reliable than updating directly; It also addresses issues where concurrent reads and writes cause old values to be backfilled, such as delayed double-delete, version number, or subscription change events. 

### 3.3 Caching Failure Mode

| Problem | Phenomenon | Protection |
| --- | --- | --- |
| Cache penetration | Query non-existent keys, always entering the database | Null cache, parameter validation, Bloom filter |
| Cache breakdown | Hotkey expiration, massive requests reverted simultaneously | Mutually exclusive reconstruction, logic expired, preheating |
| Cache avalanche | Numerous keys expire simultaneously or cache is unavailable | Random TTL, layered cache, downgrade, and rate limiting |
| Hotspot tilt | A single key can crush a node | Sharding hotspots, request merge, rate limiting |
| Outdated data | Still read old values after writing | Version, invalid, short TTL, business tolerance |

### 3.4 Keys and Consistency

Cache keys must contain inputs that distinguish results, such as tenant, language, permission range, query parameters, and version. Missing dimensions can mistakenly assign one user's data to another, which is a security issue, not just a cache issue. 

A cache is not a database. It needs to be strong, consistent, and recoverable, and key states should be persistent; Cache can be lost. A higher cache hit rate is not always better; incorrect hits may leave users with long-term exposure to old data. 

## 4. Current limiting, back pressure, and overload protection

### 4.1 Rate Limiting

Limit the number of requests or resource consumption per unit time, protecting yourself and upstream. 

Common algorithms: 

- **Fixed Window**: One count per minute, simple, but the window boundary can instantly allow twice the traffic to pass. 
- **Sliding window**: Smoother statistics over a period of time, with higher status and calculation costs. 
- **Token Bucket**: Replenishes tokens according to rate, allowing for certain bursts. 
- **Leaky Buckets**: Processes at a fixed rate, smooths output, but may increase wait times. 

Rate limiting dimensions can include IP, user, tenant, API Key, interface, or global. Pressing only IP may accidentally harm shared exits, but pressing only user cannot block anonymous traffic. Returning `429` can provide `Retry-After`, but avoid clients retrying simultaneously to create a second peak. 

### 4.2 Back pressure

When downstream can't handle it, upstream must receive a "slower" signal instead of an infinite stacking queue. Implementation methods include: 

- Limit queue length. 
- Limit the amount of concurrent work. 
- Reject new tasks when the waiting time exceeds the threshold. 
- Pause reading upstream streams until consumers catch up. 
- Automatic downgrade based on resource metrics. 

If the system only "receives and queues," the queue will eventually run out of memory; If it only "fails," user experience will sharply decline. A reasonable strategy is to reserve critical requests by business priority and reject low-value or retryable requests early. 

### 4.3 Retrying, Fuse, and Isolation

Retries are suitable for temporary faults and not for parameter errors or irreparable conflicts. Retries must: 

- There is a maximum number of attempts and a cutoff time. 
- Use exponential retreat and random jitter to avoid retrying the storm. 
- Only performs idempotent operations or operations with idempotent keys. 
- Distinguish network timeouts, rate limits, service outages, and business failures. 

**Fuse** temporarily stops requests after consecutive dependency failures, giving upstream recovery time and preventing local threads and connections from being exhausted. It usually has three states: closed, open, and half-open. 

**Bulkhead Isolation** Places different tenants, tasks, or dependencies into independent resource pools to prevent a slow dependency from dragging down the entire service. For example, setting separate work queues and concurrency limits for export tasks. 

## 5. Message queue and task queue

Queues change "Complete Now" to "Handle Later," commonly used for sending emails, generating reports, processing uploads, synchronizing data, and shaving peaks.

```text
API → Queue → Worker → Database/External Service
           ↘ Retry on Failure → Dead Letter Queue
```

### 5.1 Delivery Semantics

- **At most once**: Messages may be lost but will not be repeated. 
- **At least once**: Not lost, but may be repeated; consumers must be idempotent. 
- **Just once**: Usually an idempotent effect achieved by both business and messaging systems, not guaranteed by a single configuration statement. 

Most systems choose to deliver at least once, leaving duplicate processing to the business Idempotent key to resolve. 

### 5.2 Consumer Design

- Message IDs are used for deduplication and tracking. 
- Processing time is limited; overdue tasks can be canceled or moved to the retry queue. 
- Failure is subject to retry limits, evasion, and death letter handling. 
- When sequential is needed, specify the partition key; do not assume global order. 
- Monitor backlog, consumption rate, failure rate, and the age of the oldest messages. 
- Consider the old message format when releasing new consumer versions. 

Message queues cannot replace database transactions. If the database commits successfully but the message fails to send, or if the message is sent but the database rolls back, inconsistencies will occur. A common solution is to write the outbox table within the transaction, which is then reliably delivered by a dedicated process. 

## 6. Database connection and expansion

Applications do not directly "access the database with unlimited concurrency." The connection pool provides limited connections; too many connections increase database switching and lock competition, too few cause request queues. 

Observations to observe: 

- Number of active connections, idle connections, and waiting connections. 
- Query time, lock wait, and transaction duration. 
- Connection leakage: Not returned after borrowing. 
- Slow query to see if the connection pool is full. 

Common directions for expanding databases: 

| Method | Effect | Cost |
| --- | --- | --- |
| Indexing and query optimization | Reduce the cost of each query | Maintenance is required, and writes will also slow down |
| Read copy | Share read traffic | Replication delay and consistency |
| Caching | Reducing duplicate queries | Expired and stale data |
| Database and table sharding | Expanding capacity and concurrency | Rugging, cross-shard queries, complex transactions |
| Asynchronization | Remove non-critical operations from requests | Final agreement and retry |

Prioritize optimizing queries and indexes before considering adding infrastructure. Sharding turns a database problem into a distributed system problem. 

## 7. Search with files

Databases are suitable for structured records and transactions, but not necessarily for all access modes. 

- Full-text search typically uses inverted indexes and dedicated search engines to handle word segmentation, relevance sorting, and aggregation. 
- Large files should be stored in object storage, while databases store metadata, permissions, and references. 
- Images, videos, and audio require format verification, size/duration limits, transcoding, and access control. 
- Search indexes are usually asynchronously synchronized with the main database, requiring tolerance for delays and rebuilds. 

Do not directly stuff large binary into the main database, nor only put records of transactions into the search index. Different storage holds different sources of fact, and boundaries must be clearly defined. 

## 8. System behavior during overload

The system should "degrade in an orderly manner" under high load, rather than collapse completely. It can be designed by priority: 

1. Retain critical paths such as login, payment, and core read. 
2. Reduce non-critical refresh and statistical frequency. 
3. Temporarily shut down high-cost export, recommendation, or batch tasks. 
4. Return "Try Later" for delayable tasks. 
5. Refusing obviously excessive requests at the entrance. 

Degradation must be visible: the client knows the result is incomplete, monitors the demotion status, and has clear conditions after recovery. 

## Checklist

- Whether you know the current QPS, concurrency, p95/p99 latency, and error rate. 
- Whether the concurrency model matches the nature of the task and whether there are calls to block event loops. 
- Whether timeouts are set in layers, and whether canceling can be passed downstream. 
- Check whether cache keys include permissions and tenant dimensions, and whether the invalidation policy is clear. 
- Whether it protects against penetration, breakdown, avalanches, and hotspot tilting. 
- Whether rate limiting has reasonable dimensions and whether the returned waiting time is executable. 
- Whether the queue is idempotent, retryable, traceable, and whether there is deadletter handling. 
- Whether the connection pool, thread pool, and queue all have upper limits. 
- Whether the search and files are properly stored and whether the source of the facts is unique. 
- Whether the business is downgraded during overload by business priority, rather than failing together.
