---
title: "Database and Data Storage"
description: "From relational models, SQL, indexes, and transactions, to the choice of NoSQL, search, and object storage."
---

A database is the system's formal answer to the question of 'which facts must be preserved long-term.' Code can be restarted, caches can be lost, and logs can be rotated; orders, users, and states in a database usually need to be recoverable, queryable, and consistent. 

Before choosing storage, clearly define the access patterns: who writes, how frequently it is written, under what conditions it is read, how stale data can be allowed, the size of the data and retention period, and how much can be lost in case of failure. Different storage options simply make different trade-offs between read/write cost, consistency, query capability, and operational complexity.

## 1. Data Model Comes Before the Database

Before designing tables, you should first identify entities, attributes, relationships, and constraints.

```text
User 1 ─── N Order 1 ─── N OrderItem
                         │
                         └── N Product
```

- **Entities**: Users, orders, products.
- **Attributes**: Order status, amount, creation time.
- **Relationships**: A user has multiple orders, an order contains multiple items.
- **Constraints**: An order must have a user, quantity must be greater than zero, and after payment it cannot revert to an uncreated state.

If the boundaries of entities and business constraints are not well thought out, switching databases will only change one way of creating confusion.

## 2. Basic structure of relational databases

Relational databases represent data using tables, rows, and columns, and maintain structure with primary keys, foreign keys, unique constraints, and check constraints.

```sql
CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled')),
  total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.1 Primary Keys and Foreign Keys

- **Primary Key** uniquely identifies a row and must be stable and non-reusable.
- **Foreign Key** ensures that the referenced object exists but comes with costs such as locking, cascading deletes, and cross-table checks.
- **Unique Constraint** prevents duplicates, for example, a user can only have one default address.
- **Check Constraint** places simple invariants in the database, but complex business rules are usually still handled at the application layer.

Using mutable fields like email or phone numbers as primary keys makes associations and migrations complicated. Surrogate keys are more stable, and business uniqueness should be ensured with separate unique indexes.

### 2.2 NULL is Not an Empty String

`NULL` represents unknown or non-existent values and usually does not equal any value in comparisons, including another `NULL`. The result of `NULL = NULL` is not true. Queries should use `IS NULL` or `IS NOT NULL`.

When designing fields, be clear: unknown, empty, and default values are not the same thing. `0`, `''`, and `NULL` have different business meanings and should not be mixed.

## 3. SQL and Queries

SQL is a declarative language: it describes what you want to obtain, and the database decides how to execute it.

```sql
SELECT o.id, o.status, o.total_cents
FROM orders o
WHERE o.user_id = $1
  AND o.status = 'paid'
ORDER BY o.created_at DESC
LIMIT 20;
```

### 3.1 Joins

Joins combine multiple tables according to relationships:

- `INNER JOIN` Keeps only the rows that match on both sides.
- `LEFT JOIN` Keeps all rows from the left table; when there is no match in the right table, it is `NULL`.
- `RIGHT JOIN` Is the opposite direction.
- `FULL OUTER JOIN` Keeps all rows from both sides, which many databases or businesses do not need.

Omitting join conditions will result in a Cartesian product and a surge in the number of rows. When looking for "rows without related records," use `LEFT JOIN ... WHERE right.id IS NULL`, and do not mistakenly put the filter condition in `WHERE` which would remove the outer join semantics.

### 3.2 Aggregation and Grouping

```sql
SELECT status, COUNT(*) AS order_count, SUM(total_cents) AS amount
FROM orders
WHERE created_at >= now() - interval '7 days'
GROUP BY status;
```

`WHERE` Filter rows before grouping, `HAVING` filter groups after grouping. For aggregation queries, you need to specify the time range, time zone, and duplication calculation rules; otherwise, the report numbers will be difficult to interpret.

### 3.3 Pagination and Stable Sorting

`OFFSET` Pagination may repeat or skip when data changes, and when the offset is large, the database still needs to locate and discard the preceding rows. Cursor pagination uses stable sorting:

```sql
SELECT id, created_at
FROM orders
WHERE (created_at, id) < ($1, $2)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

It is best for the sort column to have an index, and to add a unique column to break ties. Otherwise, the order of identical timestamps is unstable.

## 4. Indexes: Trading Write Costs for Query Speed

Without indexes, the database may scan the entire table. Indexes maintain an additional structure that allows the database to quickly locate target rows. The cost is space consumption and the need to maintain the index during inserts, updates, and deletes.

### 4.1 B-Tree

Common indexes in relational databases use B-Trees. It is an ordered multi-level tree, where non-leaf nodes store keys and child node pointers, and leaf nodes store keys and row locations. Leaf nodes are usually linked, suitable for:

