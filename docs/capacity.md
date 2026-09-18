# Capacity Planning: 100k Consultations/Day

## Assumptions (all explicit)

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Daily consultations | 100,000 | Assignment requirement |
| Operating hours | 16 hours (6 AM – 10 PM) | Telemedicine typical hours in India |
| Peak factor | 3× average | Healthcare morning/evening spikes |
| Read:Write ratio | 10:1 | Browsing doctors/slots is far more frequent than booking |
| Average consultation duration | 20 min | Typical telemedicine consultation |
| Concurrent consultations at peak | ~6,250 | 100k/16h × (20/60) × 3 peak |
| Booking attempts per successful booking | 1.5 | Some slot conflicts and retries |
| API calls per consultation lifecycle | 8 | Search(2) + book(1) + pay-webhook(1) + start(1) + complete(1) + prescription(1) + fetch(1) |
| Availability slots per doctor per day | 16 | 30-min slots over 8 hours |
| Active doctors | 10,000 | To support 100k consultations at 10 consults/doctor/day |
| Active patients | 80,000–100,000 daily | Many browse, fewer book |

## RPS Calculations

### Write RPS (state-changing)

```
Bookings/day = 100,000
Bookings/second (avg) = 100,000 / (16 × 3600) = 1.74 RPS
Bookings/second (peak) = 1.74 × 3 = 5.2 RPS

Total write API calls/day = 100,000 × 5 writes = 500,000
  (book, pay-webhook, start, complete, prescription)
Write RPS (avg) = 500,000 / (16 × 3600) = 8.7 RPS
Write RPS (peak) = 8.7 × 3 = 26.1 RPS
```

### Read RPS

```
Read:Write = 10:1
Read RPS (avg) = 8.7 × 10 = 87 RPS
Read RPS (peak) = 26.1 × 10 = 261 RPS
```

### Total RPS

```
Total RPS (avg)  = 87 + 8.7  ≈  96 RPS
Total RPS (peak) = 261 + 26.1 ≈ 287 RPS
Round up for headroom: ~300 peak RPS
```

## Database Growth

### Row Estimates Per Year

| Table | Rows/Day | Rows/Year | Avg Row Size | Storage/Year |
|-------|----------|-----------|-------------|-------------|
| consultations | 100,000 | 36.5M | 512 bytes | ~18.7 GB |
| availability_slots | 160,000 | 58.4M | 256 bytes | ~15.0 GB |
| payments | 100,000 | 36.5M | 256 bytes | ~9.4 GB |
| prescriptions | 80,000 | 29.2M | 2 KB (encrypted) | ~58.4 GB |
| audit_logs | 500,000 | 182.5M | 512 bytes | ~93.4 GB |
| users | 300/day (new) | 109.5K | 256 bytes | ~28 MB |
| outbox_events | 300,000 | 109.5M (pruned) | 512 bytes | ~5 GB (after pruning) |
| idempotency_keys | 600,000 | 219M (pruned to 7 days) | 1 KB | ~4.2 GB (before prune) |

### Total Storage (Year 1)

```
Data:    ~200 GB
Indexes: ~60 GB  (30% of data, typical for B-tree + GIN)
WAL:     ~20 GB  retained
Total:   ~280 GB Year 1
```

### Partitioning Impact

Partitioned tables (consultations, availability_slots, audit_logs) by month:
- 12 partitions/year
- Each consultation partition: ~3M rows, ~1.6 GB
- Each audit_log partition: ~15.2M rows, ~7.8 GB
- Old partitions can be detached and archived to cold storage (S3)
- Partition pruning reduces query scan to 1 partition for date-bounded queries

## Connection Pool Sizing

```
API instances:    4 (ECS Fargate tasks)
Worker instances: 2
Pool per instance: 20 connections
Total: (4 × 20) + (2 × 20) = 120 connections

RDS max_connections (db.r6g.large, 16 GB): ~640
Reserved for admin/monitoring: 20
Available: 620
Utilization: 120/620 = 19% (comfortable headroom)

PgBouncer consideration: Not needed at this scale.
At 10× growth, deploy PgBouncer in transaction mode.
```

## Redis Memory

### Cache (doctor search results, slot availability)

```
Cached doctor profiles:  10,000 × 2 KB  = 20 MB
Cached search results:   5,000 queries × 4 KB avg = 20 MB
Cached slot listings:    10,000 doctors × 2 KB = 20 MB
Subtotal cache: ~60 MB
```

### Rate Limiting (sliding window counters)

```
Active users × windows: 100,000 × 128 bytes = ~12.8 MB
```

### Slot Holds (TTL keys)

```
Concurrent holds (peak): 1,000 × 128 bytes = ~128 KB
```

### BullMQ Job Data

```
Pending jobs (peak):  5,000 × 1 KB   = ~5 MB
Delayed jobs (payment timeouts): 5,000 × 512 bytes = ~2.5 MB
```

### Session/Refresh Tokens (if cached)

```
Refresh token references: 100,000 × 256 bytes = ~25 MB
```

### Total Redis Memory

```
Total:      ~105 MB
With overhead (fragmentation, metadata): ~200 MB
Recommended instance: cache.r6g.large (13 GB) for ElastiCache
This gives 65× headroom for growth.
```

## Queue Throughput (BullMQ)

```
Outbox events/day:   ~300,000
Events/second (avg): 5.2
Events/second (peak): 15.6
BullMQ on Redis can handle >10,000 jobs/sec.
Comfortably within capacity.
```

## Network Bandwidth

```
Avg response size: 2 KB
Peak RPS: 300
Bandwidth: 300 × 2 KB = 600 KB/s ≈ 5 Mbps
Negligible for modern infrastructure.
```

## Scaling Thresholds

| Metric | Action Trigger | Action |
|--------|---------------|--------|
| API CPU > 70% sustained | Scale out | Add ECS tasks (auto-scaling) |
| DB connections > 80% pool | Scale out | Add PgBouncer, then vertical scale |
| Redis memory > 60% | Monitor | Tune TTLs, consider larger instance |
| Queue depth > 10,000 | Scale workers | Add worker tasks |
| DB storage > 80% | Archive | Detach old partitions to S3 |
| p95 latency > 150ms reads | Investigate | Check slow queries, add indexes, warm cache |
