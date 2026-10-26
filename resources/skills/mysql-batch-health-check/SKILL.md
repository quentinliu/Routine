---
name: mysql-batch-health-check
version: 1.0.0
description: >
  Batch health inspection for multiple MySQL/TiDB instances. Checks connections, disk usage,
  replication status, slow query trends, and memory for all instances. Outputs a prioritized
  anomaly report with TOP N issues and actionable recommendations. Reduces full inspection
  from half a day to 10 minutes.
allowed-tools: db_query, db_get_status, db_get_variable
---

# MySQL Batch Health Check (Multi-Instance Inspection)

## Overview

DBAs managing large fleets (50-600+ instances) face an impossible task: manual health checks take hours and cover only a handful of critical instances, while problems fester on the unchecked ones. This skill performs **systematic batch inspection** across all instances — connections, disk, replication, slow queries, memory — and outputs a prioritized report sorted by urgency.

**Real-world result**: 600+ instances inspected in 10 minutes (vs. half a day manually) — **30x improvement**. Critical issues are surfaced immediately with actionable recommendations.

Key capabilities:
- Check **6 health dimensions** per instance: connections, disk, replication, slow queries, QPS, memory
- Score each instance on a **health index** (0-100)
- Sort by severity: critical → warning → healthy
- Output TOP N anomalous instances with root cause hints
- Track trends (compare with previous check if data available)

## When to Use

Apply this skill when:
- Morning health check / daily standup preparation
- After infrastructure changes (network, storage, config)
- Pre-holiday or pre-event capacity check
- User asks "how are my databases doing?"
- Periodic compliance inspection
- Onboarding new instances into fleet

## Required MCP Server

This skill requires access to multiple database instances. Two deployment patterns:

### Pattern A: Centralized CMDB + Proxy
A CMDB service provides the instance list, and each instance is accessible via a query proxy:

| Tool | Purpose |
|------|---------|
| `db_query` | Run health check SQL on each instance |
| `db_get_status` | Get status variables per instance |
| `db_get_variable` | Get configuration per instance |

### Pattern B: Single Instance Check
Run on one instance at a time. User specifies which instance to check:

```
User: "Check health of db-prod-01, db-prod-02, db-prod-03"
→ AI runs checks on each, aggregates results
```

### Required MySQL Privileges (per instance)

- `SELECT` on `information_schema.*`, `performance_schema.*`
- `PROCESS` — View all connections
- `REPLICATION CLIENT` — Check replication status

## Health Check Dimensions

### Dimension 1: Connection Health

```sql
-- Current and max connections
SHOW GLOBAL STATUS LIKE 'Threads_connected';
SHOW GLOBAL STATUS LIKE 'Max_used_connections';
SHOW GLOBAL STATUS LIKE 'Threads_running';
SHOW VARIABLES LIKE 'max_connections';

-- Connection usage rate
-- healthy: < 70%, warning: 70-85%, critical: > 85%
```

### Dimension 2: Disk / Storage Health

```sql
-- Table sizes (top 10 by total size)
SELECT
  TABLE_SCHEMA AS db_name,
  ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024 / 1024, 2) AS total_gb,
  ROUND(SUM(DATA_LENGTH) / 1024 / 1024 / 1024, 2) AS data_gb,
  ROUND(SUM(INDEX_LENGTH) / 1024 / 1024 / 1024, 2) AS index_gb
FROM information_schema.TABLES
WHERE TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
GROUP BY TABLE_SCHEMA
ORDER BY total_gb DESC
LIMIT 10;

-- Disk usage can also be obtained from monitoring system
-- if available via db_query or external API
```

### Dimension 3: Replication Health

```sql
-- Run on each replica
SHOW SLAVE STATUS\G

-- Key metrics:
--   Seconds_Behind_Master: {lag}
--   Slave_IO_Running: Yes/No
--   Slave_SQL_Running: Yes/No
--   Last_Error: {error}
```

### Dimension 4: Slow Query Trends

