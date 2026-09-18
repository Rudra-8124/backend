# Requirements Traceability Matrix

Every line of the assignment mapped to the module, file, and phase that satisfies it.

## Legend

| Phase | Description |
|-------|-------------|
| P0 | Design (this phase) |
| P1 | Foundation + Auth |
| P2 | Booking (availability + slots) |
| P3 | Consultation + Payment + Saga |
| P4 | Search + Cache + Admin Analytics |
| P5 | Observability |
| P6 | CI / Infra / Load Test |
| P7 | Docs / OpenAPI / Architecture Doc |
| P8 | Final Audit |

## Deliverables (Assignment lines 4–11)

| # | Assignment Requirement | Module / File | Phase | Notes |
|---|------------------------|---------------|-------|-------|
| D1 | Git repo with code and infra | repo root, `terraform/`, `docker-compose.yml` | P6 | Mono-repo with two entrypoints |
| D2 | README with setup | `README.md` | P7 | Setup, env vars, docker-compose up |
| D3 | OpenAPI schema | `docs/openapi.yaml` (auto-exported via `@nestjs/swagger`) | P7 | Fastify+Swagger plugin |
| D4 | Architecture doc (2–4 pages) | `docs/architecture.md` | P7 | References all design docs from P0 |
| D5 | Tests and CI pipeline | `src/**/*.spec.ts`, `test/`, `.github/workflows/ci.yml` | P6 | Unit + integration + concurrency + k6 |
| D6 | Observability setup | `docker-compose.yml` (otel-collector, prometheus, grafana, loki, tempo), `src/common/observability/` | P5 | OTel traces, Prom metrics, JSON logs |
| D7 | Security checklist and threat model | `docs/security-checklist.md`, `docs/threat-model.md` | P7 | OWASP mapping, attack surface, data classification |

## Core Workflows (Assignment lines 13–18)

| # | Assignment Requirement | Module / File | Phase | Notes |
|---|------------------------|---------------|-------|-------|
| W1 | User lifecycle (auth, roles) | `src/auth/`, `src/users/` | P1 | argon2id, JWT+refresh, TOTP MFA, RBAC |
| W2 | Doctor availability and booking | `src/availability/`, `src/consultations/` | P2 | Slot CRUD, hold+reserve, no double-book |
| W3 | Consultation lifecycle and prescriptions | `src/consultations/`, `src/prescriptions/` | P3 | State machine, saga, AES-256-GCM for PHI |
| W4 | Search and filtering | `src/search/` | P4 | tsvector + GIN, Redis cache-aside |
| W5 | Compliance and audit trails | `src/audit/` | P1 (schema), P2+ (integration) | Append-only, hash chain, restricted DB role |
| W6 | Admin analytics | `src/admin-analytics/` | P4 | Dashboard queries, role-gated |

## System Requirements / NFRs (Assignment lines 19–23)

| # | Assignment Requirement | Module / File | Phase | Notes |
|---|------------------------|---------------|-------|-------|
| N1 | Scale: 100k daily consultations | `docs/capacity.md`, partitioning, connection pool | P0 design, P2+ impl | Capacity math in P0; range partitions |
| N2 | Latency: p95 <200ms reads, <500ms writes | Redis cache, indexes, keyset pagination | P2–P4 | Verified via k6 load script (P6) |
| N3 | Availability: 99.95% | Terraform multi-AZ, health/readiness, SLO burn-rate alerts | P5–P6 | 26.3 min/month downtime budget |
| N4 | Security: encryption, MFA, RBAC | `src/auth/`, `src/common/crypto/`, guards | P1, P3 | AES-256-GCM PHI, TOTP, RBAC guards |
| N5 | Observability: metrics, logs, traces | `src/common/observability/` | P5 | OTel, Prom, structured JSON, Grafana |
| N6 | CI/CD with containerized deployment | `Dockerfile`, `.github/workflows/ci.yml`, `terraform/` | P6 | Multi-stage non-root, ECS Fargate |

## Architecture Tasks (Assignment lines 24–33)

| # | Assignment Requirement | Module / File | Phase | Notes |
|---|------------------------|---------------|-------|-------|
| A1 | High-level architecture and data flow | `docs/architecture.md`, `docs/er-diagram.md` | P0, P7 | Modular monolith diagram |
| A2 | Booking flow sequence diagram | `docs/booking-sequence.md` | P0 | Mermaid sequence with failure paths |
| A3 | ER diagram | `docs/er-diagram.md` | P0 | 8 core + 5 supporting tables |
| A4 | API schema | `docs/api-endpoints.md`, `docs/openapi.yaml` | P0, P7 | Endpoint table now; OpenAPI generated later |
| A5 | Retry & backoff strategies | `src/common/resilience/` (backoff, circuit-breaker) | P3 | Exponential + full jitter, CB for payment |
| A6 | Data partitioning | `docs/er-diagram.md`, migrations | P0 design, P1 DDL | Range by month: consultations, slots, audit |
| A7 | Caching and concurrency handling | `src/common/cache/`, slot locking | P2, P4 | Cache-aside + TTL + invalidation; DB-level concurrency |
| A8 | Transaction management and sagas | `src/consultations/booking.saga.ts`, outbox | P3 | Reserve→pay→confirm, compensate on fail |
| A9 | Backup and DR strategy | `docs/architecture.md`, `terraform/` | P6, P7 | RDS automated backups, multi-AZ, point-in-time recovery |