- Equality queries.
- Range queries.
- Sorting.
- Prefix matching.

Hash indexes are only suitable for equality lookups and do not perform well for ranges and sorting. Full-text, vector, and spatial indexes each have their own data structures.

### 4.2 Composite Index and Leftmost Prefix

Composite indexes `(user_id, status, created_at)` usually can support:

- `user_id`
- `user_id + status`
- `user_id + status + created_at`

But usually cannot efficiently utilize the whole index directly from `status` or `created_at`. The order of fields depends on the query pattern and selectivity, not just placing the most commonly used field first.

Performing function calculations, implicit type conversions, or using leading/trailing wildcards on index columns may prevent the database from using the index.

```sql
-- Unable to use created_at index
WHERE DATE(created_at) = '2026-10-31'

-- Change to range condition
WHERE created_at >= '2026-10-31'
  AND created_at < '2026-11-01'
```

### 4.3 Covering Index and Table Lookup

If the index already contains all the columns needed by the query, the database may not need to read back from the main table. This is called a covering index. It reduces random I/O, but overly wide indexes increase write and storage costs.

### 4.4 Execution Plan

Don't judge whether an index is effective based on intuition. Use `EXPLAIN` or the database's execution plan tool to observe:

- Whether a full table scan occurs.
- Which index is used.
- Estimated vs. actual number of rows scanned.
- Whether excessive sorting, temporary tables, or nested loops occur.
- The estimated cost of each step.

Outdated statistics, skewed data distribution, and parameter values can all affect the plan. Slow queries should be analyzed with real parameters and database version in mind.

## 5. Transactions

A transaction treats a set of operations as a single logical unit: either all are committed, or all are rolled back.

```sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;
```

If the second operation fails, the first one should also roll back, otherwise the money will disappear. Transaction boundaries should be around business invariants, not around individual SQL statements.

### 5.1 ACID

| Feature | Meaning |
| --- | --- |
| Atomicity | A set of operations either all succeed or all fail |
| Consistency | Database constraints and business invariants are satisfied before and after the transaction |
| Isolation | Concurrent transactions are isolated from each other according to certain rules |
| Durability | Once committed, data can be recovered even after a failure |

Different databases have different default isolation levels, and applications must be aware of which one they rely on.

### 5.2 Concurrency Anomalies

- **Dirty Read**: Reading data that another transaction has not yet committed.
- **Non-repeatable Read**: Reading the same row twice in a transaction yields different results.
- **Phantom Read**: A new row appears upon the second query with the same condition.
- **Lost Update**: Two transactions modify based on old values, the later write overwrites the earlier one.
- **Write Skew**: Two transactions each satisfy their own constraints, but together they violate a global invariant.

### 5.3 Isolation Levels

| Level | General Effect | Cost |
| --- | --- | --- |
| Read Uncommitted | Weakest isolation, may have dirty reads | High concurrency but unreliable results |
| Read Committed | Usually avoids dirty reads | May see different versions within the same transaction |
| Repeatable Read | Repeated reads in the same transaction are usually stable | Implementation depends on the database; write skew may still occur |
| Serializable | Strongest isolation | Highest cost in conflicts, retries, and throughput |

Do not assume that level names behave exactly the same across all databases. PostgreSQL, MySQL, and SQL Server have differences in snapshot and lock implementations; consult the specific database documentation.

### 5.4 Locks and MVCC

Locks prevent conflicts in concurrent modifications but bring waiting and deadlocks. MVCC (Multi-Version Concurrency Control) keeps multiple versions, allowing reads without waiting for writes, but increases storage and cleanup costs.

Common ways to handle deadlocks are to catch database errors, automatically retry the entire transaction, and ensure the retry logic is idempotent. Re-running only a single SQL statement within a transaction is not allowed.

### 5.5 Optimistic Locking and Pessimistic Locking

- Pessimistic locking locks first and then modifies, suitable for frequent conflicts where concurrent operations must be immediately blocked.
- Optimistic locking reads a version number and checks at commit whether the version has changed; conflicts require retrying. Suitable for long processes with fewer conflicts.

```sql
UPDATE documents
SET content = $1, version = version + 1
WHERE id = $2 AND version = $3;
```

A 0 affected row usually indicates a version conflict, which should inform the user or reload rather than override. 

## 6. Schema design and migration

### 6.1 Normalization and Counter-Normalization

Normalization reduces duplicate data, keeping a fact in one place. Denormalization copies commonly used fields across multiple locations, reducing connection or query costs but increasing synchronization responsibilities. 

