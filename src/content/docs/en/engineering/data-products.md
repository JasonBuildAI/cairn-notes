---
title: "Metrics, Experiments, and Data Governance"
description: "From event definitions, statistical metrics, and A/B testing, to visualization, data lineage, and warehouse layering."
---

Data products are not just 'turning database queries into charts.' A reliable metric must go through event collection, cleaning, definition, aggregation, presentation, and interpretation. If any step in between is vague, the chart is just a visually appealing but non-reproducible number.

## 1. Start with events

Event tracking describes what happens to users in the system. An event should at least answer:

- Who triggered it: anonymous user, logged-in user, device, or service.
- When it happened: event time and server reception time.
- Where it happened: page, module, client version, region.
- What happened: event name and action.
- What was the outcome: success, failure, error code, duration.
- What it is associated with: session, request, order, or experimental group.

```json
{
  "event": "checkout_completed",
  "userId": "u_123",
  "sessionId": "s_456",
  "occurredAt": "2026-10-31T12:00:00Z",
  "properties": {
    "orderId": "o_789",
    "amountCents": 19900,
    "currency": "CNY"
  }
}
```

### 1.1 Event Naming and Schema

Event names should be stable, searchable, and reflect facts that have already occurred. `checkout_completed` is more analyzable than `click`. Attributes need to be uniformly defined:

| Attribute | Recommended Format | Notes |
| --- | --- | --- |
| Time | ISO 8601 or unified timestamp | Specify time zone; differentiate event time and storage time |
| Amount | Integer in smallest currency unit + currency | Avoid floating point and currency confusion |
| ID | String or clearly defined integer range | Prevent client-side precision loss |
| Enum | Limited value list | Consider old reports when adding new values |
| Device/Version | Structured field | Facilitates comparison before and after release |

Event schemas should be versioned and validated. Changing a field type from number to string, altering its meaning, or suddenly introducing many null values can break subsequent analytics.

### 1.2 Client-side and Server-side Events

Client-side events capture UI interactions but may be lost, duplicated, or tampered with. Server-side events are more reliable but do not show user clicks or page behaviors. Key business outcomes usually rely on server-side events, while client-side events are used for behavioral analysis.

Collection also needs to consider user consent, privacy, data retention, and deletion requests. Sensitive information should not be collected indefinitely just for "analytics needs."

## 2. Metric Definition

Metrics must be repeatable:

```text
Metric: Payment Success Rate
Audience: Logged-in users who initiated a payment in the past 24 hours
Numerator: Number of successful payment events
Denominator: Number of payment attempt events
Remove duplicates: by payment_id
Exclusions: test accounts, duplicate callbacks
Time: Bucketed by event time, UTC 8 display
```

Without these definitions, indicators with the same name can yield different numbers in different hands.

### 2.1 Count, Proportion, and Rate

- Count: number of events, number of active users.
- Proportion: conversion rate, error rate, retention rate.
- Rate: requests per second, orders per minute.
- Distribution: p50, p95, p99, maximum.
- Cumulative value: total number of users, total transaction amount.

The denominator of a proportion should match the question. Using "all registered users" as the denominator for active rate will give a completely different conclusion compared to using "users who logged in during the past 7 days."

### 2.2 Mean, Median, and Distribution

The mean is affected by extreme values, while the median is more robust. Income, latency, and content length often have significant long tails; looking only at the average can conceal poor experiences for a large number of users.

Standard deviation describes the dispersion of a distribution but is not suitable for all long-tailed distributions. When necessary, histograms, quantiles, and grouped distributions should be examined.

### 2.3 Aggregation

Aggregation usually follows the "split—compute—combine" approach:

```sql
SELECT country, COUNT(DISTINCT user_id) AS active_users
FROM events
WHERE event = 'app_opened'
  AND occurred_at >= now() - interval '7 days'
GROUP BY country;
```

The more grouping dimensions there are, the sparser the dimension combinations become. High-cardinality tags will consume a large amount of storage and query resources, so dimensions should be limited and default groups defined.

## 3. Funnels and Retention

### 3.1 Funnels

A funnel describes the proportion of users who complete a set of ordered steps:

```text
Browse Products → Add to Cart → Start Checkout → Payment Successful
```

Each step needs to be defined:

- Does it have to be in order?
- How long is the time window.
- Does repeating the steps by the same user count as one time or multiple times?
Does leaving midway and then returning count as continuous?
- Whether cross-device is allowed.

Funnel analysis can identify 'at which step users drop off,' but it cannot directly explain the reasons. It should be combined with segmentation, error logs, page performance, and user feedback.

### 3.2 Retention

Retention measures whether users return after a period of time. A common definition is that they still perform key actions on the 1st, 3rd, 7th, and 30th days after first use.

Retention curves are affected by product type, customer acquisition channels, seasonality, and version changes. When comparing different cohorts, the same time window and behavior definitions must be used; otherwise, an 'improved retention' may simply be due to a change in statistical criteria.

## 4. A/B Testing

A/B testing randomly assigns users to at least two groups to compare the impact of a certain change on metrics.

### 4.1 Randomization

Randomization should be based on a stable user or device ID, rather than re-randomizing with each request. Otherwise, the same user will jump between versions, contaminating both experience and metrics.

The diversion layer should consider:

- Whether the experiments are mutually exclusive.
- Does the same experiment cover both the client and the server?
- Should new users and existing users be separated?
- Whether to maintain consistency across devices.

### 4.2 Hypotheses, Indicators, and Sample Size

Write clearly before the experiment starts:

- The hypothesis to be tested.
- Main indicators and guardrail indicators.
- Minimum detectable effect.
- Significance level and statistical power.
- Expected sample size and duration of the experiment.
- Stop rules in case of failure or exceptions.

