# Amrutam telemedicine backend (take-home assignment, production-grade)

Session start: read docs/ASSIGNMENT.md and docs/PROGRESS.md before doing anything.
Session end: update docs/PROGRESS.md (done / verified / gaps / next).

## Fixed decisions (do not re-litigate)
- Node.js 22 + TypeScript, NestJS (Fastify adapter, DI modules), PostgreSQL 16,
  Redis 7, BullMQ, TypeORM with hand-written SQL migrations. REST + OpenAPI
  exported to docs/openapi.yaml.
- Modular monolith: one codebase, two entrypoints (stateless API, worker).
  Modules: auth, users, doctors, availability, consultations, prescriptions,
  payments, search, audit, admin-analytics. Clean boundaries so they could be
  extracted later; document the trade-off.

## Non-negotiables
1. No double booking under concurrency. Enforce in the DB (unique constraint or
   conditional UPDATE on slot status) plus a short slot hold with TTL. Redis is
   never the source of truth for availability.
2. Idempotency: every state-changing endpoint requires an Idempotency-Key header.
   Store key + request hash + response. Replay returns the stored response; same
   key with a different body returns 422. Payment webhooks are idempotent too.
3. Booking saga: reserve slot -> consultation PENDING_PAYMENT -> payment intent ->
   confirm. Compensate on failure/timeout (release slot, cancel). Transactional
   outbox for events. Mock payment provider with HMAC-signed webhooks.
4. Security: argon2id; JWT access (15 min) + rotating hashed refresh tokens;
   TOTP MFA mandatory for doctors/admins; RBAC guards + ownership checks (no
   IDOR); DTO validation everywhere; Redis sliding-window rate limits (stricter
   on login/MFA); helmet; CORS allowlist; secrets only via env vars, .env.example
   committed, no real secrets in git.
5. PHI protection: AES-256-GCM field-level encryption for prescriptions/clinical
   notes with a key-id prefix for rotation; KeyProvider interface (env locally,
   KMS-ready). Never log PII/PHI.
6. Audit: append-only audit_logs (actor, action, resource, ip, request_id, ts,
   hash chain). App DB role has INSERT but no UPDATE/DELETE.
7. Scale: range-partition consultations, availability_slots, audit_logs by month;
   proper indexes; keyset pagination; no N+1.
8. Search: Postgres full-text (tsvector + GIN) + filters; Redis cache-aside with
   TTL and explicit invalidation.
9. Resilience: exponential backoff with full jitter, circuit breaker for the payment
   provider, DLQ for failed jobs.
10. Observability: OpenTelemetry traces, Prometheus metrics (RED per route, queue
    depth, booking success/conflict counters), structured JSON logs with request
    and trace IDs and PII redaction, health/readiness endpoints, Grafana dashboard
    JSON, alert rules including SLO burn-rate for 99.95%.
11. Infra/CI: multi-stage non-root Dockerfile; docker-compose for the full local
    stack (api, worker, postgres, redis, otel-collector, prometheus, grafana,
    loki/tempo); Terraform for AWS (VPC, RDS multi-AZ, ElastiCache, ECS Fargate,
    ALB) that passes `terraform validate`; GitHub Actions: lint, typecheck, unit,
    integration, coverage gate, dependency audit, Trivy, gitleaks.
12. Tests: unit + integration + concurrency test (50 parallel bookings on one slot
    -> exactly one succeeds) + idempotency replay + RBAC/IDOR + k6 load script.

## Working method
- One phase per session. Stop at the end of each phase for my review.
- Run tests, lint and typecheck yourself; fix failures before reporting done.
- Commit after each phase with a conventional-commit message.
- Never claim something works unless you ran it. Never invent benchmark numbers.
  If something cannot be done locally (multi-region DR), design it and say so.
- Small idiomatic code: DTOs, service layer, repository layer, no god classes.
- Ask at most one question at a time, only if truly blocking.