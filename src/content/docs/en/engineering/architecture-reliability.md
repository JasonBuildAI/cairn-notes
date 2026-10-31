---
title: "Distributed Systems and High Availability"
description: "From monoliths, microservices, CAP and consistency, to failover, disaster recovery, and graceful degradation."
---

As the system grows, what becomes is not "more servers," but more ways to fail. A local function call becomes a network request, a database transaction becomes state coordination among multiple services, and a single machine failure can affect the entire chain. The goal of architectural design is not to eliminate failures, but to make the system predictable and recoverable even in the event of local failures. 

## 1. When is it necessary to change the architecture?

A single entity is not outdated, and microservices are not a sign of maturity. The choice depends on: 

- Team size and ownership boundaries. 
- Whether modules need to be published independently or scaled. 
- Whether the fault requires isolation. 
- Data volume, request volume, and latency targets. 
- Deployment, observation, and operation capabilities. 
- Change frequency and rollback costs. 

If a system has only one team, one database, and business boundaries are unstable, modular monoliths are usually easier to evolve than splitting into a dozen services. Splitting services turns local calls, transactions, and code dependencies into distributed issues. 

### 1.1 Monoliths, Modular Monoliths, and Microservices

| Form | Advantages | Cost |
| --- | --- | --- |
| Monolithic | Simple deployment, direct calls, easy transactions | Module boundaries are prone to corruption, overall scaling capacity is scalable |
| Modular monolith | Retains the advantages of single deployment, with clearer boundaries | Still shares processes and databases, with limited isolation |
| Microservices | Independent deployment, on-demand scaling, team autonomy | Networking, data consistency, operations, and tracking complexity |

Breakdown should be based on business capabilities and data ownership, not by the technical layer into "user services, log services, and tool services." A service should be able to independently answer a set of business questions. 

### 1.2 Strangler Mode

When migrating from a single entity, there is no need to rewrite everything at once. Routes can be established at the boundary, gradually migrating some functions to new services, and after verifying stability, the scope can be expanded. The old implementation continues to run until the new implementation is completely replaced. This helps control risk, but in the short term, dual system consistency and traffic switching are required. 

## 2. Basic facts about distributed systems

Local calls usually assume: 

- The method will return. 
- Returns only success or exceptions. 
- Stable call time. 
- Both sides see the same memory. 
- Clock and sequence are consistent. 

After crossing networks, these assumptions are no longer reliable: 

1. The network may experience delays, packet loss, duplication, or partitioning. 
2. The request may arrive but the response is lost, and the caller cannot determine the result. 
3. The other person may be slow, rather than failing outright. 
4. Multiple services may see different data versions. 
5. The machine clock may drift. 
6. Nodes may restart and lose memory status. 

That's why remote calls must have timeouts, powers, retrys, and observability. A "no response" request may never arrive, or it may have already been executed successfully. 

## 3. CAP and consistency

CAP is often simplified to "consistency, availability, and partition tolerance of two out of three." More precisely: network partitioning is unavoidable; when partitioning occurs, the system must make trade-offs between consistency and availability. 

- **CP**: Rejects some requests during partitioning, ensuring that potentially erroneous data is not returned. 
- **AP**: Continues to respond during partitioning, but may return old data, and then converge by replication. 

In a normal network, the system can pursue both good availability and consistency; CAP discusses guarantees during partitioning. 

### 3.1 Consistency Model

| Model | Meaning |
| --- | --- |
| Strong consistency | Read always shows the latest committed write |
| Linearly consistent | All operations are executed in real-time order on a single replica |
| Consistent order | All nodes see the same order, but not necessarily the same time as the real time |
| Eventual consistency | After no new writes, replicas eventually converge to the same state |
| Read Your Own Writing | Users can read the results they just wrote |
| Monotonic Read | Users will not see the new value first and then read back to the old value |

Business usually doesn't need all data to be highly consistent. Account balances, inventory deductions, and permissions may require stronger assurance; Avatars, statistics, and recommendations can be accepted for temporary obsolescence. The key is to declare item by item, not label the entire system. 

