# ER Diagram

## Overview

8 core tables (assignment-required) + 5 supporting tables.
Three tables are **range-partitioned by month** (`partition_month DATE`):
`availability_slots`, `consultations`, `audit_logs`.

Postgres rules for partitioned tables that shape this design:
1. **Partition key must be in every PK and UNIQUE constraint** on the partitioned table.
2. **Foreign keys referencing a partitioned table are not supported** (PG 16 still).
   → We use application-level referential integrity for FKs *into* partitioned tables
   and document which columns are logical FKs.
3. **Exclusion constraints are not supported** on partitioned tables.
   → Double-booking prevention uses conditional UPDATE (optimistic lock) instead.

### Partitioning Strategy

- `partition_month` is a computed `DATE` column set to the first day of the month
  derived from the row's timestamp (`date_trunc('month', scheduled_start)`).
- PKs on partitioned tables: `(id, partition_month)`.
- All references *to* a partitioned table carry both `id` and `partition_month`
  in the referencing table so the application can route queries to the correct
  partition. Since PG cannot enforce the FK, a nightly consistency-check job
  verifies referential integrity and logs violations to audit.

```mermaid
erDiagram
    users ||--o| profiles : "has"
    users ||--o| doctors : "may be"
    users ||--o{ refresh_tokens : "has"
    users ||--o{ mfa_recovery_codes : "has"
    doctors ||--o{ availability_slots : "creates"
    availability_slots ||--o| consultations : "booked as"
    consultations ||--o{ prescriptions : "has"
    consultations ||--o| payments : "paid via"
    consultations ||--o{ outbox_events : "emits"
    users ||--o{ audit_logs : "generates"
    users ||--o{ idempotency_keys : "sends"
    payments ||--o{ processed_webhook_events : "receives"

    users {
        uuid id PK
        varchar_255 email UK
        varchar_255 password_hash
        enum role "patient | doctor | admin"
        boolean mfa_enabled
        varchar_255 mfa_secret "encrypted, nullable"
        boolean is_active
        timestamptz created_at
        timestamptz updated_at
    }

    profiles {
        uuid id PK
        uuid user_id FK-UK "users.id"
        varchar_255 first_name
        varchar_255 last_name
        varchar_20 phone "nullable"
        varchar_255 city "nullable"
        date date_of_birth "nullable"
        enum gender "nullable"
        timestamptz created_at
        timestamptz updated_at
    }

    doctors {
        uuid id PK
        uuid user_id FK-UK "users.id"
        text bio "nullable"
        varchar_255 license_number UK
        varchar_255 specializations "text[] array"
        integer experience_years
        integer fee_cents
        tsvector search_vector "GIN-indexed"
        boolean is_verified
        timestamptz created_at
        timestamptz updated_at
    }

    availability_slots {
        uuid id "PK with partition_month"
        date partition_month "PK, partition key"
        uuid doctor_id "logical FK to doctors.id"
        timestamptz start_time
        timestamptz end_time
        enum status "AVAILABLE | HELD | RESERVED | BOOKED | COMPLETED | CANCELLED | BLOCKED"
        uuid held_by "nullable, logical FK users.id"
        timestamptz held_until "nullable"
        timestamptz created_at
        timestamptz updated_at
    }

    consultations {
        uuid id "PK with partition_month"
        date partition_month "PK, partition key"
        uuid patient_id "logical FK users.id"
        uuid doctor_id "logical FK doctors.id"
        uuid slot_id "logical FK"
        date slot_partition_month "for partition routing"
        enum status "PENDING_PAYMENT | CONFIRMED | IN_PROGRESS | COMPLETED | CANCELLED"
        timestamptz scheduled_start
        timestamptz scheduled_end
        text reason "nullable"
        text notes_encrypted "AES-256-GCM, nullable"
        varchar_20 encryption_key_id "nullable"
        text cancellation_reason "nullable"
        timestamptz created_at
        timestamptz updated_at
    }

    prescriptions {
        uuid id PK
        uuid consultation_id "logical FK"
        date consultation_partition_month "for partition routing"
        uuid doctor_id "logical FK"
        uuid patient_id "logical FK"
        text medications_encrypted "AES-256-GCM JSON"
        text diagnosis_encrypted "AES-256-GCM"
        text notes_encrypted "AES-256-GCM, nullable"
        varchar_20 encryption_key_id
        timestamptz created_at
    }

    payments {
        uuid id PK
        uuid consultation_id "logical FK"
        date consultation_partition_month "for partition routing"
        varchar_255 payment_intent_id "nullable UK"
        integer amount_cents
        varchar_3 currency "default USD"
        enum status "PENDING | SUCCESS | FAILED | REFUNDED"
        varchar_255 provider_reference "nullable"
        jsonb metadata "nullable"
        timestamptz created_at
        timestamptz updated_at
    }

    audit_logs {
        uuid id "PK with partition_month"
        date partition_month "PK, partition key"
        uuid actor_id "logical FK users.id, nullable for system"
        varchar_100 action
        varchar_100 resource_type
        uuid resource_id "nullable"
        inet ip_address
        uuid request_id
        jsonb metadata "no PII/PHI"
        varchar_128 previous_hash
        varchar_128 hash "SHA-256 chain"
        timestamptz created_at
    }

    refresh_tokens {
        uuid id PK
        uuid user_id FK "users.id"
        varchar_255 token_hash UK
        varchar_64 family_id "for rotation detection"
        boolean is_revoked
        timestamptz expires_at
        timestamptz created_at
    }

    mfa_recovery_codes {
        uuid id PK
        uuid user_id FK "users.id"
        varchar_255 code_hash
        boolean is_used
        timestamptz created_at
    }

    idempotency_keys {
        uuid id PK
        uuid user_id FK "users.id"
        varchar_255 idempotency_key
        varchar_64 request_hash "SHA-256 of body"
        smallint response_status
        jsonb response_body
        timestamptz created_at
        timestamptz expires_at
    }

    outbox_events {
        bigint id PK "auto-increment"
        varchar_100 event_type
        uuid aggregate_id
        varchar_50 aggregate_type
        jsonb payload
        enum status "PENDING | PROCESSING | PROCESSED | FAILED"
        smallint retry_count "default 0"
        timestamptz created_at
        timestamptz updated_at
        timestamptz processed_at "nullable"
    }

    processed_webhook_events {
        uuid id PK
        varchar_50 provider
        varchar_255 event_id
        jsonb response_body
        timestamptz created_at
    }
```

