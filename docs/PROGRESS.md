# Progress
Phase 0 plan/design ........ [x] ← completed 2026-09-19
Phase 1 foundation/auth ..... [x] ← completed 2026-09-19
Phase 2 booking ............. [x] ← completed 2026-09-19
Phase 3 consult/pay/saga .... [x] ← completed 2026-09-19
Phase 4 search/cache/admin .. [x] ← completed 2026-09-19
Phase 5 observability ....... [x] ← completed 2026-09-20
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

## Phase 3 — Done
- [x] Consultation State Machine:
  - Enforced in ONE centralized place (`src/consultations/consultation-state-machine.ts`)
  - Optimistic locking via `version` column; illegal transitions and version collisions return HTTP 409 Conflict
  - Transition endpoints:
    - `PATCH /consultations/:id/start`: Doctor-only, transitions `CONFIRMED -> IN_PROGRESS`
    - `PATCH /consultations/:id/complete`: Doctor-only, transitions `IN_PROGRESS -> COMPLETED`, releases slot to `COMPLETED`, field-encrypts clinical notes
    - `PATCH /consultations/:id/cancel`: Patient or Doctor ownership check; cancels consultation, releases slot to `AVAILABLE`, and triggers automated refund via payment provider if consultation was paid
    - `PATCH /consultations/:id/no-show`: Doctor-only, transitions `CONFIRMED -> NO_SHOW`, frees or closes slot
  - Outbox events emitted transactionally on all state transitions
- [x] Prescriptions with AES-256-GCM Field-Level Encryption & Auditing:
  - `POST /consultations/:id/prescriptions`: Assigned doctor only, consultation must be `IN_PROGRESS` or `COMPLETED` (409 otherwise)
  - `medications`, `diagnosis`, and `notes` encrypted at field level via `EncryptionService` before durable DB persistence
  - Verified ciphertext stored in DB matches format `keyId:iv:tag:ciphertext`
  - In-memory decryption only for assigned doctor and consultation patient owner
  - IDOR protection: third-party patients and unrelated doctors receive HTTP 403 Forbidden
  - Audit trail: every PHI read and write emits structured audit records via `AuditService` with partition-scoped hash chains
- [x] Payments & Webhooks with Circuit Breaker:
  - Mock payment provider behind `IPaymentProvider` interface with configurable failure injection
  - `CircuitBreaker` pattern (states: `CLOSED`, `OPEN`, `HALF_OPEN`) with exponential backoff and full jitter
  - `POST /webhooks/payments`:
    - Timing-safe HMAC-SHA256 signature verification (`crypto.timingSafeEqual`)
    - 5-minute timestamp anti-replay tolerance window (rejects replayed or stale timestamps)
    - Deduplication against `processed_webhook_events` table (replayed events acknowledged with 200 without duplicate action)
    - Durable atomic writes to `payments` table before returning 2xx
    - Out-of-order handling: refund event before payment intent triggers auto-compensation
- [x] Saga Orchestration & Outbox Relay Worker:
  - Outbox relay via `SELECT ... FOR UPDATE SKIP LOCKED` ensuring at-least-once delivery with no concurrent contention
  - Exponential backoff with jitter on transient failures; routes permanently failing events to Dead Letter Queue (`DLQ`) after 3 attempts
  - Crash recovery (`recoverStuckEvents`): detects events stuck in `PROCESSING` for >30 seconds and releases them back to `PENDING`
  - Payment timeout compensation (`processPaymentTimeouts`): detects `PENDING_PAYMENT` consultations older than 10 minutes, cancels consultation, and resets slot to `AVAILABLE`
  - Partition worker: recurring job executing `ensure_partitions(3)` to ensure 3 months of partitions exist ahead of time
- [x] Complete Verification of All Failure Paths in `docs/booking-sequence.md`:
  - Failure Path 1: Slot Conflict -> Handled in Phase 2
  - Failure Path 2: Payment Failure -> Consultation marked `PAYMENT_FAILED`, slot released to `AVAILABLE`
  - Failure Path 3: Payment Timeout -> Worker detects >10m hold, cancels consultation, releases slot
  - Failure Path 4: Duplicate Webhook -> Acknowledged idempotently without duplicate balance or state effect
  - Failure Path 5: Invalid HMAC Signature -> Rejected with 401 Unauthorized
  - Failure Path 6: Stale / Replayed Webhook Timestamp -> Rejected with 400 Bad Request
  - Failure Path 7: Circuit Breaker Trips on Outage -> Transitions to `OPEN`, fast-fails downstream requests, recovers on health restoration
  - Failure Path 8: Worker Crashes Mid-Relay -> Stuck `PROCESSING` event recovered to `PENDING` with no lost effect and zero duplicates

