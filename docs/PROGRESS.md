# Progress
Phase 0 plan/design ........ [x] ← completed 2026-09-19
Phase 1 foundation/auth ..... [x] ← completed 2026-09-19
Phase 2 booking ............. [x] ← completed 2026-09-19
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

## Phase 2 — Done
- [x] Availability & Booking Migration (`1700000000002-AvailabilityBooking.ts`):
  - Added `timezone` to `profiles` (default `UTC`, validated against IANA timezones)
  - Added `hold_expires_at` to `availability_slots` with B-tree index for efficient worker polling
  - Added `endpoint`, `status` (`IN_PROGRESS`, `COMPLETED`), `updated_at` to `idempotency_keys`
  - Created unique index `idx_idempotency_keys_user_endpoint_key` on `(user_id, endpoint, idempotency_key)`
- [x] Idempotency Interceptor & Service:
  - Atomic key reservation with `INSERT ... ON CONFLICT DO NOTHING`
  - SHA-256 body hashing for payload verification
  - Status management: `IN_PROGRESS` claimed atomically, updated to `COMPLETED` on handler return
  - Replay returns cached status and response with `Idempotency-Replay: true` header
  - Same key with different body returns HTTP 422 Unprocessable Entity
  - Concurrent duplicate with status `IN_PROGRESS` returns HTTP 409 Conflict with `Retry-After: 2` header
  - Crash recovery: detects and recovers stale locks older than 60 seconds
  - Expiration: keys older than 24 hours expire
- [x] Doctor Availability Management:
  - Discrete fixed-size slots stored as UTC `timestamptz`, with doctor timezone in `profiles.timezone`
  - Bulk generation from weekly schedule (`recurring_days`, `start_time`, `end_time`, `slot_duration_minutes`, date range) in doctor's local timezone
  - Slot cancellation: doctors can cancel unbooked slots; patients or cross-doctors denied
  - Slot overlap prevention: composite unique constraint `(doctor_id, start_time, partition_month)` plus service-level overlap verification wrapped in a per-doctor transaction advisory lock (`pg_advisory_xact_lock`)
- [x] Atomic Booking & Concurrency Control:
  - `POST /consultations` with mandatory `Idempotency-Key` header
  - Single-transaction atomic conditional `UPDATE` query:
    ```sql
    UPDATE availability_slots
    SET status = 'HELD', held_by = $1, held_until = now() + interval '5 minutes',
        hold_expires_at = now() + interval '5 minutes', updated_at = now()
    WHERE id = $2 AND (status = 'AVAILABLE' OR (status = 'HELD' AND (hold_expires_at < now() OR held_until < now())))
    RETURNING id, partition_month, doctor_id, start_time, end_time, status, held_by, hold_expires_at;
    ```
  - Exactly 0 rows affected -> immediate HTTP 409 Conflict (zero read-then-write race)
  - Patient overlapping slots prevention: checks patient has no active holds or bookings overlapping the target slot
  - Atomic consultation insert with status `PENDING_PAYMENT` and transactional `outbox_events` (`consultation.created`) in the same database transaction
- [x] Hold Expiry Worker:
  - Worker process (`src/worker.ts`) and `AvailabilityService.releaseExpiredHolds()`
  - Queries slots where `status = 'HELD'` and `hold_expires_at < now()`
  - Atomically resets slot to `AVAILABLE` and marks consultation as `CANCELLED` with reason `HOLD_EXPIRED`
- [x] Ownership Checks & IDOR Protection:
  - Patient can view own consultation; cross-patient denied with 403 Forbidden
  - Assigned doctor can view consultation; unassigned doctor denied with 403 Forbidden
  - Doctor cannot book consultations (`@Roles('patient')`); patient cannot create or cancel slots (`@Roles('doctor')`)
- [x] Full Verification Suite:
  - 20 E2E booking tests covering 50 parallel bookings, 20 same-key replays, 422 mismatch, hold expiry lifecycle, patient overlap prevention, RBAC & IDOR
  - 27 E2E auth tests passing
  - 10 unit tests for EncryptionService passing
  - OpenAPI spec refreshed to `docs/openapi.yaml`

## Verified
- `npm run typecheck`: 0 errors
- `npm run lint`: 0 errors (6 warnings for intentional `any` in seed/test)
- `npm test`: 10 passed, 10 total
- `npx jest test/auth.e2e-spec.ts`: 27 passed, 27 total
- `npx jest test/booking.e2e-spec.ts`: 20 passed, 20 total
  - Concurrency: 50 parallel bookings on one slot -> exactly 1x201 Created, 49x409 Conflict, exactly 1 consultation row created
  - Idempotency: 20 parallel requests with same key and body -> exactly 1 consultation created, identical response
  - Mismatch: same key with different body -> 422 Unprocessable Entity
  - Hold expiry: unexpired hold blocked, expired hold re-bookable, worker releases hold and cancels consultation
  - Overlap: patient cannot book two overlapping slots
  - IDOR: cross-patient and cross-doctor access denied (403)
- `npm run openapi:export`: OpenAPI spec exported cleanly to `docs/openapi.yaml`

## Known gaps
- Phase 3: Payment provider mock, payment intent creation, HMAC-signed webhooks, BullMQ outbox processor, saga compensation on payment failure/timeout, prescription encryption.

## Next
Phase 3: Consultations, Payments, Saga & Outbox — payment provider mock with HMAC signatures, BullMQ outbox worker, payment intent creation, saga orchestration with automated compensation (release slot, cancel consultation).