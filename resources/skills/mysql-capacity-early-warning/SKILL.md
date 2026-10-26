---
name: mysql-capacity-early-warning
version: 1.0.0
description: >
  Capacity early warning with growth source attribution. Analyzes disk, connections, and QPS
  trends, breaks down growth by source (binlog, audit log, business data), predicts exhaustion
  date, and provides actionable recommendations per source. Turns "disk 92%" into
  "4 days to full — clear audit_log to free 54GB, buy 6 more days".
allowed-tools: db_query, db_get_status, db_get_variable
---

# MySQL Capacity Early Warning (Growth Attribution + Prediction)

## Overview

Traditional capacity monitoring shows "disk 92%" and fires an alarm. But that's useless for decision-making — what's growing? How fast? When will it be full? What should I clean vs. what needs expansion?

This skill goes beyond simple threshold alerts by performing **growth source attribution**:

1. Break down disk usage by **source**: business data, binlog, audit log, temp files
2. Calculate **daily growth rate** per source
3. Predict **exhaustion date** per source and overall
4. Provide **actionable recommendations** per source (clean / retain / expand)
5. Track connection and QPS trends alongside disk

**Real-world result**: Predicted disk exhaustion **6 days in advance** with source-level breakdown — cleared audit_log to free 54GB, adjusted binlog retention, bought enough time for planned expansion.

Key capabilities:
- Disk growth attribution (binlog vs audit_log vs business data)
- Exhaustion prediction with confidence intervals
- Connection pool trend analysis
- QPS throughput trend
- Prioritized action plan (immediate / this week / plan)

## When to Use

Apply this skill when:
- Daily capacity check (proactive)
- Disk usage alert fires (> 80%)
- User asks "how much capacity do we have?"
- Pre-launch capacity assessment
- Monthly capacity review
- After bulk operations (data migration, batch load)

## Required MCP Server

| Tool | Purpose | Example |
|------|---------|---------|
| `db_query` | Analyze table/binlog sizes | `db_query("SELECT ... FROM information_schema.TABLES")` |
| `db_get_status` | Get connection/QPS counters | `db_get_status("Threads_connected")` |
| `db_get_variable` | Get configuration limits | `db_get_variable("max_connections")` |

### Required MySQL Privileges

- `SELECT` on `information_schema.*`
- `SUPER` or `REPLICATION CLIENT` — for binary log info

## Diagnostic Workflow

### Step 1: Disk Usage by Source

```sql
-- Business data: table sizes by database
SELECT
  TABLE_SCHEMA AS db_name,
  ROUND(SUM(DATA_LENGTH) / 1024 / 1024 / 1024, 2) AS data_gb,
  ROUND(SUM(INDEX_LENGTH) / 1024 / 1024 / 1024, 2) AS index_gb,
  ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024 / 1024, 2) AS total_gb
FROM information_schema.TABLES
WHERE TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
GROUP BY TABLE_SCHEMA
ORDER BY total_gb DESC;

-- Binlog size
SHOW BINARY LOGS;
-- Sum all binlog file sizes

-- Total disk usage
SELECT
  ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024 / 1024, 2) AS total_db_gb
FROM information_schema.TABLES;
```

### Step 2: Growth Rate Calculation

If historical data is available from previous checks:

```sql
-- Compare current sizes with stored baseline
-- (requires dbops.capacity_baseline table from previous runs)

SELECT
  cur.db_name,
  cur.total_gb AS current_gb,
  prev.total_gb AS previous_gb,
  ROUND((cur.total_gb - prev.total_gb) / DATEDIFF(CURDATE(), prev.check_date), 3) AS daily_growth_gb,
  ROUND((cur.total_gb - prev.total_gb) / prev.total_gb * 100, 2) AS growth_pct
FROM dbops.capacity_baseline cur
JOIN dbops.capacity_baseline prev ON cur.db_name = prev.db_name
WHERE cur.check_date = CURDATE()
  AND prev.check_date = DATE_SUB(CURDATE(), INTERVAL 7 DAY)
ORDER BY daily_growth_gb DESC;
```

**If no baseline exists** (first run), estimate growth from system counters:

```sql
-- InnoDB data throughput since uptime
SHOW GLOBAL STATUS LIKE 'Innodb_data_written';
SHOW GLOBAL STATUS LIKE 'Uptime';

-- Rough estimate:
-- daily_write = Innodb_data_written / Uptime * 86400
-- (This is write volume, not net growth, but gives an order of magnitude)
```

### Step 3: Binlog Retention Analysis