## Phase 4 — Done
- [x] Search, Analytics & Audit Migration (`1700000000004-SearchAnalyticsAudit.ts`):
  - Enabled `pg_trgm` extension for typo-tolerant trigram search
  - Added `languages` (text array with GIN index), `rating_avg`, and `rating_count` to `doctors`
  - Created composite B-tree index `idx_doctors_fee_rating` on `(fee_cents, rating_avg)`
  - Created trigram GIN indexes `idx_profiles_name_trgm` (on concatenated `first_name || ' ' || last_name`) and `idx_doctors_bio_trgm` (on `bio`)
  - Created materialized view `daily_consultation_analytics_mv` with unique index `(day, doctor_id)` and date index `(day)` for concurrent refresh
  - Created non-superuser database role `amrutam_app` and revoked `UPDATE` and `DELETE` on `audit_logs` (and all monthly partitions)
- [x] Doctor Search & Multi-Filter Engine (`src/search/`):
  - Full-text search over `tsvector` + GIN index with `plainto_tsquery('english', $q)` (safely handling empty tsqueries from punctuation/special characters)
  - Typo-tolerant trigram similarity search fallback (`similarity(name, $q) > 0.2`)
  - Multi-attribute filtering: specialty, language, fee range (`min_price`, `max_price`), `min_rating`, `city`, and availability window (`available_from`, `available_to`)
  - Sorting options: `price_asc`, `price_desc`, `rating_desc`, `experience_desc`, `relevance`
  - Opaque keyset pagination via base64 cursor encoding `(id, sortValue)` ensuring zero `OFFSET` scanning overhead
  - Strict parameterized queries protecting against SQL injection attacks
- [x] Redis Cache-Aside & Stampede Protection (`src/common/cache/`):
  - Normalized query hash keys (`search:doctors:v{version}:{hash}`) and profile keys (`doctor:profile:v{version}:{id}`)
  - Short TTL with random +/- 10% jitter to prevent synchronized expiration cascades
  - Namespace versioning invalidation (`INCR version:namespace`) avoiding high-latency `KEYS`/`SCAN` operations
  - Stampede single-flight distributed lock (`SET lock:key token NX PX 5000`) with polling fallback and Lua unlock
  - Cache invalidation on doctor profile updates (`PATCH /doctors/me`) and availability slot mutations (create, cancel, hold expiry)
- [x] Admin Analytics Engine (`src/admin-analytics/`):
  - Materialized view `daily_consultation_analytics_mv` refreshed concurrently every 5 minutes by background worker job
  - `GET /admin/analytics/consultations`: aggregate totals, daily time-series, completion rate, cancellation rate, no-show rate, revenue
  - `GET /admin/analytics/doctors`: doctor productivity, utilization rate, revenue, keyset pagination
  - `POST /admin/analytics/refresh`: manual concurrent refresh endpoint
  - Strict 90-day maximum date range enforcement (HTTP 400 if exceeded)
  - Strict RBAC protection: admin-only access (HTTP 403 for patients and doctors)
- [x] Audit Module & Cryptographic Tamper Verifier (`src/audit/` & `scripts/verify-audit-chain.ts`):
  - Append-only `audit_logs` table partitioned by month with SHA-256 hash chains (`ADR-005`)
  - Verifier script (`npm run audit:verify`) and endpoint `GET /admin/audit-logs/verify` cryptographically validating genesis row and unbroken hash chains
  - Admin log query endpoint `GET /admin/audit-logs` with filters and keyset pagination
  - Restricted role `amrutam_app` enforcing append-only immutability at the PostgreSQL engine level (`UPDATE` and `DELETE` denied with SQLSTATE 42501)
- [x] High-Volume Benchmark & EXPLAIN ANALYZE:
  - Seed script (`seeds/benchmark-seed.ts`) populating 5,000 verified doctors and 100,000 partitioned consultations across past 60 days
  - Real execution plans documented in `docs/explain-analyze.md`:
    - Doctor search query executes in **6.55 ms** via GIN index scan (`idx_doctors_search_vector`)
    - Admin analytics daily report executes in **24.1 ms** scanning 51,493 pre-aggregated rows via index scan (`idx_daily_analytics_mv_day`)

## Phase 5 — Done
- [x] Observability Migration (`1700000000005-ObservabilityTraceparent.ts`):
  - Added `traceparent` column (`VARCHAR(255)`) to `outbox_events`
  - Created B-tree index `idx_outbox_traceparent` on `outbox_events(traceparent)`
- [x] OpenTelemetry Distributed Tracing (`src/common/observability/tracing.ts` & `trace-context.ts`):
  - NodeSDK initialized with `HttpInstrumentation`, `PgInstrumentation` (enhanced DB reporting), and `IORedisInstrumentation`
  - Manual spans covering key booking lifecycle operations: `booking.hold_slot`, `booking.create_consultation`, `saga.create_payment_intent`, `saga.confirm_consultation`, `saga.refund_consultation`
  - W3C trace context extraction & injection: captures incoming `traceparent` header (or generates new valid trace ID) and stores it in `outbox_events.traceparent`
  - Worker outbox relay extracts stored `traceparent` via `withTraceparentContext` ensuring consultation booking forms **ONE continuous unbroken trace** across stateless API and background worker