---

## Table Details

### 1. `users` (non-partitioned)

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK, default `gen_random_uuid()` |
| email | VARCHAR(255) | UNIQUE, NOT NULL |
| password_hash | VARCHAR(255) | NOT NULL |
| role | ENUM ('patient','doctor','admin') | NOT NULL, default 'patient' |
| mfa_enabled | BOOLEAN | NOT NULL, default false |
| mfa_secret | VARCHAR(255) | NULLABLE (encrypted TOTP secret) |
| is_active | BOOLEAN | NOT NULL, default true |
| created_at | TIMESTAMPTZ | NOT NULL, default now() |
| updated_at | TIMESTAMPTZ | NOT NULL, default now() |

**Indexes**: `idx_users_email` (UNIQUE on `email`), `idx_users_role` (B-tree on `role`).

---

### 2. `profiles` (non-partitioned)

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| user_id | UUID | FK → users.id, UNIQUE, NOT NULL |
| first_name | VARCHAR(255) | NOT NULL |
| last_name | VARCHAR(255) | NOT NULL |
| phone | VARCHAR(20) | NULLABLE |
| city | VARCHAR(255) | NULLABLE |
| date_of_birth | DATE | NULLABLE |
| gender | ENUM ('male','female','other') | NULLABLE |
| created_at | TIMESTAMPTZ | NOT NULL |
| updated_at | TIMESTAMPTZ | NOT NULL |

**Indexes**: `idx_profiles_user_id` (UNIQUE on `user_id`), `idx_profiles_city` (B-tree on `city`).

---

### 3. `doctors` (non-partitioned)

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| user_id | UUID | FK → users.id, UNIQUE, NOT NULL |
| bio | TEXT | NULLABLE |
| license_number | VARCHAR(255) | UNIQUE, NOT NULL |
| specializations | TEXT[] | NOT NULL |
| experience_years | INTEGER | NOT NULL |
| fee_cents | INTEGER | NOT NULL |
| search_vector | TSVECTOR | NULLABLE |
| is_verified | BOOLEAN | NOT NULL, default false |
| created_at | TIMESTAMPTZ | NOT NULL |
| updated_at | TIMESTAMPTZ | NOT NULL |

**Indexes**: `idx_doctors_user_id` (UNIQUE), `idx_doctors_license` (UNIQUE), `idx_doctors_search` (GIN on `search_vector`), `idx_doctors_specializations` (GIN on `specializations`).

---