```sql
-- Slow query count and trend
SHOW GLOBAL STATUS LIKE 'Slow_queries';
SHOW VARIABLES LIKE 'long_query_time';

-- Recent slow queries count (last hour, if performance_schema available)
SELECT COUNT(*) AS slow_count_last_hour
FROM performance_schema.events_statements_summary_by_digest
WHERE SUM_TIMER_WAIT / COUNT_STAR > {long_query_time} * 1000000000000;
```

### Dimension 5: Query Throughput (QPS)

```sql
-- Queries per second
SHOW GLOBAL STATUS LIKE 'Questions';
SHOW GLOBAL STATUS LIKE 'Uptime';

-- QPS = Questions / Uptime
-- Compare with baseline (previous check) for trend
```

### Dimension 6: Memory / Buffer Pool

```sql
-- InnoDB buffer pool usage
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_pages_total';
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_pages_free';
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_read_requests';
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_reads';

-- Buffer pool hit rate
-- hit_rate = read_requests / (read_requests + reads) × 100%
-- healthy: > 99%, warning: 95-99%, critical: < 95%
```

## Scoring System

Each dimension contributes to an overall health score (0-100):

| Dimension | Weight | Scoring |
|-----------|--------|---------|
| Connections | 20% | 100 - (usage% × 0.5) |
| Disk | 25% | 100 - (usage% × 0.8) |
| Replication | 20% | 0 if lag > 600, 100 if 0, linear otherwise |
| Slow Queries | 15% | 100 - (growth% × 0.3), capped at 0 |
| QPS | 10% | Based on deviation from baseline |
| Buffer Pool | 10% | hit_rate% |

**Overall Health Score** = Σ(dimension_score × weight)

| Score | Status | Action |
|-------|--------|--------|
| 90-100 | ✅ Healthy | No action |
| 70-89 | 🟡 Attention | Review TOP issues |
| 50-69 | 🔴 Warning | Immediate investigation |
| < 50 | 🔴 Critical | Emergency intervention |

## Diagnostic Workflow

### Step 1: Collect Instance List

If multi-instance:
```sql
-- From CMDB or instance registry
-- Or user provides the list
```

### Step 2: Run Health Checks

For each instance, collect all 6 dimensions. Execute in parallel where possible.

### Step 3: Score and Sort

Calculate health score per instance, sort ascending (worst first).

### Step 4: Output Report

Present TOP N anomalous instances with details and recommendations.

## Output Templates

### Batch Report

```
🏥 MySQL Fleet Health Report
════════════════════════════
📋 Summary
  Total Instances: {total}
  ✅ Healthy: {count} ({pct}%)
  🟡 Attention: {count} ({pct}%)
  🔴 Warning: {count} ({pct}%)
  🔴 Critical: {count} ({pct}%)
  Scan Duration: {duration}

🔴 TOP {N} Anomalous Instances (sorted by urgency)
──────────────────────────────────────────────────

  1. {instance_id} · Health Score: {score}/100 🔴
  ┌────────────────────────────────────────────────┐
  │ Disk:     {usage}% 🔴 (daily growth {rate},     │
  │           estimated {days} days to full)         │
  │ Connections: {current}/{max} ({pct}%) 🟡         │
  │ Replication: {lag}s behind 🟡                    │
  │ Slow Queries: {count} (+{growth}% vs yesterday)  │
  │ Buffer Pool: {hit_rate}% hit rate                 │
  │                                                │
  │ ⚡ Priority Actions:                            │
  │ 1. [Immediate] Clear audit_log (>{size}GB)     │
  │ 2. [This Week] Adjust binlog retention 14d→7d  │
  │ 3. [Plan] Request disk expansion to 500GB      │
  └────────────────────────────────────────────────┘

  2. {instance_id} · Health Score: {score}/100 🟡
     Connections: 287/300 (95.7%) 🔴
     → Check connection pool leak in application
  ...

📊 Fleet Overview
  | # | Instance | Score | Disk% | Conn% | Repl Lag | Slow Q | Status |
  |---|----------|-------|-------|-------|----------|--------|--------|
  | 1 | {id}     | 42    | 92%🔴 | 78%   | 0s       | +340%  | 🔴     |
  | 2 | {id}     | 68    | 71%   | 96%🔴 | 0s       | normal | 🟡     |
  | 3 | {id}     | 73    | 65%   | 82%🟡 | 234s🟡   | normal | 🟡     |
  | ... (remaining healthy instances omitted) ...
```