When the sample size is insufficient, observed differences may be just random fluctuations; frequently peeking and stopping at any time can increase false positives. You can design experiments using methods like sequential testing, but you cannot treat an ordinary A/B test as a game that can be stopped at any time.

### 4.3 Confidence Intervals and p-values

The p-value represents 'the probability of observing the current or more extreme results if the null hypothesis is true,' and is not equal to 'the probability that the new version is better.' Confidence intervals express the range of effect sizes and usually provide more information than just looking at whether the result is significant.

The business also needs to assess the effect size. Although it is statistically significant, if the conversion rate only increases by 0.01%, it may not be worth adding complexity and maintenance costs.

### 4.4 Common Pitfalls

- **Multiple comparisons**: When looking at many indicators at the same time, something significant will eventually appear by chance.
- **Novelty Effect**: Users are temporarily more active with any changes.
- **Selection bias**: Groups are not randomized or only completers are analyzed.
- **Sample Ratio Mismatch (SRM)**: The actual traffic split deviates significantly from the expected ratio, indicating a problem with the experiment mechanism.
- **Interference effect**: The behavior of users in one group affects another group, for example, shared inventory and social networks.
- **Metric drift**: Other features are released or external events occur during the experiment.

## 5. Data Visualization

Charts are not decorations, but information encoding. First determine the question, then choose the graphic:

| Question | Suitable Graphics |
| --- | --- |
| Comparison Category | Bar Chart |
| Look at trends | Line chart |
| View Distribution | Histogram, Box Plot, Scatter Plot |
| Composition | Stacked bar chart; pie chart is only suitable for a small number of parts |
| Look at Relationship | Scatter Plot |
| View Conversion Steps | Funnel Chart |
| Time Interval | Area Chart or Line Chart with Confidence Interval |

### 5.1 Readability Principle

- Do not arbitrarily truncate the axes, especially in bar charts.
- The units, time range, and sample size are written on the figure.
- Colors should have meaning, and color-blind users should be considered.
- Use consistent scales and time windows across the same dashboard.
- Do not use 3D perspective to distort proportions.
- Write the chart title as a conclusion or question, not just 'Data Chart'.
- Missing data should be clearly displayed and cannot be replaced with 0.

### 5.2 Dashboard

A good dashboard serves decision-making first, then displays data. Distinction:

- Real-time operating status.
- Daily/weekly trends.
- Long-term business health.
- Exploratory analysis.

Key metrics should be drillable down to definitions, groupings, and data sources. Otherwise, the charts will only provoke disputes.

## 6. Data Warehouse Layering

A common layering is ODS → DWD → DWS → ADS:

| Layer | Function |
| --- | --- |
| ODS | Raw data close to the source system |
| DWD | Cleaning, Unifying, Detailing Facts |
| DWS | Summarized by Topic and Granularity |
| ADS | Application data for reports and products |

Layering is not a mandatory standard; the core is to give raw data, cleaning logic, and business definitions a clear place. Do not directly copy a large amount of source system details in the report SQL, otherwise the definitions cannot be reused.

### 6.1 Fact Tables and Dimension Tables

- **Fact table** records measurable business events, such as orders, clicks, and payments, and usually contains dimension keys and time.
- **Dimension tables** describe 'who, what, where,' such as users, products, regions, and channels.

The granularity must be clear: does one row represent an order, an order item, or a daily summary per user? Mixing granularities can cause double counting.

## 7. Data Governance

### 7.1 Quality Dimensions

| Dimension | Question |
| --- | --- |
| Completeness | Are required fields missing |
| Accuracy | Whether it is consistent with real business |
| Consistency | Whether different systems have the same definition |
| Uniqueness | Whether duplicate entities appear |
| Timeliness | When data is available, how much delay |
| Validity | Whether enumeration, range, and format are valid |

Data quality requires monitoring, verification, and a person in charge. Simply checking tables manually after errors occur does not count as governance.

### 7.2 Data Lineage

Where the lineage description data comes from, which tasks it goes through, and which reports it flows to. In case of an anomaly, it can answer:

- Which source system field changed.
- Which cleaning task failed.
- Which downstream indicators are affected.
- What needs to be rerun after the fix.

Without blood relation, modifying a single field might cause multiple departments to find the reports completely wrong only the next day.

### 7.3 Metadata and Permissions

Metadata includes table structure, field meaning, person in charge, update frequency, sensitivity level, and lifecycle. Data permissions should be designed according to role, dataset, and row/column level, audit access records, and be promptly revoked upon resignation or project completion.

## 8. The Basic Sequence of Data Analysis

1. Rewrite business problems into computable problems.
2. Specify the population, time window, indicators, and exclusion criteria.
3. Check data quality and sample size.
4. Perform overall and grouped analysis.
5. Verify using graphs and statistical methods.
6. Distinguish correlation from causation and design experiments.
7. Record conclusions, limitations, and reproducible queries.

## Checklist

- Are the event name, attributes, time, and deduplication rules consistent?  
- Do the metrics have repeatable numerators, denominators, populations, and time windows?  
- Are distributions and percentiles checked, rather than only looking at the mean?  
- Are funnel and retention definitions consistent, and are cross-day and repeated steps handled?  
- Is the A/B test randomized, with pre-set sample sizes and stopping rules?  
- Are diversion ratios, multiple comparisons, and novelty effects checked?  
- Are chart axes, units, sample sizes, and missing values clearly indicated?  
- Are the warehouse layers and fact table granularity clear?  
- Is there data quality monitoring, lineage, responsible parties, and access auditing?  
- Are conclusions accompanied by queries, versions, and limitations, and are they reproducible?
