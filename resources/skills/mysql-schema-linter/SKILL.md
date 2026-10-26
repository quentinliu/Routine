---
name: mysql-schema-linter
version: 1.0.0
description: >
  Automated MySQL schema review tool. Scans all tables for common issues:
  missing primary key, wrong storage engine, non-utf8mb4 charset, redundant indexes,
  foreign key constraints, auto-increment overflow risk, and unpartitioned large tables.
  Outputs prioritized findings with fix SQL.
allowed-tools: db_query, db_list_databases, db_list_tables, db_describe_table
---

# MySQL Schema Linter

## Overview

Schema issues are silent killers — they don't crash the database immediately, but cause performance degradation, replication lag, and operational headaches over time. This skill performs automated schema review across 9 dimensions:

1. ❌ Missing Primary Key
2. ❌ Wrong Storage Engine (non-InnoDB)
3. ❌ Non-utf8mb4 Charset
4. ❌ Auto-increment approaching INT limit
5. ❌ Duplicate/Redundant Indexes
6. ❌ Foreign Key Constraints
7. ❌ Large tables without partitioning
8. ❌ Tables without any index
9. ❌ Tables with NULLable columns that should be NOT NULL

## When to Use

- Periodic schema audit (monthly/quarterly)
- Before production deployment of new schema
- After bulk DDL operations
- Pre-migration assessment
- Developer requests schema review

## Required MCP Server

| Tool | Purpose |
|------|---------|
| `db_query` | Query information_schema |
| `db_list_databases` | Get database list |
| `db_describe_table` | Check table structure |

### Required Privileges

- `SELECT` on `information_schema.*`

## Diagnostic Workflow

### Step 1: Get All User Databases

```sql
SELECT SCHEMA_NAME FROM information_schema.SCHEMATA
WHERE SCHEMA_NAME NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
ORDER BY SCHEMA_NAME;
```

### Step 2: Full Schema Scan (Single Query)

```sql
-- Comprehensive schema analysis in one pass
SELECT
  t.TABLE_SCHEMA AS db_name,
  t.TABLE_NAME AS table_name,
  t.ENGINE AS engine,
  t.TABLE_ROWS AS row_count,
  t.TABLE_COLLATION AS collation,
  t.DATA_LENGTH,
  t.INDEX_LENGTH,
  t.CREATE_OPTIONS,
  t.AUTO_INCREMENT,
  -- Check: has PK?
  CASE WHEN pk.TABLE_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS has_pk,
  -- Check: index count
  idx_count.cnt AS index_count
FROM information_schema.TABLES t
LEFT JOIN (
  SELECT TABLE_SCHEMA, TABLE_NAME
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_TYPE = 'PRIMARY KEY'
) pk ON t.TABLE_SCHEMA = pk.TABLE_SCHEMA AND t.TABLE_NAME = pk.TABLE_NAME
LEFT JOIN (
  SELECT TABLE_SCHEMA, TABLE_NAME, COUNT(*) AS cnt
  FROM information_schema.STATISTICS
  GROUP BY TABLE_SCHEMA, TABLE_NAME
) idx_count ON t.TABLE_SCHEMA = idx_count.TABLE_SCHEMA AND t.TABLE_NAME = idx_count.TABLE_NAME
WHERE t.TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
  AND t.TABLE_TYPE = 'BASE TABLE'
ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME;
```

### Step 3: Check for Issues

