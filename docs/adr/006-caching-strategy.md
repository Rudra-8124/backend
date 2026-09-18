# ADR-006: Caching Strategy

## Status
Accepted

## Context
At 261 read RPS peak, the database can handle the load directly. However, caching reduces latency (p95 < 200ms requirement), reduces DB load headroom, and improves user experience for repeated queries (doctor search, slot availability).

## Decision
**Redis cache-aside** with explicit TTL and event-driven invalidation.

## Strategy

### Cache-Aside Pattern

```
Read request:
  1. Check Redis for cached result (by cache key)
  2. HIT  → return cached, skip DB
  3. MISS → query DB, store result in Redis with TTL, return

Write request:
  1. Execute write in DB
  2. Delete the relevant cache key(s) from Redis
  3. (Do NOT update cache — let the next read repopulate)
```

### What We Cache

| Data | Cache Key Pattern | TTL | Invalidation Trigger |
|------|-------------------|-----|---------------------|
| Doctor profiles | `doctor:{id}` | 15 min | PATCH `/doctors/me` |
| Doctor search results | `search:doctors:{hash(query_params)}` | 5 min | Doctor profile update, slot status change |
| Slot availability (per doctor, per day) | `slots:{doctor_id}:{date}` | 2 min | Slot status change (book, cancel, block) |
| Doctor listing (browsing) | `doctors:list:{hash(filters)}` | 10 min | Doctor profile update |

### What We Don't Cache

| Data | Reason |
|------|--------|
| Consultations | Rapidly changing state machine; caching would cause stale reads |
| Prescriptions | PHI — caching encrypted data in Redis adds attack surface |
| Payments | Rapidly changing; webhook updates must be immediately visible |
| Audit logs | Append-only, admin-only, low read frequency |
| User profiles | Low cardinality of self-reads, not worth cache complexity |

### Invalidation

**Explicit delete** on write, never update-in-place:
```typescript
// After doctor profile update:
await redis.del(`doctor:${doctorId}`);
await redis.del(`doctors:list:*`);  // pattern delete or use tagged invalidation

// After slot status change:
await redis.del(`slots:${doctorId}:${date}`);
// Search cache invalidation: delete keys with matching doctor
await redis.del(`search:doctors:*`); // or use a generation counter
```

**Generation counter** alternative for search cache:
- Store a `search:generation` counter in Redis.
- Include the generation in every search cache key: `search:doctors:gen42:{hash}`.
- On any write that affects search results, increment the generation.
- Old keys expire via TTL; no need to scan and delete.

### Stampede Protection

When a popular cache key expires, many concurrent requests may hit the DB simultaneously ("thundering herd"):
- **Probabilistic early expiration**: Each read has a small probability of refreshing the cache before TTL expires (XFetch algorithm).
- **Mutex lock**: For expensive queries (doctor search), use a Redis `SET NX EX` lock. If lock acquired, query DB and populate cache. Others wait or return stale data with a short grace period.

## Trade-offs

- **Pro**: Reduces read latency significantly (Redis: < 1ms vs DB: 5–20ms).
- **Pro**: Reduces DB load by 60–80% for read-heavy patterns (search, browsing).
- **Pro**: Simple mental model: cache is always deletable, never the source of truth.
- **Con**: Cache invalidation is the hard part — risk of stale data within TTL window.
- **Con**: Redis is an additional dependency (mitigated: system works without it, just slower).
- **Con**: PHI must never be cached — requires discipline in choosing what to cache.

## Cache Failure Mode

If Redis is unavailable:
- All reads fall through to the database (cache-aside degrades gracefully).
- Rate limiting falls back to in-memory (less accurate but functional).
- The health/readiness endpoint reports Redis as unhealthy.
- No data loss; Redis is never the source of truth.

## Consequences
- A `CacheService` wraps Redis with `get/set/del` and handles serialization.
- A `@Cacheable(key, ttl)` decorator can be used on service methods.
- All cached data must be serializable to JSON and back.
- Cache keys must be documented and invalidation paths tested.
- Monitoring: cache hit/miss ratio as a Prometheus metric.