## Implementation Guidelines (Assignment lines 34–41)

| # | Assignment Requirement | Module / File | Phase | Notes |
|---|------------------------|---------------|-------|-------|
| G1 | Language: Node.js | All `src/` | P1+ | Node.js 22 + TypeScript |
| G2 | DB: PostgreSQL (Redis optional) | `docker-compose.yml`, TypeORM config | P1 | PG 16 + Redis 7 (cache, rate-limit, queues) |
| G3 | REST or GraphQL API | NestJS controllers, Fastify adapter | P1+ | REST + OpenAPI |
| G4 | Modular services with DI | NestJS modules (`*.module.ts`) | P1+ | 10 modules, clean boundaries |
| G5 | Idempotency for writes | `src/common/idempotency/` | P1 (middleware), P2+ | Idempotency-Key header, request hash |
| G6 | Async jobs for heavy tasks | BullMQ, `src/worker/` | P3 | Outbox relay, payment timeout, DLQ |
| G7 | Rate limiting and input validation | `src/common/rate-limit/`, DTO class-validator | P1 | Redis sliding window, stricter on auth |
| G8 | Secrets via env vars | `.env.example`, `src/common/config/` | P1 | NestJS ConfigModule, no secrets in git |

## Security & Threat Modelling (Assignment lines 42–43)

| # | Assignment Requirement | Module / File | Phase | Notes |
|---|------------------------|---------------|-------|-------|
| S1 | OWASP mitigation | `docs/threat-model.md`, guards, validation | P7 (doc), P1+ (impl) | Top-10 mapped |
| S2 | Attack surface analysis | `docs/threat-model.md` | P7 | Endpoints, auth flows, webhooks |
| S3 | Data classification | `docs/threat-model.md` | P7 | PII vs PHI vs public |
| S4 | Encryption | `src/common/crypto/` | P3 | AES-256-GCM field-level, TLS in transit |
| S5 | Key rotation | `src/common/crypto/key-provider.ts` | P3 | Key-id prefix, KeyProvider interface |
| S6 | Audit logs | `src/audit/` | P1+ | Append-only, hash chain |
| S7 | Dependency scanning | `.github/workflows/ci.yml` (Trivy, npm audit, gitleaks) | P6 | Automated in CI |

## Data Model (Assignment lines 44–45)

| # | Assignment Requirement | Module / File | Phase | Notes |
|---|------------------------|---------------|-------|-------|
| DM1 | users table | `src/users/entities/user.entity.ts`, migration | P1 | id, email, password_hash, role, mfa |
| DM2 | profiles table | `src/users/entities/profile.entity.ts`, migration | P1 | Linked to users, personal info |
| DM3 | doctors table | `src/doctors/entities/doctor.entity.ts`, migration | P1 | Extends profile with specialization, license |
| DM4 | availability_slots table | `src/availability/entities/slot.entity.ts`, migration | P2 | Range-partitioned by month |
| DM5 | consultations table | `src/consultations/entities/consultation.entity.ts`, migration | P2 | Range-partitioned by month |
| DM6 | prescriptions table | `src/prescriptions/entities/prescription.entity.ts`, migration | P3 | AES-256-GCM encrypted fields |
| DM7 | payments table | `src/payments/entities/payment.entity.ts`, migration | P3 | Linked to consultation |
| DM8 | audit_logs table | `src/audit/entities/audit-log.entity.ts`, migration | P1 | Range-partitioned by month, hash chain |

## Evaluation Rubric (Assignment lines 46–54)

| # | Rubric Item (weight) | Satisfied By | Phase |
|---|---------------------|--------------|-------|
| R1 | Architecture – 20 | Design docs (P0), modular monolith, ADRs, architecture doc | P0, P7 |
| R2 | Core Flows – 20 | Booking saga, consultation lifecycle, state machines | P2, P3 |
| R3 | Code Quality – 15 | TypeScript strict, DTOs, service/repo layers, no god classes, lint | P1–P4 |
| R4 | Security – 10 | Auth module, crypto, RBAC, rate-limit, threat model, checklist | P1, P3, P7 |
| R5 | Observability – 10 | OTel, Prometheus, Grafana, structured logs, alerts | P5 |
| R6 | Scalability – 10 | Partitioning, keyset pagination, capacity math, k6 | P0, P2, P6 |
| R7 | Infra/CI – 10 | Dockerfile, docker-compose, Terraform, GitHub Actions | P6 |
| R8 | Bonus – +10 | SLO burn-rate alerts, circuit breaker, DLQ, hash chain | P3, P5 |
| R9 | Fail condition: missing security or idempotency | Auth + idempotency middleware + crypto | P1 |

## Submission (Assignment lines 55–56)

| # | Assignment Requirement | Module / File | Phase | Notes |
|---|------------------------|---------------|-------|-------|
| SUB1 | Submit repo | GitHub | P8 | Final audit, then push |
| SUB2 | Docs | `docs/` | P7 | Architecture, threat model, security checklist |
| SUB3 | 5-minute demo video | External recording | P8 | Screen recording of flows |