### 3.2 Copying

Replication improves availability and readability, but also brings latency: 

- Master-Slave Replication: Writes to the master library, copied asynchronously or synchronously to the slave library. 
- Multi-master replication: Multiple nodes can be writable, making conflict resolution more complex. 
- Masterless replication: The client reads and writes to multiple replicas, using quorum to check consistency. 

Synchronous replication latency is higher but reduces loss; asynchronous replication responds faster but may lose the nearest write if the master fails. Replication delay can also cause the read to fail when the data was just written. 

### 3.3 Consensus

When multiple nodes need to agree on the same order, consensus algorithms such as Raft and Paxos are needed. Consensus can handle leader elections and log replication, but requires a majority of nodes to be available. Three nodes can usually tolerate one failure; The more nodes, the higher the cost of writing coordination. 

Application developers don't necessarily have to achieve consensus, but they should understand that dependent databases, configuration centers, or orchestration services may refuse to write due to losing the majority. 

## 4. Distributed transactions

### 4.1 Two-stage submission

The coordinator first prepares all participants, then submits or rolls back together. It provides strong atomicity, but coordinator failures, lock hold times, and network partitioning can cause system blockages, making cross-organizational systems especially difficult. 

### 4.2 Saga

Break down long tasks into a series of local tasks, with compensation actions at every step:

```text
Create order → Reserve inventory → Deduct payment → Ship
     ↘ Failure Compensation ← Release Inventory ← Refund
```

Compensation does not necessarily mean 'restoring the original state.' For example, a text message that has already been sent cannot be truly recalled. Saga needs to be idempotent, retryable, observable, and clearly indicate to users what the intermediate states mean.

### 4.3 Outbox

Database writes and message sending cannot simply be placed in the same transaction. The Outbox pattern first writes events to the outbox table in the business database, and then a background process reads and publishes them:

```text
Business writes + outbox write (within the same local transaction)
             ↓
        The sender reads the outbox
             ↓
        Message Queue/Event Bus
```

Consumers still need idempotency because delivery is usually at least once.

## 5. High Availability

"Several 9s" indicates the allowable proportion of downtime:

| Availability | Annual Downtime (Approx.) |
| --- | --- |
| 99% | 3.65 days |
| 99.9% | 8.77 hours |
| 99.99% | 52.6 minutes |
| 99.999% | 5.26 minutes |

Indicators must correspond to the service, region, and measurement method. An API returning 500 quickly does not mean it is actually usable by users; frontend dependence on third-party failures can also make the entire page unavailable.

### 5.1 Redundancy and Failover

- Multiple instances: Other instances take over when a single machine fails.
- Multiple availability zones: cross-zone switching in case of data center-level failures.
- Multiple regions: disaster recovery in case of geographical disasters or regional network failures.

Failover should respond:

- How is 'usable' determined in a health check?
- How long does the switch take?
- Does the new node have enough capacity to take over all the traffic?
- Are the configuration, keys, and data replication synchronized?
- Will switching back cause a secondary failure?

### 5.2 RPO and RTO

- **RPO (Recovery Point Objective)**: The maximum amount of data loss that can be tolerated.
- **RTO (Recovery Time Objective)**: How long it takes to restore service after a failure.

Backup frequency determines RPO, while recovery processes and infrastructure determine RTO. Simply backing up without drills cannot prove RTO. Recovery drills should include databases, object storage, configurations, keys, and application versions.

### 5.3 Health Check

Health checks cannot only look at whether a process is alive. A process may still be running, but the database connection pool could be exhausted, queues could be blocked, or dependencies could be unavailable. At the same time, health checks should not overly rely on external systems, otherwise dependency fluctuations could mark all instances as unhealthy at the same time.

Common splits:

- Liveness check: whether the process needs to be restarted.
- Readiness check: whether the instance can receive traffic.
- Startup check: Whether the slow-start application has completed initialization.

