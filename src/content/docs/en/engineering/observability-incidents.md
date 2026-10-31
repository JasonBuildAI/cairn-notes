---
title: "Observability and Fault Handling"
description: "Use metrics, logs, and traces to prove the system state, and turn failures into reusable experience."
---

Observability is not about having "lots of logs," but about being able to infer internal states from external phenomena: why users fail, which layer causes request slowdown, which version introduced changes, and whether the system can continue to handle traffic. Fault handling involves restoring service first under conditions of incomplete information and limited time, then figuring out the cause.

## 1. Define What is Normal First

Without a normal baseline, monitoring relies only on intuition. Start by defining service metrics (SLI) from the user perspective:

- Request success rate.
- Response latency p50, p95, p99.
- Completion rate of key business processes.
- Data freshness and queue latency.
- Error budget and availability.

Then write targets as SLOs, for example, "In the past 30 days, 99.9% of login requests succeed within 1 second." An SLO is not just a decorative promise; it dictates when to stop releasing features and prioritize stability fixes rather than continuing to add features.

### 1.1 Error Budget

If the availability target is 99.9%, about 0.1% downtime is allowed in 30 days, approximately 43 minutes. The error budget is used for decision-making:

- When the budget is sufficient, risky but high-reward changes can proceed.
- When the budget is quickly consumed, first reduce release frequency and fix major faults.
- Do not ignore the experience of specific users just because the budget is not yet exhausted.

Metrics must distinguish between "server returned 200" and "user actually succeeded." Failures in asynchronous tasks, front-end script crashes, or third-party dependencies can cause user failures even if server metrics appear normal.

## 2. Three Core Signals

### 2.1 Metrics

Metrics are numerical aggregations over time, suitable for alerts and trends, but not for storing every detail.

Common types:

- **Counter**: Only increases, such as total requests or total errors.
- **Gauge**: Current value, such as number of connections or queue length.
- **Histogram**: Distribution by buckets, used for latency percentiles.
- **Summary**: Precomputed percentiles, must be careful when aggregating across instances.

High-cardinality labels can explode. User ID, request ID, full URL, and random parameters should not be used as standard metric labels; use limited dimensions and sampling/tracing to locate individual requests.

### 2.2 Logs

Logs are records of discrete events, suitable for explaining "what happened." Structured logs are usually easier to search than free text:

```json
{
  "time": "2026-10-31T12:00:00Z",
  "level": "error",
  "service": "api",
  "requestId": "req_123",
  "route": "POST /orders",
  "code": "DB_TIMEOUT",
  "durationMs": 5032
}
```

Log levels should be restrained. A large number of `debug` can slow down the system and increase storage costs. Sensitive fields must be desensitized; the complete request body, cookies, tokens, and personal information should not be written by default.

### 2.3 Trace

Trace describes which services a request passes through and how long each segment takes. A trace consists of multiple spans:

```text
HTTP POST /checkout                  320 ms
├── auth.validate                    5 ms
├── inventory.reserve              120 ms
│   └── db.query                    90 ms
├── payment.charge                 180 ms
│   └── external API               170 ms
└── order.persist                   12 ms
```

Spans should include service name, operation name, status, duration, and necessary attributes. Do not put sensitive data into spans. To propagate trace context across services, a unified standard and sampling strategy are needed.

## 3. Sampling and Correlation

Full data collection can be very costly. You can:

- Sample a low proportion of successful requests.
- Increase the sampling rate for errors, slow requests, and high-value business transactions.
- Generate a request ID at the entry point, and carry it through logs, metric exemplars, and traces.
- Ensure client errors, server logs, and backend traces can be correlated through the same ID.

Sampling means you cannot infer no errors from "not seeing errors." Alerts should prioritize aggregated metrics, and specific traces should be checked during troubleshooting.

## 4. Dashboards

Dashboards should serve specific service issues rather than putting all charts on a single page.

### 4.1 Service Overview

- Request volume.
- Success rate and error codes.
- Latency percentiles.
- Saturation: CPU, memory, connection pools, queues, disk.
- Dependency health.
- Release and configuration change markers.

### 4.2 Business Dashboards

- Order success rate.
- Breakdown of payment failures.
- Registration funnel.
- Task backlog and completion time.

### 4.3 Troubleshooting Dashboards

View anomalies by dependency, instance, version, region, and tenant. Charts should display time range, unit, and data source to avoid situations where "it looks higher" but cannot be explained.

## 5. Alerts

Good alerts meet the following criteria:

- Reflect real user impact or clear capacity risk.
- Have actionable steps.
- Include sufficient context and links.
- Avoid duplication and flapping.
- Have a responsible party and escalation path.

