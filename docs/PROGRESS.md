# Progress
Phase 0 plan/design ........ [x] ← completed 2026-09-19
Phase 1 foundation/auth ..... [x] ← completed 2026-09-19
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

## Phase 1 — Done
- [x] NestJS skeleton with Fastify adapter, DI modules, strict TypeScript
- [x] Joi schema validation for environment variables at boot (fail fast on missing/invalid vars)
- [x] Pino JSON structured logging with request-id propagation and PII/PHI redaction list
- [x] Global ValidationPipe (`whitelist: true`, `forbidNonWhitelisted: true`)
- [x] Global RFC 7807 Problem Details exception filter (`application/problem+json`)
- [x] Helmet security headers & CORS allowlist configuration
- [x] Graceful shutdown lifecycle hooks
- [x] Hand-written TypeORM SQL migration (`1700000000001-InitialSchema.ts`):
  - 8 core tables: `users`, `profiles`, `doctors`, `availability_slots` (range-partitioned), `consultations` (range-partitioned), `prescriptions`, `payments`, `audit_logs` (range-partitioned)
  - 5 supporting tables: `idempotency_keys`, `outbox_events`, `refresh_tokens`, `mfa_recovery_codes`, `processed_webhook_events`
  - Composite PKs `(id, partition_month)` satisfying Postgres partitioning constraints
  - `ensure_partitions(months_ahead)` function and default partition catch-alls
  - GIN indexes on `search_vector` and `specializations` with auto-update trigger
  - Auto-updating `updated_at` triggers
- [x] Idempotent admin seed script (`seeds/admin-seed.ts`) using argon2id
- [x] Field-level `EncryptionService` (AES-256-GCM, random 96-bit IV, `keyId:iv:tag:ciphertext` format, `KeyProvider` interface with `EnvKeyProvider`, key rotation, tamper detection)
- [x] Auth module:
  - Registration: patient (auto-active) and doctor (pending admin approval)
  - Password hashing: argon2id (memoryCost=65536, timeCost=3, parallelism=4)
  - JWT access tokens (15-min expiry)
  - Refresh token rotation with reuse detection (revokes entire token family on reuse)
  - TOTP MFA setup, QR code generation, AES-256-GCM encrypted secret storage
  - Single-use hashed MFA recovery codes (8 codes)
  - Two-step login returning short-lived `mfa_token` for MFA-enabled accounts
  - Logout with token revocation
- [x] RBAC: `@Roles(...)` decorator + `RolesGuard`, `@CurrentUser()` parameter decorator, `GET/PATCH /users/me`, admin user management
- [x] Redis sliding-window rate limiter with tiers (strict: 5/min, auth: 10/min, standard: 60/min, relaxed: 120/min)
- [x] Health checks: `/healthz` (liveness) and `/readyz` (readiness checking PostgreSQL + Redis)
- [x] OpenAPI specification exported to `docs/openapi.yaml`
- [x] Dockerfile (multi-stage non-root) & `docker-compose.yml` (api, worker, postgres, redis, healthchecks)
- [x] 10 unit tests for `EncryptionService`
- [x] 27 end-to-end integration tests on real PostgreSQL & Redis

## Verified
- `npm run typecheck`: 0 errors
- `npm run lint`: 0 errors
- `npm test`: 10 passed, 10 total
- `npm run test:e2e`: 27 passed, 27 total against real PostgreSQL & Redis
- `npm run build`: cleanly compiles production bundle
- Seed script idempotency verified (running twice skips existing admin)
- OpenAPI spec exported to `docs/openapi.yaml`

## Known gaps
- Phase 2: Availability slots creation, slot hold with TTL, no-double-booking concurrent locking

## Next
Phase 2: Availability & Booking Core — slot scheduling, short slot hold with TTL, concurrency control, double-booking prevention.