```sql
-- 1. Missing Primary Key
SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_ROWS
FROM information_schema.TABLES t
WHERE t.TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
  AND t.TABLE_TYPE = 'BASE TABLE'
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS tc
    WHERE tc.TABLE_SCHEMA = t.TABLE_SCHEMA AND tc.TABLE_NAME = t.TABLE_NAME
    AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
  )
ORDER BY TABLE_ROWS DESC;

-- 2. Non-InnoDB Engine
SELECT TABLE_SCHEMA, TABLE_NAME, ENGINE
FROM information_schema.TABLES
WHERE ENGINE != 'InnoDB' AND ENGINE IS NOT NULL
  AND TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
  AND TABLE_TYPE = 'BASE TABLE';

-- 3. Non-utf8mb4 Charset
SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
  AND TABLE_TYPE = 'BASE TABLE'
  AND TABLE_COLLATION NOT LIKE 'utf8mb4%'
  AND TABLE_COLLATION IS NOT NULL;

-- 4. Redundant Indexes (same leading column)
SELECT a.TABLE_SCHEMA, a.TABLE_NAME,
  a.INDEX_NAME AS idx1, b.INDEX_NAME AS idx2,
  a.COLUMN_NAME AS shared_prefix
FROM information_schema.STATISTICS a
JOIN information_schema.STATISTICS b
  ON a.TABLE_SCHEMA = b.TABLE_SCHEMA AND a.TABLE_NAME = b.TABLE_NAME
  AND a.SEQ_IN_INDEX = 1 AND b.SEQ_IN_INDEX = 1
  AND a.COLUMN_NAME = b.COLUMN_NAME
  AND a.INDEX_NAME < b.INDEX_NAME
WHERE a.TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys');

-- 5. Foreign Keys
SELECT TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME,
  REFERENCED_TABLE_NAME, REFERENCED_TABLE_SCHEMA
FROM information_schema.KEY_COLUMN_USAGE
WHERE REFERENCED_TABLE_NAME IS NOT NULL
  AND TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys');

-- 6. Auto-increment near INT limit (2^31 - 1 = 2,147,483,647)
SELECT TABLE_SCHEMA, TABLE_NAME, AUTO_INCREMENT
FROM information_schema.TABLES
WHERE AUTO_INCREMENT > 2000000000
  AND TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys');
```

## Output Template

```
📐 MySQL Schema Lint Report
═══════════════════════════
📋 Overview
  Instance: {host}:{port}
  Databases: {count} | Tables: {count}
  Issues Found: {total} ({critical} Critical, {warning} Warning, {info} Info)

🔴 CRITICAL — Missing Primary Key ({count} tables)
  Top 5 largest tables without PK:
  | Database | Table | Rows |
  |----------|-------|-------|
  | ...      | ...   | ...   |

  Fix: ALTER TABLE {schema}.{table} ADD PRIMARY KEY (id);
  ⚠️ Large tables: use pt-online-schema-change or gh-ost

🟡 WARNING — Non-utf8mb4 Charset ({count} tables)
  | Collation | Count |
  |-----------|-------|
  | utf8_bin  | {n}   |
  | latin1    | {n}   |

  Fix: ALTER TABLE {table} CONVERT TO CHARACTER SET utf8mb4;

🟡 WARNING — Redundant Indexes ({count} pairs)
  | Table | Index 1 | Index 2 | Shared Column |
  |-------|---------|---------|---------------|

  Fix: DROP INDEX {redundant_idx} ON {table};

ℹ️ INFO — Foreign Keys ({count} tables)
  ℹ️ FK constraints can cause cascading locks.
  Review if application-level integrity is preferred.

📊 Summary
  Total Tables: {n}
  Clean Tables: {n} ({pct}%)
  Issues: {n} Critical, {n} Warning, {n} Info
```

## Example Usage

**User**: "Lint the schema of all databases"

**AI Response**:
```
📐 Schema Lint Report

82 databases, 8,791 tables scanned

🔴 CRITICAL: 144 tables missing Primary Key
  Top: dm_meta_*.syncer_checkpoint (DM checkpoint tables)
  → Low risk, but recommend adding PK for new tables

🟡 WARNING: 3,447 tables non-utf8mb4
  utf8_bin: 3,421 | utf8_general_ci: 26
  → Plan charset migration during maintenance window

ℹ️ INFO: 7 foreign key constraints found

📊 Clean: 5,193/8,791 (59%)
```

## Fix Scripts (Copy-Paste Ready)

### Fix 1: Add Primary Key (Online)