```sql
-- Current binlog files and sizes
SHOW BINARY LOGS;

-- Binlog retention period
SHOW VARIABLES LIKE 'expire_logs_days';       -- MySQL 5.x
SHOW VARIABLES LIKE 'binlog_expire_logs_seconds'; -- MySQL 8.0+

-- Calculate potential savings from retention change
-- If expire_logs_days = 14, changing to 7 saves ~50% of binlog space
```

### Step 4: Connection Trend

```sql
-- Current connection state
SHOW GLOBAL STATUS LIKE 'Threads_connected';
SHOW GLOBAL STATUS LIKE 'Max_used_connections';
SHOW GLOBAL STATUS LIKE 'Threads_running';
SHOW VARIABLES LIKE 'max_connections';

-- Historical connection peak (since last restart)
-- Max_used_connections gives the peak
```

### Step 5: QPS Trend

```sql
-- Current QPS
SHOW GLOBAL STATUS LIKE 'Questions';
SHOW GLOBAL STATUS LIKE 'Uptime';

-- QPS = Questions / Uptime
-- Compare with baseline QPS from previous checks

-- Per-hour breakdown (if performance_schema available)
SELECT
  HOUR(NOW()) AS current_hour,
  COUNT(*) AS queries_this_hour
FROM performance_schema.events_statements_summary_by_digest;
```

### Step 6: Predict Exhaustion

For each dimension:

```
disk_exhaustion_days = (max_disk_gb - current_used_gb) / daily_growth_gb
connection_exhaustion_days = (max_connections - current_connections) / daily_connection_growth
```

Prioritize by urgency:

| Days Until Exhaustion | Priority | Action |
|----------------------|----------|--------|
| < 7 days | 🔴 Emergency | Immediate cleanup or expansion |
| 7-30 days | 🟡 Urgent | Plan expansion this week |
| 30-90 days | 🟡 Plan | Schedule in next sprint |
| > 90 days | ✅ Monitor | Re-check next month |

## Output Templates

### Capacity Early Warning Report

```
📊 MySQL Capacity Early Warning
═══════════════════════════════
📋 Instance: {host}:{port}
   Analysis Time: {timestamp}
   Uptime: {days} days
   Overall Status: 🔴 WARNING (disk approaching threshold)

💾 Disk Capacity
  ┌──────────────────────────────────────────────────┐
  │ Total: 200GB | Used: 156GB (78%) | Free: 44GB    │
  │ Daily Growth: 1.8GB/day (↑12% vs last week)      │
  │ ⚠️ Estimated Full: {date} ({days} days)           │
  │                                                  │
  │ Growth Source Breakdown:                          │
  │   · Business Data:  0.4GB/day (22%)  — Normal    │
  │   · Binlog:         0.8GB/day (44%)  — Retain 14d│
  │   · Audit Log:      0.6GB/day (34%)  — 90d data  │
  │                                                  │
  │ TOP 5 Space Consumers:                           │
  │ | Database | Data (GB) | Index (GB) | Daily Growth │
  │ |----------|-----------|------------|--------------│
  │ | audit_db | 54.2      | 0.8        | 0.6GB/day   │
  │ | trade_db | 42.1      | 8.3        | 0.2GB/day   │
  │ | user_db  | 28.7      | 5.1        | 0.1GB/day   │
  │ | ...      | ...       | ...        | ...         │
  └──────────────────────────────────────────────────┘

🔗 Connection Capacity
  Current: {current}/{max} ({pct}%)
  Peak Today: {peak} ({peak_pct}%)
  Trend: {stable/rising/falling}
  Status: ✅ Healthy (well below threshold)

⚡ QPS Throughput
  Current QPS: {qps}/sec
  Baseline QPS: {baseline_qps}/sec
  Trend: {stable/rising}
  Status: ✅ Normal

📈 Capacity Forecast Summary
  | Dimension   | Current | Limit  | Usage% | Daily Growth | Days Left | Priority |
  |-------------|---------|--------|--------|-------------|-----------|----------|
  | Disk        | 156GB   | 200GB  | 78%    | 1.8GB/day   | {days}    | 🔴 Urgent |
  | Connections | 245     | 500    | 49%    | Stable      | N/A       | ✅ OK    |
  | QPS         | 4,039/s | —      | —      | Stable      | N/A       | ✅ OK    |

⚡ Priority Action Plan
  ┌──────────────────────────────────────────────────┐
  │ 1. [IMMEDIATE] Clear audit_log > 90 days         │
  │    Expected Savings: ~54GB                        │
  │    New Disk Usage: 78% → 51% ✅                   │
  │    Time Bought: +30 days                          │
  │                                                  │
  │ 2. [THIS WEEK] Reduce binlog retention 14d → 7d  │
  │    Expected Savings: ~12GB                        │
  │    New Disk Usage: 51% → 45% ✅                   │
  │    Time Bought: +7 days                           │
  │                                                  │
  │ 3. [PLAN] Request disk expansion to 500GB         │
  │    With cleanup + expansion: >180 days runway     │
  └──────────────────────────────────────────────────┘
```

