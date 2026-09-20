# Amrutam Telemedicine Platform Backend

[![CI Pipeline](https://github.com/Rudra-8124/backend/actions/workflows/ci.yml/badge.svg)](https://github.com/Rudra-8124/backend/actions/workflows/ci.yml)
[![Node Version](https://img.shields.io/badge/node-22.x-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Production-grade, highly scalable telemedicine backend built for **Amrutam**. Engineered to support **100,000 daily consultations** with **p95 read latency < 200 ms**, **p95 write latency < 500 ms**, and **99.95% availability**. Features zero double-booking under extreme concurrency, field-level AES-256-GCM encryption for PHI, transactional outbox sagas, and full OpenTelemetry observability.

---

## 1. Prerequisites

Before running the application, ensure you have the following installed:
- **Node.js**: v22.x (LTS) or higher
- **npm**: v10.x or higher
- **Docker & Docker Compose**: v2.x or higher
- *(Optional for load tests)*: **k6** ([Installation Guide](https://k6.io/docs/get-started/installation/))
- *(Optional for cloud IaC)*: **Terraform** v1.5+

---

## 2. Quickstart (Run in 5 Commands)

Get the complete application running locally with PostgreSQL, Redis, and seed data:

```bash
# 1. Clone and copy environment configuration
git clone https://github.com/Rudra-8124/backend.git && cd backend && cp .env.example .env

# 2. Start PostgreSQL and Redis containers
docker compose up -d postgres redis

# 3. Install dependencies
npm install

# 4. Run database migrations and seed administrative accounts
npm run migration:run && npm run seed

# 5. Start the development server
npm run start:dev
```

The API will be live at `http://localhost:3000`. Test readiness at `http://localhost:3000/readyz`.

To run the background worker (outbox relay & hold cleanup daemon) concurrently:
```bash
npm run start:worker
```

---

## 3. Environment Variables

All configuration is managed via environment variables validated at startup using Joi:

| Variable | Required | Default / Example | Purpose |
| :--- | :---: | :--- | :--- |
| `NODE_ENV` | No | `development` | Runtime mode (`development`, `test`, `production`). |
| `PORT` | No | `3000` | HTTP port for the Fastify REST API. |
| `DB_HOST` | **Yes** | `localhost` | PostgreSQL host. |
| `DB_PORT` | No | `5432` | PostgreSQL port. |
| `DB_NAME` | **Yes** | `amrutam` | PostgreSQL database name. |
| `DB_USER` | **Yes** | `amrutam` | PostgreSQL user. |
| `DB_PASSWORD` | **Yes** | `change_me_in_production` | PostgreSQL password. |
| `REDIS_HOST` | **Yes** | `localhost` | Redis host. |
| `REDIS_PORT` | No | `6379` | Redis port. |
| `JWT_ACCESS_SECRET` | **Yes** | *Min 32 characters* | Cryptographic secret for 15-minute access tokens. |
| `JWT_REFRESH_SECRET` | **Yes** | *Min 32 characters* | Cryptographic secret for rotating refresh tokens. |
| `ENCRYPTION_KEYS` | **Yes** | `{"k1":"<64-hex-chars>"}` | JSON key map for AES-256-GCM field encryption. |
| `ENCRYPTION_CURRENT_KEY_ID` | **Yes** | `k1` | Active key identifier used for new encryptions. |
| `PAYMENT_WEBHOOK_SECRET` | **Yes** | `whsec_test_secret_change_me` | HMAC-SHA256 secret for validating payment webhooks. |
| `TOTP_ISSUER` | No | `Amrutam` | Issuer string shown in authenticator apps (Google/Authy). |
| `CORS_ORIGINS` | No | `http://localhost:3000,http://localhost:5173` | Comma-separated list of allowed CORS origins. |
| `ADMIN_EMAIL` | No | `admin@amrutam.test` | Default admin email for the database seed script. |
| `ADMIN_PASSWORD` | No | `AdminPass123!@#Secure` | Default admin password for the database seed script. |

---

## 4. Testing & Verification

### Running Automated Test Suites

```bash
# 1. Run Unit Tests (Encryption, Crypto, Key Provider)
npm test

# 2. Run Full End-to-End Integration Tests (Auth, Booking, Saga, Search, Observability)
npm run test:e2e

# 3. Run the 50-Parallel Booking Concurrency Test
npx jest test/booking.e2e-spec.ts -t "50 concurrent booking attempts on the exact same slot"

# 4. Verify Cryptographic Audit Log Hash Chain
npm run audit:verify

# 5. Typecheck & Linting
npm run typecheck && npm run lint
```

### Running k6 Performance & Concurrency Load Test

The repository includes automated k6 load scripts testing high-throughput reads and concurrent bookings against strict SLA thresholds:

```bash
# Step 1: Seed benchmark doctors, patient auth tokens, and 1,000 discrete availability slots
npm run seed:k6

# Step 2: Run k6 load test scenarios
npm run test:load
```

**Verified Benchmark Results**:
- **Read p95 Latency**: `65.48 ms` (Threshold: `< 200 ms`) — **PASS**
- **Write p95 Latency**: `242.77 ms` (Threshold: `< 500 ms`) — **PASS**
- **Error Rate**: `0.00%` across 901 requests over 25 seconds — **PASS**

---

## 5. API Documentation & Observability Dashboards

### Interactive API Documentation
- **Swagger UI**: Accessible at [http://localhost:3000/api/docs](http://localhost:3000/api/docs)
- **OpenAPI 3.0 Specification**: Exported and versioned at [`docs/openapi.yaml`](docs/openapi.yaml)
- **Regenerate OpenAPI Spec**: `npm run openapi:export`

### Complete Local Observability Stack
Spin up the full telemetry stack (Prometheus, Grafana, Loki, Tempo, OpenTelemetry Collector):

```bash
docker compose up -d
```

| Service | Local URL | Default Credentials | Description |
| :--- | :--- | :--- | :--- |
| **API Server** | [http://localhost:3000](http://localhost:3000) | N/A | Fastify REST API & `/healthz` / `/readyz`. |
| **Prometheus** | [http://localhost:9090](http://localhost:9090) | None | Prometheus time-series metrics & SLO alert rules. |
| **Grafana** | [http://localhost:3001](http://localhost:3001) | `admin` / `amrutam_grafana_dev` | Provisioned dashboards for RED metrics, booking funnel, outbox, and DB. |
| **Raw Metrics** | [http://localhost:3000/metrics](http://localhost:3000/metrics) | Public | Standard Prometheus exposition format. |

---

## 6. Repository Directory Structure

```
.
├── .github/
│   ├── dependabot.yml            # Automated weekly dependency updates
│   └── workflows/ci.yml          # 8-stage production CI/CD pipeline
├── docker/
│   ├── grafana/                  # Provisioned datasources & 4 production dashboards
│   ├── otel-collector-config.yaml# OpenTelemetry trace/metric pipelines
│   ├── prometheus-alerts.yaml    # Google SRE multi-window burn-rate SLO alerts
│   └── prometheus.yml            # Prometheus scrape targets
├── docs/
│   ├── architecture.md           # Full system architecture specification (<= 4 pages)
│   ├── threat-model.md           # Threat model, STRIDE matrix, and abuse cases
│   ├── security-checklist.md     # OWASP Top 10, data classification, key rotation
│   ├── backup-dr.md              # PITR, WAL archiving, cross-region DR runbooks
│   ├── openapi.yaml              # OpenAPI 3.0 specification exported from code
│   └── explain-analyze.md        # Benchmark EXPLAIN ANALYZE execution plans
├── k6/
│   ├── load-test.js              # k6 load test scenarios (reads + writes)
│   └── seed-k6.ts                # Deterministic load test seed generator
├── migrations/                   # Hand-written SQL TypeORM migrations
├── scripts/
│   ├── export-openapi.ts         # Script to generate docs/openapi.yaml
│   └── verify-audit-chain.ts     # CLI verifier for append-only audit hash chains
├── seeds/
│   ├── admin-seed.ts             # Initial administrative user seeder
│   └── benchmark-seed.ts         # High-volume seeder (5k doctors, 100k consultations)
├── src/
│   ├── admin-analytics/          # Materialized view analytics & reports
│   ├── audit/                    # Append-only audit logging & hash chain engine
│   ├── auth/                     # Argon2id, JWT, MFA TOTP, refresh tokens, RBAC
│   ├── availability/             # Discrete slots, bulk schedule generation, holds
│   ├── common/                   # Crypto (AES-GCM), idempotency, filters, rate limit
│   ├── consultations/            # State machine, booking saga, optimistic locks
│   ├── doctors/                  # Doctor profiles, search vector indexes, ratings
│   ├── payments/                 # Mock gateway, HMAC webhooks, circuit breaker
│   ├── prescriptions/            # AES-256-GCM encrypted medical records & audit
│   ├── search/                   # Full-text (tsvector), pg_trgm, Redis cache-aside
│   ├── users/                    # User lifecycle & profiles
│   ├── main.ts                   # Stateless API entrypoint
│   └── worker.ts                 # Background outbox relay & saga worker
├── terraform/                    # Complete AWS production infrastructure
│   ├── modules/                  # Modular VPC, Security, RDS, ElastiCache, ALB, ECS, Monitoring
│   ├── main.tf                   # Root composition
│   └── variables.tf              # Infrastructure input variables
├── test/                         # E2E integration test suites
├── Dockerfile                    # Multi-stage non-root container build
├── docker-compose.yml            # Full local development stack
└── package.json                  # Dependencies and execution scripts
```

---

## 7. Architecture Highlights

1. **Zero Double-Booking**: Guaranteed via a single atomic SQL conditional update (`UPDATE availability_slots SET status = 'HELD' ... WHERE id = $1 AND status = 'AVAILABLE'`) under per-doctor transaction advisory locks.
2. **Strict Idempotency**: State-changing endpoints require an `Idempotency-Key` header, validating payload SHA-256 hashes and returning cached responses on replay or HTTP 422 on payload variation.
3. **Field-Level PHI Encryption**: Medical notes and prescriptions are encrypted in application memory with AES-256-GCM using `keyId:iv:tag:ciphertext` envelope format before writing to the database.
4. **Append-Only Tamper-Evident Audit Chain**: Audit records are cryptographically linked using SHA-256 hash chains. The PostgreSQL database role explicitly revokes `UPDATE` and `DELETE` privileges on audit tables.
5. **Distributed Sagas via Transactional Outbox**: Mutations and events are committed in the same database transaction. A worker daemon relays events with W3C `traceparent` context and executes compensating transactions on failures or timeouts.