- [x] Prometheus Metrics & High-Cardinality Protection (`src/common/observability/metrics.service.ts` & `metrics.interceptor.ts`):
  - Strict route template normalization (`req.routeOptions?.url || req.routerPath` with regex fallback replacing UUIDs with `:id`), strictly avoiding high-cardinality label explosions
  - RED metrics: `http_requests_total{method, route, status_code}`, `http_request_duration_seconds{method, route, status_code}` histogram
  - Business & resilience counters: `booking_attempts_total{result}`, `slot_conflicts_total`, `idempotency_replays_total`, `payment_provider_errors_total{error_type}`, `circuit_breaker_state{state}`
  - Infrastructure gauges: `outbox_lag_seconds`, `outbox_pending_total`, `outbox_dlq_total`, real-time `db_pool_connections{state="used|idle|waiting|max"}`
  - `@Public()` metrics endpoint: `GET /metrics` returning Prometheus-formatted text
- [x] Pino Structured Logging with Trace Correlation (`src/common/logger/logger.config.ts`):
  - Log formatters extracting active `trace_id` and `span_id` from OpenTelemetry active span
  - Strict PII/PHI redaction paths protecting passwords, TOTP codes, clinical notes, patient diagnosis, encryption keys, and payment tokens
- [x] Docker-Compose Observability Stack (`docker-compose.yml` & `docker/*`):
  - `otel-collector`: OpenTelemetry Collector routing OTLP trace and metric telemetry
  - `tempo`: Distributed tracing backend receiving OTLP gRPC/HTTP traces from collector
  - `loki`: Structured log aggregation backend with retention configuration
  - `prometheus`: Scrapes API and worker metrics every 15s; alert rules loaded from `docker/prometheus-alerts.yaml`
  - `grafana`: Pre-configured datasources (`prometheus`, `tempo`, `loki`) and dashboard providers
- [x] Grafana Dashboards (`docker/grafana/dashboards/*.json`):
  - `red-metrics.json`: RED metrics per route (Rate, Errors, Duration p50/p95/p99)
  - `booking-funnel.json`: Booking funnel conversion, conflict rates, slot contention, idempotency replays
  - `queue-outbox-health.json`: Outbox lag, pending count, DLQ dead-letter queue growth, worker throughput
  - `db-redis-health.json`: PostgreSQL connection pool saturation, cache hit/miss ratio, query latencies
- [x] Multi-Window Multi-Burn-Rate Alert Rules (`docker/prometheus-alerts.yaml`):
  - 99.95% Availability SLO alerts based on Google SRE multi-window multi-burn-rate methodology:
    - Critical Burn Rate (14.4x): 2% budget consumed in 1h (long window: 1h, short window: 5m)
    - Warning Burn Rate (6x): 5% budget consumed in 6h (long window: 6h, short window: 30m)
  - Operational Alerts: High P95 Latency (>200ms read, >500ms write), High Outbox Lag (>60s), Outbox DLQ Growth, Database Pool Near Exhaustion (>85%), Redis Connection Errors, Application Readiness Failing
- [x] Documentation (`docs/observability.md`):
  - Complete architecture diagram, signal specifications, SLO math, and a 6-step incident debugging runbook (Symptom -> PromQL -> Grafana -> Tempo Trace -> Loki Logs -> DB Verification)

## Verified
- `npm run typecheck`: 0 errors
- `npm run lint`: 0 errors (36 warnings for explicit any)
- `npm test`: 10 passed, 10 total (Crypto unit tests)
- `npm run test:e2e`: 91 passed, 91 total
  - `test/auth.e2e-spec.ts`: 27 passed, 27 total
  - `test/booking.e2e-spec.ts`: 20 passed, 20 total
  - `test/phase3.e2e-spec.ts`: 19 passed, 19 total
  - `test/phase4.e2e-spec.ts`: 19 passed, 19 total
  - `test/observability.e2e-spec.ts`: 6 passed, 6 total
- Total Test Suite: 101 passed, 101 total (100% passing across all 6 test suites)
- `npm run audit:verify`: All 15 audit rows verified cryptographically, chain intact
- `npm run openapi:export`: OpenAPI spec exported cleanly to `docs/openapi.yaml`

## Known gaps
- Phase 6: CI, Infrastructure & Load Testing (Terraform for AWS, Multi-stage Docker, GitHub Actions workflows, k6 load testing scripts).

## Next
Phase 6: CI / Infrastructure / Load Testing — Multi-stage non-root Dockerfile, Terraform AWS infrastructure (VPC, RDS multi-AZ, ElastiCache, ECS Fargate, ALB), GitHub Actions CI/CD workflows (lint, typecheck, tests, coverage, Trivy, gitleaks), and k6 performance & concurrency stress test scripts.