### 4. `availability_slots` (RANGE-PARTITIONED by `partition_month`)

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | NOT NULL |
| partition_month | DATE | NOT NULL (1st of month) |
| doctor_id | UUID | NOT NULL (logical FK → doctors.id) |
| start_time | TIMESTAMPTZ | NOT NULL |
| end_time | TIMESTAMPTZ | NOT NULL |
| status | ENUM | NOT NULL, default 'AVAILABLE' |
| held_by | UUID | NULLABLE (logical FK → users.id) |
| held_until | TIMESTAMPTZ | NULLABLE |
| created_at | TIMESTAMPTZ | NOT NULL |
| updated_at | TIMESTAMPTZ | NOT NULL |

**PK**: `(id, partition_month)` — partition key must be in PK.
**Unique**: `(doctor_id, start_time, partition_month)` — prevents overlapping slots per doctor.
**Indexes**:
- `idx_slots_doctor_status` — `(doctor_id, status, partition_month)` for availability queries.
- `idx_slots_held_until` — `(held_until) WHERE status = 'HELD'` partial index for cleanup.
- `idx_slots_start_time` — `(start_time, partition_month)` for date-range scans.

**No FK from PG**: `doctor_id` is not a real FK because PG 16 does not support FK references *from* a partitioned child to a non-partitioned parent reliably across partitions. Enforced at application layer.

---

### 5. `consultations` (RANGE-PARTITIONED by `partition_month`)

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | NOT NULL |
| partition_month | DATE | NOT NULL |
| patient_id | UUID | NOT NULL (logical FK → users.id) |
| doctor_id | UUID | NOT NULL (logical FK → doctors.id) |
| slot_id | UUID | NOT NULL (logical FK → availability_slots.id) |
| slot_partition_month | DATE | NOT NULL |
| status | ENUM | NOT NULL, default 'PENDING_PAYMENT' |
| scheduled_start | TIMESTAMPTZ | NOT NULL |
| scheduled_end | TIMESTAMPTZ | NOT NULL |
| reason | TEXT | NULLABLE |
| notes_encrypted | TEXT | NULLABLE (AES-256-GCM) |
| encryption_key_id | VARCHAR(20) | NULLABLE |
| cancellation_reason | TEXT | NULLABLE |
| created_at | TIMESTAMPTZ | NOT NULL |
| updated_at | TIMESTAMPTZ | NOT NULL |

**PK**: `(id, partition_month)`.
**Unique**: `(slot_id, slot_partition_month, partition_month) WHERE status NOT IN ('CANCELLED')` — partial unique index preventing double-booking at DB level.
**Indexes**:
- `idx_consult_patient` — `(patient_id, partition_month, status)`.
- `idx_consult_doctor` — `(doctor_id, partition_month, status)`.
- `idx_consult_status_created` — `(status, created_at, partition_month)` for timeout job scans.
- `idx_consult_slot` — `(slot_id, slot_partition_month, partition_month)` for slot lookup.

---

### 6. `prescriptions` (non-partitioned)

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| consultation_id | UUID | NOT NULL (logical FK) |
| consultation_partition_month | DATE | NOT NULL |
| doctor_id | UUID | NOT NULL (logical FK) |
| patient_id | UUID | NOT NULL (logical FK) |
| medications_encrypted | TEXT | NOT NULL (AES-256-GCM JSON) |
| diagnosis_encrypted | TEXT | NOT NULL (AES-256-GCM) |
| notes_encrypted | TEXT | NULLABLE (AES-256-GCM) |
| encryption_key_id | VARCHAR(20) | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL |

**Indexes**: `idx_rx_consultation` on `(consultation_id, consultation_partition_month)`, `idx_rx_patient` on `(patient_id)`.

**Why not partitioned**: Prescriptions are always accessed via consultation_id. Volume (~29M/year) is manageable without partitioning. If needed later, can partition by `created_at` month.

---

### 7. `payments` (non-partitioned)

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| consultation_id | UUID | NOT NULL (logical FK) |
| consultation_partition_month | DATE | NOT NULL |
| payment_intent_id | VARCHAR(255) | NULLABLE, UNIQUE |
| amount_cents | INTEGER | NOT NULL |
| currency | VARCHAR(3) | NOT NULL, default 'INR' |
| status | ENUM | NOT NULL, default 'PENDING' |
| provider_reference | VARCHAR(255) | NULLABLE |
| metadata | JSONB | NULLABLE |
| created_at | TIMESTAMPTZ | NOT NULL |
| updated_at | TIMESTAMPTZ | NOT NULL |

**Indexes**: `idx_pay_consultation` on `(consultation_id, consultation_partition_month)`, `idx_pay_intent` (UNIQUE on `payment_intent_id`), `idx_pay_status` on `(status)`.