Reasonable denormalization usually has clear trigger conditions, such as reading more than writing required, report performance, or snapshot history. Before copying fields, ask: Who is the source of fact, and how to fix updates if they fail. 

### 6.2 Field Types

- Amounts use the smallest integer unit or exact decimal, without binary floating-point. 
- Time clearly defined by time zone; Cross-region systems usually save UTC and convert when displayed. 
- Enumerations can be made using constraints or dictionary tables, avoiding spelling and illegal values. 
- Large text and large binary objects are generally not suitable for the high-frequency main table. 
- When transmitting large integer IDs externally, pay attention to client accuracy. 

### 6.3 Migration

Migration is not just `ALTER TABLE`. Considerations include: 

- Locking and time spent on large table addition, retype, and indexing. 
- Compatibility when both new and old code run simultaneously. 
- Data backfill batches, breakpoints, and speed limits. 
- Is rollback feasible, and is backup mandatory first? 
- Whether the migration script is idempotent, and whether the execution version is recorded. 

One safe mode is "extend—migrate—contract": first add compatible structures, doublewrite or backfill, switch reads, and after confirming stability, delete old structures. 

## 7. Not just relational databases

### 7.1 Document Database

Document-based units are suitable for objects with flexible structures that are frequently read as a whole. The downside is that cross-document relationships, transactions, and consistency are usually more complex. Documents are not a reason to "just stuff JSON" into the document; schema evolution and indexing are still needed. 

### 7.2 Key-Value Storage

Reading and writing by key is simple, horizontally scalable, suitable for caching, sessions, and simple mapping. Complex queries usually require the application to maintain the index itself. 

### 7.3 Wide-column databases

Organized by partition keys and column families, suitable for large-scale writes and known key queries. Data modeling revolves around query paths, and cross-partition queries are costly. 

### 7.4 Graph Database

Expressing relationships with nodes and edges is suitable for multi-hop relationships, paths, and recommendations. Common ordinary relationship tables can also represent graphs, but are only worth introducing when the query mode is primarily multi-hop traversal. 

### 7.5 Time Series Database

Optimized for timestamps, labels, and aggregated queries, suitable for metrics, monitoring, and event data. Retention periods, downsampling, and query windows need to be designed in advance. 

### 7.6 Search Engines

Inverted indexes support full-text retrieval, word segmentation, relevance, and aggregation. They are usually not sources of fact but query indexes synchronized asynchronously from the main database. Handle index latency, reconstruction, permission synchronization, and deletion. 

### 7.7 Object Storage

Suitable for images, videos, backups, and large files. The database stores object keys, metadata, owners, access policies, and lifecycles. Do not cram large file contents into the database row, nor assume that the object storage URL is naturally public and secure. 

## 8. Store the selection matrix

| Requirements | Priority | Key Issues |
| --- | --- | --- |
| Transactions and complex queries | Relational databases | Constraints, indexes, isolation, and migration |
| Simple key-value access | KV / cache | Expired, capacity, consistency |
| Flexible documentation | Document database | Schema evolution and cross-document consistency |
| Full-text search | Search engine | Synchronization, word segmentation, relevance, and permissions |
| Large files | Object storage + metadata tables | Access control, lifecycle, direct upload |
| Multi-hop relationships | Graph databases or relational models | Query patterns and scale |
| Indicator time series | Time series database | Label base, retention period, downsampling |

## 9. Backup, Restore and Consistency

Backups are only valid if they are successfully restored. Regular drills are required: 

- Backup frequency and retention period. 
- A combination of full, incremental, and log backups. 
- How long recovery will take and how much data can be lost. 
- Whether backups are encrypted and who can access them. 
- After recovery, the app is connected to the correct environment. 
- Whether there are isolated copies in accidental deletion and extortion scenarios. 

Master-slave replication can improve availability and readability, but there is copying delay. Reading from the replica right after writing may not be visible. When "reading to what you just wrote," you need to route to the master or use conformance tags. 

## Checklist

- Whether to specify the access mode before selecting the storage type. 
- Whether the primary key, foreign key, unique constraint, and NULL semantics are clear. 
- Query whether there is stable sorting and pagination boundaries. 
- Slow queries: Check execution plans instead of adding indexes based on intuition. 
- Whether the index matches the query order, and whether write costs are assessed. 
- Whether transactions revolve around business invariants and whether the isolation level is clearly defined. 
- Whether to handle lost updates, conflicting retrys, and deadlocks. 
- Whether the field type is suitable for amount, time, ID, and binary data. 
- Whether migration supports parallel and backfilling of old and new versions. 
- Have backups been rehearsed for recovery, and are RPO and RTO known?
