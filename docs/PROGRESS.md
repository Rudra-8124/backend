# Progress
Phase 0 plan/design ........ [x] ← completed 2026-09-19
Phase 1 foundation/auth ..... [ ]
Phase 2 booking ............. [ ]
Phase 3 consult/pay/saga .... [ ]
Phase 4 search/cache/admin .. [ ]
Phase 5 observability ....... [ ]
Phase 6 CI/infra/load test .. [ ]
Phase 7 docs ................ [ ]
Phase 8 final audit ......... [ ]

## Phase 0 — Done
- [x] requirements-traceability.md — every assignment line mapped to module/phase
- [x] er-diagram.md — 8 core + 5 supporting tables, partition-key-in-PK design
- [x] state-machines.md — slot and consultation state machines with transitions
- [x] booking-sequence.md — happy path + 5 failure paths (conflict, pay fail, timeout, duplicate, worker crash)
- [x] api-endpoints.md — all endpoints with roles, idempotency, rate-limit tiers
- [x] capacity.md — 100k/day math: ~300 peak RPS, ~280 GB/yr, pool sizing, Redis ~200 MB
- [x] ADR-001: modular monolith
- [x] ADR-002: saga + transactional outbox
- [x] ADR-003: idempotency strategy
- [x] ADR-004: partitioning (range by month, PG constraints)
- [x] ADR-005: audit hash chain (per-partition scope)
- [x] ADR-006: caching strategy (cache-aside + invalidation)

## Verified
- All Postgres partitioning constraints addressed (partition key in PK/UNIQUE, no FK into partitioned tables, no exclusion constraints)
- Hash chain scope justified (per-partition avoids global serialization)
- Capacity assumptions all explicit

## Known gaps
- Threat model and security checklist deferred to P7
- OpenAPI spec generated in P7 (manual endpoint table in P0)
- Demo video in P8

## Next
Phase 1: Foundation + Auth — project scaffold, TypeORM config, migrations for all tables, auth module (register, login, JWT, refresh, MFA)