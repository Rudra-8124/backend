# ADR-005: Audit Log Hash Chain Design

## Status
Accepted

## Context
AGENTS.md requires append-only audit_logs with a hash chain for tamper detection. A naïve global synchronous chain (each INSERT hashes the previous row's hash) serializes **all** writes across the entire table, creating a bottleneck. At 500k audit events/day (~8.7/sec avg, ~26/sec peak), this would become a severe contention point.

We must choose a hash chain scope that balances tamper-detection strength with write throughput.

## Options Considered

| Option | Scope | Throughput Impact | Tamper Detection |
|--------|-------|-------------------|------------------|
| A. Global synchronous chain | Entire table | Serializes all writes (1 writer) | Strongest: any gap detectable |
| B. Per-partition chain | Monthly partition | Serializes within partition (~1/12th load) | Strong: per-month integrity |
| C. Per-actor chain | Per user | No serialization (parallel by actor) | Moderate: per-user integrity |
| D. No chain (append-only only) | N/A | No overhead | Weak: only DB role prevents mutation |

## Decision
**Option B: Per-partition (monthly) chain.**

## Justification

1. **Throughput**: At 100k consultations/day, only the current month's partition has active writes. Serialization within one partition (~15M rows/month, ~8.7 writes/sec avg) is manageable. Future months have zero contention.

2. **Tamper detection**: An attacker who modifies or deletes rows within a partition will break the chain. Verification is a sequential scan of one partition — feasible for monthly audits.

3. **Partition alignment**: audit_logs is already range-partitioned by month. The hash chain naturally aligns with partitions. When a partition is archived, its chain is a self-contained, verifiable unit.

4. **Cross-partition integrity**: A monthly "chain seal" job computes a digest of the last hash in each completed partition and stores it in a separate `partition_seals` row (or external tamper-evident log). This links partitions without serializing writes across them.

## Implementation

### Write Path

```sql
-- Pseudo-code in the audit service:
BEGIN;
  -- Advisory lock on partition to serialize within partition
  SELECT pg_advisory_xact_lock(hashtext('audit_' || $partition_month::text));

  -- Get the last hash in this partition
  SELECT hash FROM audit_logs
    WHERE partition_month = $partition_month
    ORDER BY created_at DESC, id DESC
    LIMIT 1;
  -- If no rows, previous_hash = '' (genesis)

  -- Compute new hash
  new_hash = SHA-256(previous_hash || actor_id || action || resource_type || resource_id || created_at || request_id)

  INSERT INTO audit_logs (id, partition_month, actor_id, action, resource_type, resource_id,
                           ip_address, request_id, metadata, previous_hash, hash, created_at)
  VALUES (..., $previous_hash, $new_hash, now());
COMMIT;
```

### Advisory Lock

`pg_advisory_xact_lock` serializes audit writes within a partition without locking the entire table. The lock key is derived from the partition month. At ~26 writes/sec peak within one partition, each lock is held for < 1ms (INSERT + hash computation). This gives ~96% idle time on the lock — well within tolerance.

### Verification

```sql
-- Verify a partition's chain integrity:
SELECT id, previous_hash, hash,
  CASE WHEN previous_hash = LAG(hash) OVER (ORDER BY created_at, id)
       OR (ROW_NUMBER() OVER (ORDER BY created_at, id) = 1 AND previous_hash = '')
  THEN 'valid' ELSE 'BROKEN' END AS chain_status
FROM audit_logs
WHERE partition_month = '2026-09-01'
ORDER BY created_at, id;
```

### Chain Seal (Cross-Partition)

At month-end, a job:
1. Reads the last hash of the completed partition.
2. Stores it as `partition_seals(partition_month, final_hash, sealed_at)`.
3. The next month's genesis row uses this as context (not as `previous_hash` in the DB, but logged in metadata for cross-partition auditability).

## Trade-offs

- **Pro**: Serialization limited to one partition (~26 writes/sec peak) — well within tolerance.
- **Pro**: Archived partitions are self-contained verifiable units.
- **Pro**: Advisory locks are lightweight (no row-level lock contention on audit_logs).
- **Con**: Within a partition, writes are serialized (but at < 1ms per write, negligible).
- **Con**: Cross-partition tampering (deleting an entire partition) requires the seal to detect.
- **Con**: Advisory lock adds a round-trip per audit write.

## Consequences
- The audit service acquires an advisory lock before each INSERT.
- A monthly seal job must run after the month closes.
- Verification can be run as a periodic health check or on-demand by admins.
- The DB role for the application has INSERT-only (no UPDATE/DELETE) on audit_logs.