**Why not partitioned**: Payments are 1:1 with consultations; always accessed by consultation_id or payment_intent_id. Volume manageable.

---

### 8. `audit_logs` (RANGE-PARTITIONED by `partition_month`)

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | NOT NULL |
| partition_month | DATE | NOT NULL |
| actor_id | UUID | NULLABLE (system actions have no actor) |
| action | VARCHAR(100) | NOT NULL |
| resource_type | VARCHAR(100) | NOT NULL |
| resource_id | UUID | NULLABLE |
| ip_address | INET | NULLABLE |
| request_id | UUID | NULLABLE |
| metadata | JSONB | NULLABLE (no PII/PHI) |
| previous_hash | VARCHAR(128) | NOT NULL (empty string for first entry) |
| hash | VARCHAR(128) | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL |

**PK**: `(id, partition_month)`.
**Indexes**:
- `idx_audit_actor` — `(actor_id, partition_month)`.
- `idx_audit_resource` — `(resource_type, resource_id, partition_month)`.
- `idx_audit_action` — `(action, partition_month)`.
- `idx_audit_created` — `(created_at, partition_month)` for time-range queries.

**Append-only**: The application DB role (`app_role`) has `GRANT INSERT ON audit_logs`. No UPDATE or DELETE granted. Admin queries use a read-only role.

**Hash chain scope**: Per-partition (monthly). See [ADR: Audit Hash Chain](adr/005-audit-hash-chain.md). Each partition maintains its own chain; `previous_hash` references the last entry in the same partition. This avoids serializing all writes globally while still detecting tampering within a partition boundary.

---

### 9. `refresh_tokens` (non-partitioned)

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| user_id | UUID | FK → users.id, NOT NULL |
| token_hash | VARCHAR(255) | UNIQUE, NOT NULL |
| family_id | VARCHAR(64) | NOT NULL |
| is_revoked | BOOLEAN | NOT NULL, default false |
| expires_at | TIMESTAMPTZ | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL |

**Indexes**: `idx_rt_user` on `(user_id)`, `idx_rt_family` on `(family_id)`, `idx_rt_expires` on `(expires_at)` for cleanup.

---

### 10. `mfa_recovery_codes` (non-partitioned)

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| user_id | UUID | FK → users.id, NOT NULL |
| code_hash | VARCHAR(255) | NOT NULL |
| is_used | BOOLEAN | NOT NULL, default false |
| created_at | TIMESTAMPTZ | NOT NULL |

**Indexes**: `idx_mfa_rc_user` on `(user_id)`.

---

### 11. `idempotency_keys` (non-partitioned)

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| user_id | UUID | FK → users.id, NOT NULL |
| idempotency_key | VARCHAR(255) | NOT NULL |
| request_hash | VARCHAR(64) | NOT NULL |
| response_status | SMALLINT | NOT NULL |
| response_body | JSONB | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL |
| expires_at | TIMESTAMPTZ | NOT NULL |

**Unique**: `(user_id, idempotency_key)` — scoped per user.
**Indexes**: `idx_idemp_expires` on `(expires_at)` for cleanup cron (TTL 7 days).

---

### 12. `outbox_events` (non-partitioned, pruned)

| Column | Type | Constraints |
|--------|------|-------------|
| id | BIGINT | PK, auto-increment |
| event_type | VARCHAR(100) | NOT NULL |
| aggregate_id | UUID | NOT NULL |
| aggregate_type | VARCHAR(50) | NOT NULL |
| payload | JSONB | NOT NULL |
| status | ENUM | NOT NULL, default 'PENDING' |
| retry_count | SMALLINT | NOT NULL, default 0 |
| created_at | TIMESTAMPTZ | NOT NULL |
| updated_at | TIMESTAMPTZ | NOT NULL |
| processed_at | TIMESTAMPTZ | NULLABLE |

**Indexes**: `idx_outbox_pending` — `(status, created_at) WHERE status IN ('PENDING','PROCESSING')` partial index for the poller. `idx_outbox_aggregate` — `(aggregate_type, aggregate_id)`.

**Pruning**: Processed events older than 7 days deleted by a scheduled BullMQ job.

---

### 13. `processed_webhook_events` (non-partitioned)

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| provider | VARCHAR(50) | NOT NULL |
| event_id | VARCHAR(255) | NOT NULL |
| response_body | JSONB | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL |

**Unique**: `(provider, event_id)` — guarantees webhook idempotency.
**Indexes**: `idx_webhook_expires` on `(created_at)` for cleanup.