### Single Instance Detail

When user asks for details on a specific anomalous instance:

```
🔍 Instance Detail: {instance_id}
════════════════════════════════════

💾 Disk Analysis
  Total: {total}GB | Used: {used}GB ({pct}%)
  Daily Growth: {rate}GB/day (↑12% vs last week)
  Estimated Full: {date} ({days} days)

  TOP 5 Space Consumers:
  | Database | Data (GB) | Index (GB) | Total (GB) |
  |----------|-----------|------------|------------|
  | audit_log_db | 120.5  | 2.1        | 122.6      |
  | trade_db     | 85.3   | 12.7       | 98.0       |
  | ...

🔗 Connection Analysis
  Current: 287/300 (95.7%) 🔴
  Peak Today: 298 (99.3%)
  TOP 5 Users:
  | User | Connections | Host Pattern |
  |------|------------|-------------|
  | app_user | 245 | 10.0.1.% |
  | ... |

  ⚠️ Connection pool near exhaustion. Likely cause:
     application connection leak. Recommend restarting
     affected app pods and checking pool config.

📋 Recommendations
  1. [Immediate] Clear audit_log data > 90 days → free ~54GB
  2. [Today] Check app_user connection leak on 10.0.1.x
  3. [This Week] Binlog retention 14d → 7d → free ~12GB
  4. [Plan] Disk expansion to 500GB
```

## Example Usage

**User**: "Check all instances health"

**AI**:
```
🏥 Fleet Health Report (600+ instances, 10 min scan)

✅ Healthy: ~550 instances
🟡 Attention: ~45 instances
🔴 Critical: 5 instances — investigating TOP 5 now

🔴 TOP 5 Anomalous:
  1. inst-21 · Disk 92.3% (4 days to full)
     → Action: Clear audit_log, free 54GB
  2. inst-35 · Connections 287/300 (pool near exhaustion)
     → Action: Check app connection leak
  3. inst-48 · Replication lag 234s (growing)
     → Action: Check master long queries
  4. inst-12 · Slow queries +340% vs yesterday
     → Action: Diagnose slow queries
  5. inst-67 · Memory 89% (near OOM)
     → Action: Check buffer pool, large queries

Recommend: Handle #1 (disk) and #3 (replication) first.
```

**User**: "Give me details on #1"

**AI**: *(shows Single Instance Detail report with disk breakdown)*

## Best Practices

### Fleet Health Check Schedule

| Frequency | Scope | Purpose |
|-----------|-------|---------|
| Every 30 min | Connection + replication on critical instances | Early warning |
| Daily | Full 6-dimension check on all instances | Morning standup |
| Weekly | Trend analysis + capacity forecast | Planning |
| Monthly | Schema review + index audit | Maintenance |

### Alert Thresholds (Recommended)

| Metric | Warning | Critical |
|--------|---------|----------|
| Disk usage | 80% | 90% |
| Connection usage | 80% | 90% |
| Replication lag | 60s | 300s |
| Slow query growth | +50% | +200% |
| Buffer pool hit rate | < 99% | < 95% |
| QPS deviation | ±30% | ±50% |

## Quick Reference

| Check | Query |
|-------|-------|
| Connections | `SHOW STATUS LIKE 'Threads_connected'` + `SHOW VARIABLES LIKE 'max_connections'` |
| Disk | `SELECT ... FROM information_schema.TABLES GROUP BY TABLE_SCHEMA` |
| Replication | `SHOW SLAVE STATUS` |
| Slow queries | `SHOW STATUS LIKE 'Slow_queries'` |
| QPS | `SHOW STATUS LIKE 'Questions'` / `SHOW STATUS LIKE 'Uptime'` |
| Buffer pool | `SHOW STATUS LIKE 'Innodb_buffer_pool%'` |
| Health score | Calculated from above dimensions |

**Use this skill for systematic multi-instance health inspection — catch problems before they become incidents.**