Alert based on symptoms; this is usually more effective than alerting on every internal metric. For example, "Payment success rate below threshold" is closer to user impact than "A thread pool queue length exceeds 10." Internal metrics can serve as clues for the cause.

### 5.1 Thresholds and Multiple Windows

Instantaneous peaks do not necessarily need to wake people up. Multi-window burn rate can be used: trigger urgent alerts when the error budget is consumed quickly in a short period, and create tickets when it is consumed slowly over a long period.

Alert thresholds should be based on baselines and business tolerance. Fixed `CPU > 80%` thresholds can lead to false alarms or miss failures such as "CPU only at 30% but all requests are queued."

## 6. Fault Handling Process

```text
Discovery → Triage → Hemostasis → Communication → Root Cause Analysis
     → Fix and Verify → Review → Improvements
```

### 6.1 Detection and Triage

First, confirm:

- Which users, regions, versions, and features are affected.
- The start time and recent changes.
- Whether it is a total failure, partial failure, or slowdown.
- Whether the current impact is still spreading.

Do not immediately pursue the root cause. Prioritize restoring availability while users are experiencing failures.

### 6.2 Stop the Bleed

Common measures:

- Roll back the recent release.
- Turn off feature toggles.
- Redirect traffic to healthy areas or older versions.
- Scale up or raise rate limits.
- Degrade non-core features.
- Pause batch or background tasks.

When stopping the bleed, also record the time and outcome of actions. Before taking a second action, confirm whether the first one was effective.

### 6.3 Communication

During an incident, provide stable updates:

- Current impact.
- Actions already taken.
- Next update time.
- What users need to do.

Do not fabricate conclusions when the root cause is unclear. Clearly stating "under verification" is more useful than incorrect attribution.

### 6.4 Recovery Verification

Metric recovery does not equal all data recovery. Check:

- Whether error rates and latency have returned to baseline.
- Whether queue backlogs have been processed.
- Whether failed requests can be retried or compensated.
- Whether data is consistent.
- Whether client caches and old versions are still affected.

## 7. Root Cause Analysis

The root cause is not a single isolated sentence. You can use the "Five Whys," but avoid simplifying complex system failures as human errors.

```text
Phenomenon: Decrease in payment success rate
Why: Payment service connection to database timed out
Why: Database connection pool exhausted
Reason: Slow queries increased and connections were not released in a timely manner
Why: Statistics were not updated after the new index went live
Why: The migration process does not include statistics checks
```

The last layer may be a process gap. The fix should cover code, configuration, monitoring, and release processes simultaneously.

## 8. Postmortem

The goal of the postmortem is not to assign blame, but to change the system. It should at least include:

- Timeline: when it was discovered, when decisions were made, and when recovery occurred.
- Scope and duration of impact.
- Direct triggers and contributing conditions.
- Which monitoring worked and which was missing.
- Which actions succeeded and which wasted time.
- Actionable improvements, responsible person, and deadline.

"Strengthen training" and "raise awareness" are usually unverifiable. Better improvements are "add statistics checks for migration", "add alerts for queue backlog", "reduce rollback time from 30 minutes to 5 minutes".

## 9. Performance and Capacity Observation

When latency increases, first distinguish between:

- Increased request volume.
- Single request slowing down.
- Dependency slowing down.
- Resource saturation.
- Queueing or lock waiting.
- Retry amplification.

Observe CPU, memory, disk I/O, network, connection pool, thread/coroutine count, queue length, and GC. Use a profiler to find hotspots; do not rely solely on code intuition.

Capacity testing should look at business flows and real data distribution. Stress testing the health check interface does not represent database queries, file uploads, or complex pages.

## 10. Runbook

Each critical service should have a concise, executable runbook:

```text
Service Uses and Dependencies
Key indicators and normal ranges
Common Faults and Diagnostic Methods
Rollback and Downgrade Steps
Data Recovery and Contact Information
Upgrade Path
```

Runbooks should be validated before failures occur, not opened for the first time during an incident. Commands, permissions, and links expiring can make the documentation ineffective at critical moments.

## Checklist

- Are there user-perspective SLIs, SLOs, and error budgets?
- Are metrics, logs, and traces associated through a request ID?
- Are logs structured, anonymized, and have a retention period?
- Do metric tags control cardinality?
- Do dashboards distinguish between overview, business, and troubleshooting?
- Do alerts correspond to user impact, and is there a person responsible with operational instructions?
- Are there multi-window error budgets and capacity alerts?
- In case of failure, can you quickly roll back, degrade, and switch traffic?
- Does post-mortem produce verifiable, traceable improvements?
- Do key services have validated runbooks and recovery drills?
