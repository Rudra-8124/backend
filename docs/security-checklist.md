# Amrutam Telemedicine Backend: Security Checklist & Compliance Guide

## 1. OWASP Top 10 (2021) Controls Mapping

| OWASP Category | Concrete Repo Control | Enforcing File / Artifact |
| :--- | :--- | :--- |
| **A01: Broken Access Control** | • `@Roles(...)` decorator and `RolesGuard` enforcing patient, doctor, and admin privileges.<br>• Resource ownership verification in service layer preventing IDOR on consultations and prescriptions.<br>• Non-root container execution (`amrutam` UID 10001).<br>• PostgreSQL `amrutam_app` role revoking `UPDATE` and `DELETE` on `audit_logs`. | [`src/auth/guards/roles.guard.ts`](file:///D:/backend/backend/src/auth/guards/roles.guard.ts)<br>[`src/consultations/consultations.service.ts`](file:///D:/backend/backend/src/consultations/consultations.service.ts)<br>[`src/prescriptions/prescriptions.service.ts`](file:///D:/backend/backend/src/prescriptions/prescriptions.service.ts)<br>[`Dockerfile`](file:///D:/backend/backend/Dockerfile)<br>[`migrations/1700000000004-SearchAnalyticsAudit.ts`](file:///D:/backend/backend/migrations/1700000000004-SearchAnalyticsAudit.ts) |
| **A02: Cryptographic Failures** | • Password hashing using **Argon2id** ($m=65536, t=3, p=4$).<br>• Field-level **AES-256-GCM** encryption with 96-bit random IV and 128-bit authentication tag for all PHI.<br>• Multi-AZ TLS 1.3 termination at ALB (`ELBSecurityPolicy-TLS13-1-2-2021-06`).<br>• AWS KMS customer managed key (CMK) for RDS and ElastiCache at rest. | [`src/auth/auth.service.ts`](file:///D:/backend/backend/src/auth/auth.service.ts)<br>[`src/common/crypto/encryption.service.ts`](file:///D:/backend/backend/src/common/crypto/encryption.service.ts)<br>[`terraform/modules/alb/main.tf`](file:///D:/backend/backend/terraform/modules/alb/main.tf)<br>[`terraform/modules/security/main.tf`](file:///D:/backend/backend/terraform/modules/security/main.tf) |
| **A03: Injection** | • Parameterized SQL queries via TypeORM QueryBuilder across all database interactions.<br>• Full-text search escaping user queries via `plainto_tsquery('english', $1)`.<br>• Global `ValidationPipe` with `whitelist: true` and `forbidNonWhitelisted: true`. | [`src/search/search.service.ts`](file:///D:/backend/backend/src/search/search.service.ts)<br>[`src/main.ts`](file:///D:/backend/backend/src/main.ts)<br>[`src/common/filters/http-exception.filter.ts`](file:///D:/backend/backend/src/common/filters/http-exception.filter.ts) |
| **A04: Insecure Design** | • Mandatory `Idempotency-Key` on state-changing endpoints with SHA-256 request body verification.<br>• Zero double-booking via atomic conditional database update and advisory locks.<br>• Transactional outbox pattern guaranteeing at-least-once event delivery.<br>• Circuit breaker with full jitter on payment provider interactions. | [`src/common/idempotency/idempotency.interceptor.ts`](file:///D:/backend/backend/src/common/idempotency/idempotency.interceptor.ts)<br>[`src/availability/availability.service.ts`](file:///D:/backend/backend/src/availability/availability.service.ts)<br>[`src/payments/circuit-breaker.ts`](file:///D:/backend/backend/src/payments/circuit-breaker.ts)<br>[`src/worker.ts`](file:///D:/backend/backend/src/worker.ts) |
| **A05: Security Misconfiguration** | • Fastify Helmet security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options).<br>• Strict CORS allowlist via environment configuration.<br>• Joi schema validation on startup failing fast on missing or weak configurations.<br>• Production non-root Docker execution with health check. | [`src/main.ts`](file:///D:/backend/backend/src/main.ts)<br>[`src/common/config/env.validation.ts`](file:///D:/backend/backend/src/common/config/env.validation.ts)<br>[`Dockerfile`](file:///D:/backend/backend/Dockerfile) |
| **A06: Vulnerable and Outdated Components** | • Dependabot automated weekly PRs for npm, Docker, GitHub Actions, and Terraform.<br>• GitHub Actions CI pipeline running `npm audit --audit-level=critical`.<br>• Container image vulnerability scanning with Trivy.<br>• CycloneDX SBOM generation in CI pipeline. | [`.github/dependabot.yml`](file:///D:/backend/backend/.github/dependabot.yml)<br>[`.github/workflows/ci.yml`](file:///D:/backend/backend/.github/workflows/ci.yml) |
| **A07: Identification and Authentication Failures** | • Mandatory TOTP MFA for doctor and admin accounts.<br>• Short-lived JWT access tokens (15 minutes).<br>• Rotating hashed refresh tokens with reuse detection family invalidation.<br>• Redis sliding-window rate limiting on login/MFA endpoints (5 req/min). | [`src/auth/services/mfa.service.ts`](file:///D:/backend/backend/src/auth/services/mfa.service.ts)<br>[`src/auth/services/token.service.ts`](file:///D:/backend/backend/src/auth/services/token.service.ts)<br>[`src/common/rate-limit/rate-limit.guard.ts`](file:///D:/backend/backend/src/common/rate-limit/rate-limit.guard.ts) |
| **A08: Software and Data Integrity Failures** | • Payment webhooks verified via HMAC-SHA256 with `crypto.timingSafeEqual` and 5-minute timestamp anti-replay tolerance.<br>• Partition-scoped cryptographic SHA-256 audit log hash chain.<br>• CI/CD pipeline gated by Semgrep SAST and Gitleaks secret scans. | [`src/payments/payments.service.ts`](file:///D:/backend/backend/src/payments/payments.service.ts)<br>[`src/audit/audit.service.ts`](file:///D:/backend/backend/src/audit/audit.service.ts)<br>[`.github/workflows/ci.yml`](file:///D:/backend/backend/.github/workflows/ci.yml) |
| **A09: Security Logging and Monitoring Failures** | • OpenTelemetry distributed tracing correlated with Pino structured JSON logs (`trace_id`, `span_id`).<br>• Automated PII/PHI redaction paths.<br>• Prometheus RED metrics per route and Google SRE multi-window burn-rate alerts for 99.95% SLO. | [`src/common/logger/logger.config.ts`](file:///D:/backend/backend/src/common/logger/logger.config.ts)<br>[`src/common/observability/metrics.service.ts`](file:///D:/backend/backend/src/common/observability/metrics.service.ts)<br>[`docker/prometheus-alerts.yaml`](file:///D:/backend/backend/docker/prometheus-alerts.yaml) |
| **A10: Server-Side Request Forgery (SSRF)** | • Outbound HTTP calls restricted strictly to internal services and payment provider behind `IPaymentProvider`.<br>• Zero user-supplied URLs fetched by the application. | [`src/payments/payments.service.ts`](file:///D:/backend/backend/src/payments/payments.service.ts) |

---

## 2. Data Classification Policy

| Classification Tier | Data Attributes | Storage Location | At-Rest Encryption | In-Transit Encryption | Access Policy | Retention |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Public** | Doctor public profile, specialties, languages, consultation fees, ratings, open slot schedules. | PostgreSQL (`doctors`, `profiles`), Redis cache. | Storage-level RDS KMS CMK. | TLS 1.3 / HTTPS. | Public read; doctor/admin write. | Indefinite. |
| **Internal** | Outbox events, idempotency keys, Prometheus metrics, cache keys. | PostgreSQL (`outbox_events`, `idempotency_keys`), Redis. | Storage-level RDS KMS CMK. | TLS 1.3 / Internal VPC. | Application service layer only. | 24 hours (idempotency); 7 days (outbox). |
| **Confidential** | User email, phone, password hash, TOTP secrets, payment intent IDs. | PostgreSQL (`users`, `profiles`, `payments`). | Argon2id (passwords); AES-256-GCM (TOTP); RDS KMS. | TLS 1.3 / HTTPS. | Owner patient/doctor, authenticated services. | Account lifespan + 7 years. |
| **PHI (Protected Health Info)** | Clinical consultation notes, diagnoses, prescription medications. | PostgreSQL (`consultations`, `prescriptions`). | **Field-level AES-256-GCM** with unique IVs + RDS KMS CMK. | TLS 1.3 / HTTPS. | Assigned doctor and patient owner only. Every access logged to audit trail. | 7 years (statutory requirement). |

---

## 3. Cryptographic Key Rotation Runbooks

### Runbook 1: AES-256-GCM PHI Data Encryption Keys
Field encryption uses the format `keyId:iv:tag:ciphertext`. The application supports multiple concurrent active decryption keys while using a single active encryption key.

1. **Generate New 256-bit Key**:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   # Output: 4f8b2c... (64 hex characters)
   ```
2. **Update Key Registry**:
   Update `ENCRYPTION_KEYS` in AWS Secrets Manager (or `.env`):
   ```json
   {
     "k1": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
     "k2": "4f8b2c9a1d3e5f7b0c2e4a6881923456789abcdef0123456789abcdef0123456"
   }
   ```
3. **Switch Active Key ID**:
   Set `ENCRYPTION_CURRENT_KEY_ID=k2`.
4. **Deploy Application**:
   Trigger rolling deployment. New prescriptions/notes will be encrypted using `k2`. Historical records encrypted under `k1` continue to decrypt seamlessly using key ID matching in [`EncryptionService`](file:///D:/backend/backend/src/common/crypto/encryption.service.ts).
5. **(Optional) Background Re-Encryption**:
   Run an offline migration script to read `k1` rows and write back using `k2`. Once zero rows reference `k1`, retire `k1` from the JSON dictionary.

### Runbook 2: JWT Signing Secret Rotation
1. **Generate New Secret**:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
   ```
2. **Deploy Dual-Verification Config**:
   Update environment configuration to support verifying against both the old and new secrets, while signing new tokens strictly with the new secret.
3. **Drain Old Access Tokens**:
   Because access tokens have a strict 15-minute TTL, wait 20 minutes for all legacy access tokens to expire or refresh.
4. **Decommission Legacy Secret**:
   Remove the old secret from the verification array.

### Runbook 3: Database Credential Rotation
1. **Leverage AWS Secrets Manager Multi-User Strategy**:
   The RDS module configures master credentials in AWS Secrets Manager.
2. **Dual-User Rotation**:
   The Lambda rotation function creates a secondary user (`amrutam_app_b`), copies privileges, updates the secret ARN, performs rolling ECS task restart, and drops the old user (`amrutam_app_a`) after connection draining. Zero downtime is incurred.

---

## 4. Automated Security Scanning & Verification

The CI/CD pipeline ([`.github/workflows/ci.yml`](file:///D:/backend/backend/.github/workflows/ci.yml)) automatically executes the following security checks on every pull request and push to `main`:

1. **Dependency Vulnerability Scan**:
   ```bash
   npm audit --audit-level=critical
   ```
   Fails pipeline if any critical severity CVE exists in direct or transitive dependencies.
2. **Secret Leak Detection**:
   Gitleaks scans git history and diffs for leaked API keys, tokens, or private keys.
3. **Static Application Security Testing (SAST)**:
   Semgrep analyzes TypeScript code for OWASP security flaws, unsafe SQL, and insecure crypto usage.
4. **Container Image & OS Scanning**:
   Trivy scans the production Docker image for known OS vulnerabilities (`HIGH` and `CRITICAL` fixable CVEs fail the build).
5. **Software Bill of Materials (SBOM)**:
   CycloneDX generates a formal SBOM artifact uploaded with the build release.

---

## 5. Honest Assessment: What is NOT Done (Scope Boundaries)

To maintain architectural transparency, the following items are intentionally omitted or simplified for this take-home implementation:

1. **Local AWS KMS Integration**: In production Terraform, an AWS KMS Customer Managed Key (CMK) is provisioned. In local development and testing, [`EnvKeyProvider`](file:///D:/backend/backend/src/common/crypto/env-key-provider.ts) simulates key management via environment variables rather than requiring local KMS mocks (LocalStack).
2. **Real PCI-DSS Gateway Certification**: The payment module uses a realistic mock provider behind the [`IPaymentProvider`](file:///D:/backend/backend/src/payments/payment-provider.interface.ts) interface with HMAC verification, timeouts, and circuit breakers. Integrating a live Stripe or Razorpay gateway with PCI-DSS SAQ-A compliance is out of scope.
3. **WebRTC Media Stream Infrastructure**: The backend orchestrates consultation scheduling, state transitions, billing, and prescriptions. Real-time video/audio media transmission (e.g., via Agora, LiveKit, or Twilio) is not implemented.
4. **SMS/Email Gateway Delivery**: Two-factor authentication (TOTP) and audit logging are fully implemented; external transactional email (SES) and SMS delivery (Twilio) are logged via structured events rather than sending actual SMS/emails.
5. **Multi-Region Active-Active PostgreSQL**: The database architecture uses multi-AZ primary/standby failover (< 2 min RTO) and cross-region backup replication. Active-active multi-region database replication (e.g., CockroachDB or Aurora Global) was not implemented due to complexity and cost.