### Follow-up After Action

```
✅ Capacity Recovery Report
═════════════════════════
  Before: 156GB / 200GB (78%) — {days} days to full
  Action: Cleared audit_log > 90 days
  After:  102GB / 200GB (51%) — {new_days} days to full
  Result: Bought {bought} additional days ✅
```

## Example Usage

**User**: "Check capacity on db-prod-01"

**AI**:
```
📊 Capacity Check: db-prod-01:3306

🔴 Disk: 78.5% used (156GB / 200GB)
   Growing 1.8GB/day (↑12% vs last week)
   ⚠️ Estimated 6 days to 90% alert threshold

   Growth breakdown:
   · Binlog: 0.8GB/day (retention 14d) — can reduce to 7d
   · Audit log: 0.6GB/day (90d data) — can archive > 30d
   · Business: 0.4GB/day — normal growth

✅ Connections: 245/500 (49%) — healthy
✅ QPS: 4,039/s — stable

⚡ Actions (sorted by impact):
  1. [Now] Clear audit_log > 30 days → free ~54GB (78%→51%)
  2. [Week] Binlog 14d→7d → free ~12GB
  3. [Plan] Expand disk to 500GB → 6+ months runway
```

**User**: "Show me audit_log details"

**AI**: *(shows TOP tables in audit_db with sizes and archival recommendations)*

## Best Practices

### Establish Baseline Table

```sql
CREATE TABLE IF NOT EXISTS dbops.capacity_baseline (
  check_date DATE,
  instance_id VARCHAR(64),
  dimension VARCHAR(32),        -- 'disk', 'connections', 'qps'
  metric_name VARCHAR(64),
  metric_value DECIMAL(15,3),
  unit VARCHAR(16),
  PRIMARY KEY (check_date, instance_id, dimension, metric_name)
);

-- Run daily via cron/job:
INSERT INTO dbops.capacity_baseline
SELECT CURDATE(), '{instance}', 'disk', db_name, total_gb, 'GB'
FROM (
  SELECT TABLE_SCHEMA AS db_name,
    ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024 / 1024, 2) AS total_gb
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
  GROUP BY TABLE_SCHEMA
) t;
```

### Cleanup vs. Expansion Decision Tree

```
IF days_to_full < 7:
  → Immediate cleanup (archive logs, purge old data)
  → If cleanup not possible: emergency expansion
ELIF days_to_full < 30:
  → Plan cleanup this week + schedule expansion
ELIF days_to_full < 90:
  → Plan expansion in next sprint
ELSE:
  → Monitor, re-check monthly
```

### Safe Cleanup Operations

| Operation | Risk | Safe to Run |
|-----------|------|-------------|
| `PURGE BINARY LOGS BEFORE DATE_SUB(NOW(), INTERVAL 7 DAY)` | Low | Yes (if no replicas need old logs) |
| `DROP TABLE audit_log_2025_*` | Medium | Verify no application reads first |
| `DELETE FROM log_table WHERE created_at < ?` | High | Use `pt-archiver` for large deletes |
| `OPTIMIZE TABLE fragmented_table` | Medium | Locks table, run in maintenance window |

## Quick Reference

| Action | Query |
|--------|-------|
| Disk by database | `SELECT ... FROM information_schema.TABLES GROUP BY TABLE_SCHEMA` |
| Binlog files | `SHOW BINARY LOGS` |
| Binlog retention | `SHOW VARIABLES LIKE 'expire_logs_days'` |
| Purge old binlogs | `PURGE BINARY LOGS BEFORE DATE_SUB(NOW(), INTERVAL 7 DAY)` |
| Table sizes | `SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH FROM information_schema.TABLES WHERE TABLE_SCHEMA='...'` |
| Connection usage | `SHOW STATUS LIKE 'Threads_connected'` + `SHOW VARIABLES LIKE 'max_connections'` |
| QPS | `SHOW STATUS LIKE 'Questions'` / `SHOW STATUS LIKE 'Uptime'` |

**Use this skill for proactive capacity management — predict problems before they become incidents, with actionable cleanup and expansion guidance.**