## 6. Resilience Mode

| Mode | Purpose | Main Risks |
| --- | --- | --- |
| Timeout | Prevent infinite waiting | Setting it too short may mistakenly terminate normal requests |
| Retry | Handle transient failures | Amplify traffic, repeat side effects |
| Backoff and Jitter | Avoid simultaneous retries | Requires maximum attempts and deadline |
| Circuit Breaker | Stop calling when dependent service continuously fails | Timing of recovery and false positives |
| Bulkhead | Isolated resource pool | Capacity allocation and utilization |
| Rate Limiting | Controlling Entry Rate | Collateral Damage, Fairness, and Retry |
| Downgrade | Retain core features | Does the user know the result is incomplete |
| Load Shedding | Actively Reject Excess Requests | Thresholds and Priorities |

Retries must be combined with idempotency and budget. How many times a request can be retried at most, how long each retry lasts, and the overall deadline should be designed uniformly at the entry point. If each layer retries three times, a single call could eventually be amplified into dozens of times.

### 6.1 Graceful Degradation

Low-priority requests fail first under high load:

1. Ensure login, payment, and core reading.
2. Reduce the frequency of non-core refreshes and statistics.
3. Pause recommendations, export, and batch recalculation.
4. For non-critical operations, return 'try again later'.

Downgrades should be observable and recoverable. You cannot quietly return empty data and make users think there is genuinely no content.

## 7. Service Communication and Governance

- Synchronous calls are suitable for requests that need immediate results, but they can propagate upstream delays and failures downstream.
- Asynchronous messages are suitable for decoupling, peak shaving, and long tasks, but they increase eventual consistency and duplicate processing.
- The API gateway is responsible for a unified entry point, authentication, routing, rate limiting, and protocol conversion, and should not bear all business logic.
- Service discovery allows callers to find instances, but the registry center also needs caching and fallback in case of failure.
- The configuration center centrally manages dynamic configurations and must have validation, versioning, auditing, and rollback.

The longer the synchronous chain, the more noticeable the tail latency. If a request calls 20 services, even if each service's p99 is good, the overall result may still exhibit a long tail. Calls that can be parallelized should be parallelized, tasks that can be asynchronous should be asynchronous, and necessary calls should have independent timeouts set.

## 8. Capacity and Failure Drills

Capacity planning minimum estimate:

- Peak QPS and concurrent requests.
- Single-request CPU, memory, database, and external dependency consumption.
- Data growth and retention period.
- Whether the remaining instances can handle all the traffic in case of failure.
- How long does scaling up take, and what are the costs of cold start and warm-up?

Stress testing should use request ratios, data scales, and dependency latencies close to real conditions. Testing only a simple health endpoint cannot prove the availability of the business chain.

Chaos exercises can proactively inject delays, instance failures, dependency errors, and network partitions, but should start in a controlled environment, with a small scope and low traffic, and include stop conditions and monitoring.

## 9. Architecture Decision Record

Architecture choices should be documented:

```text
Background and Constraints:
Considered options:
Decision:
Reason:
Cost and Risk:
Verification Criteria:
Rollback or exit conditions:
```

Decisions without records will be idealized in memory. In the future, when seeing 'why use a message queue,' at least you can know the goals and data at the time.

## Checklist

- Is the current complexity driven by actual constraints rather than following trends?
- Do service boundaries correspond to business capabilities and data ownership?
- Does each remote call have timeouts, retries, idempotency, and failure semantics?
- Are consistency requirements defined item by item for the data?
- Is the behavior clear for replication delay, partitions, and loss of consensus majority?
- Does cross-service flow have compensation, intermediate states, and queryable operation IDs?
- Are availability goals defined with metrics, measurement scope, and the real user perspective?
- Are RPO/RTO, backup recovery, and failover drills conducted?
- Are there circuit breakers, rate limiting, degradation, and priority-based offloading?
- Do architectural decisions include context, costs, and exit conditions?
