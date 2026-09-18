# ADR-004: Data Partitioning Strategy

## Status
Accepted

## Context
At 100k consultations/day, the consultations, availability_slots, and audit_logs tables will grow to tens of millions of rows per year. Without partitioning, queries degrade as tables grow, VACUUM becomes slow, and index maintenance becomes expensive.

## Decision
**Range partition** the three highest-volume tables by month using a `partition_month DATE` column (first day of each month).

| Table | Partition Key | Derivation | Rows/Month |
|-------|--------------|------------|------------|
| consultations | `partition_month` | `date_trunc('month', scheduled_start)` | ~3M |
| availability_slots | `partition_month` | `date_trunc('month', start_time)` | ~4.8M |
| audit_logs | `partition_month` | `date_trunc('month', created_at)` | ~15M |

### Postgres Constraints on Partitioned Tables

These PG 16 constraints shaped the design:

1. **Partition key must be in every PK and UNIQUE constraint.**
   - PKs: `(id, partition_month)` instead of just `(id)`.
   - All unique indexes include `partition_month`.

2. **FK references into a partitioned table are not supported.**
   - `payments.consultation_id` cannot be a real FK → `consultations(id, partition_month)`.
   - Instead: application-level enforcement + nightly consistency-check job.
   - Referencing tables carry both `consultation_id` and `consultation_partition_month` to enable partition-aware queries.

3. **FK references from a partitioned table are not reliably supported.**
   - `availability_slots.doctor_id` → `doctors.id` is a logical FK, not a real FK.
   - Enforced at application layer (service validates doctor exists before INSERT).

4. **Exclusion constraints are not supported.**
   - Double-booking prevention uses conditional UPDATE (`WHERE status = 'AVAILABLE'`) + partial unique index instead of `EXCLUDE USING gist`.

### Partition Management

- **Creation**: A monthly cron job (or migration) creates the next 3 months of partitions ahead of time.
- **Archival**: Partitions older than 12 months can be detached and exported to S3 (cold storage). The detached table remains queryable via a foreign data wrapper if needed.
- **Default partition**: A `_default` partition catches any rows that don't match an existing partition (safety net).

### Query Patterns

All queries against partitioned tables include `partition_month` (or a date range that maps to it) to enable partition pruning:

```sql
-- Good: partition pruning applies
SELECT * FROM consultations
WHERE partition_month = '2026-09-01' AND patient_id = $1;

-- Also good: range scan prunes to relevant partitions
SELECT * FROM consultations
WHERE scheduled_start BETWEEN '2026-09-01' AND '2026-09-30'
  AND partition_month = '2026-09-01';

-- Bad: scans all partitions (avoided by design)
SELECT * FROM consultations WHERE patient_id = $1;
```

Application code always includes the partition month in queries. The ORM repository methods enforce this.

## Trade-offs

- **Pro**: Partition pruning dramatically reduces scan scope for date-bounded queries.
- **Pro**: VACUUM and index maintenance operate per-partition (smaller, faster).
- **Pro**: Old data archival is a simple `DETACH PARTITION` — no downtime, no DELETE.
- **Pro**: Each partition's indexes are smaller and fit in memory better.
- **Con**: No real FK enforcement into partitioned tables → application must enforce.
- **Con**: Composite PKs `(id, partition_month)` are less ergonomic than simple `id`.
- **Con**: Every referencing table must carry `partition_month` columns for routing.
- **Con**: Queries without `partition_month` scan all partitions (must enforce in app layer).

## Why Not Partition prescriptions or payments?

- **prescriptions**: ~29M rows/year, always accessed via `consultation_id`. A simple index suffices. Can add partitioning later if needed.
- **payments**: ~36.5M rows/year, 1:1 with consultations, accessed via `consultation_id` or `payment_intent_id`. Unique index on `payment_intent_id` would require including the partition key, complicating lookups by intent ID. Not worth it at this scale.

## Consequences
- Migrations must create partition parent tables and initial child partitions.
- A partition-management cron job must run monthly to create future partitions.
- All repositories for partitioned entities must accept and propagate `partition_month`.
- Nightly referential-integrity check job logs any orphaned references.