```sql
-- Small tables: direct ALTER
ALTER TABLE {schema}.{table} ADD PRIMARY KEY (id);

-- Large tables: use online DDL (MySQL 5.6+)
ALTER TABLE {schema}.{table} ADD PRIMARY KEY (id),
  ALGORITHM=INPLACE, LOCK=NONE;

-- Very large tables: use pt-online-schema-change
-- pt-online-schema-change --alter "ADD PRIMARY KEY (id)" \
--   D={schema},t={table} h={host},P={port},u={user},p={password} \
--   --max-load=Threads_running=50 --critical-load=Threads_running=100

-- Or use gh-ost (Facebook's tool, trigger-free)
-- gh-ost --host={host} --database={schema} --table={table} \
--   --alter "ADD PRIMARY KEY (id)" --allow-on-master
```

### Fix 2: Convert to InnoDB Engine

```sql
-- Online conversion
ALTER TABLE {schema}.{table} ENGINE=InnoDB, ALGORITHM=INPLACE, LOCK=NONE;

-- Or with pt-osc for large tables:
-- pt-online-schema-change --alter "ENGINE=InnoDB" \
--   D={schema},t={table} h={host},P={port},u={user},p={password}
```

### Fix 3: Convert Charset to utf8mb4

```sql
-- Convert table charset (rebuilds table)
ALTER TABLE {schema}.{table} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Convert specific columns only (faster for large tables)
ALTER TABLE {schema}.{table}
  MODIFY {column} VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Check impact before converting:
SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH/1024/1024 AS data_mb
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = '{schema}' AND TABLE_COLLATION NOT LIKE 'utf8mb4%';
```

### Fix 4: Drop Redundant Index

```sql
-- Drop the shorter/redundant index
DROP INDEX {redundant_idx} ON {schema}.{table};

-- Or rename for safety before dropping
ALTER TABLE {schema}.{table} RENAME INDEX {old_name} TO {old_name}_deprecated;
-- Then DROP after verification period
```

### Fix 5: Plan Schema Migration

For large-scale fixes across many tables, generate a migration script:

```sql
-- Generate ALTER TABLE statements for all non-utf8mb4 tables
SELECT CONCAT(
  'ALTER TABLE `', TABLE_SCHEMA, '`.`', TABLE_NAME,
  '` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;'
) AS migration_sql
FROM information_schema.TABLES
WHERE TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')
  AND TABLE_TYPE = 'BASE TABLE'
  AND TABLE_COLLATION NOT LIKE 'utf8mb4%'
  AND TABLE_COLLATION IS NOT NULL;
```

## Best Practices

### Fix Priority

| Priority | Issue | Risk |
|----------|-------|------|
| **Critical** | Missing PK | Replication lag, no row identity |
| **Critical** | Auto-inc overflow | INSERT failures |
| **High** | Non-InnoDB engine | No transactions, no crash recovery |
| **High** | Redundant indexes | Wasted disk + slower writes |
| **Medium** | Non-utf8mb4 | Emoji/4-byte character data loss |
| **Low** | Foreign keys | Cascading locks, deployment friction |

### Safe Schema Changes

```sql
-- For large tables, use online DDL (MySQL 5.6+)
ALTER TABLE large_table ADD INDEX idx_name (col1, col2),
  ALGORITHM=INPLACE, LOCK=NONE;

-- Or use pt-online-schema-change
-- pt-online-schema-change --alter "ADD PRIMARY KEY (id)" D=db,t=table
```

## Quick Reference

| Check | Query |
|-------|-------|
| Missing PK | `SELECT ... WHERE NOT EXISTS (PK constraint)` |
| Engine check | `SELECT ... WHERE ENGINE != 'InnoDB'` |
| Charset check | `SELECT ... WHERE TABLE_COLLATION NOT LIKE 'utf8mb4%'` |
| Redundant indexes | `SELECT ... FROM STATISTICS a JOIN STATISTICS b ON shared_prefix` |
| Foreign keys | `SELECT ... FROM KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL` |
| Auto-inc limit | `SELECT ... WHERE AUTO_INCREMENT > 2000000000` |

**Use this skill for automated schema quality review — catch issues before they become incidents.**
