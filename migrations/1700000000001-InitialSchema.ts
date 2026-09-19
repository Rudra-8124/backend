import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1700000000001 implements MigrationInterface {
  name = 'InitialSchema1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ──────────────────────────────────────────────────
    // 1. ENUM types
    // ──────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE user_role AS ENUM ('patient', 'doctor', 'admin');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE slot_status AS ENUM ('AVAILABLE','HELD','RESERVED','BOOKED','COMPLETED','CANCELLED','BLOCKED');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE consultation_status AS ENUM ('PENDING_PAYMENT','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE payment_status AS ENUM ('PENDING','SUCCESS','FAILED','REFUNDED');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE outbox_status AS ENUM ('PENDING','PROCESSING','PROCESSED','FAILED');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // ──────────────────────────────────────────────────
    // 2. Non-partitioned tables
    // ──────────────────────────────────────────────────

    // users
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email         VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role          user_role NOT NULL DEFAULT 'patient',
        mfa_enabled   BOOLEAN NOT NULL DEFAULT false,
        mfa_secret    VARCHAR(255),
        is_active     BOOLEAN NOT NULL DEFAULT true,
        is_verified   BOOLEAN NOT NULL DEFAULT false,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);`);

    // profiles
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        first_name    VARCHAR(255) NOT NULL,
        last_name     VARCHAR(255) NOT NULL,
        phone         VARCHAR(20),
        city          VARCHAR(255),
        date_of_birth DATE,
        gender        VARCHAR(10),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_profiles_city ON profiles(city);`);

    // doctors
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS doctors (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bio               TEXT,
        license_number    VARCHAR(255) NOT NULL,
        specializations   TEXT[] NOT NULL DEFAULT '{}',
        experience_years  INT NOT NULL DEFAULT 0,
        fee_cents         INT NOT NULL DEFAULT 0,
        search_vector     TSVECTOR,
        is_verified       BOOLEAN NOT NULL DEFAULT false,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_doctors_user_id ON doctors(user_id);`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_doctors_license ON doctors(license_number);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_doctors_search ON doctors USING gin(search_vector);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_doctors_specializations ON doctors USING gin(specializations);`,
    );

    // Search vector trigger
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION doctors_search_vector_update() RETURNS trigger AS $$
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('english', coalesce(NEW.bio, '')), 'B') ||
          setweight(to_tsvector('english', array_to_string(NEW.specializations, ' ')), 'A');
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_doctors_search_vector ON doctors;
      CREATE TRIGGER trg_doctors_search_vector
        BEFORE INSERT OR UPDATE OF bio, specializations ON doctors
        FOR EACH ROW EXECUTE FUNCTION doctors_search_vector_update();
    `);

    // refresh_tokens
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash  VARCHAR(255) NOT NULL,
        family_id   VARCHAR(64) NOT NULL,
        is_revoked  BOOLEAN NOT NULL DEFAULT false,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_rt_token_hash ON refresh_tokens(token_hash);`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens(user_id);`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_rt_family ON refresh_tokens(family_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_rt_expires ON refresh_tokens(expires_at);`,
    );

    // mfa_recovery_codes
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash   VARCHAR(255) NOT NULL,
        is_used     BOOLEAN NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mfa_rc_user ON mfa_recovery_codes(user_id);`,
    );

    // prescriptions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS prescriptions (
        id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        consultation_id               UUID NOT NULL,
        consultation_partition_month   DATE NOT NULL,
        doctor_id                     UUID NOT NULL,
        patient_id                    UUID NOT NULL,
        medications_encrypted         TEXT NOT NULL,
        diagnosis_encrypted           TEXT NOT NULL,
        notes_encrypted               TEXT,
        encryption_key_id             VARCHAR(20) NOT NULL,
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_rx_consultation ON prescriptions(consultation_id, consultation_partition_month);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_rx_patient ON prescriptions(patient_id);`,
    );

    // payments
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        consultation_id               UUID NOT NULL,
        consultation_partition_month   DATE NOT NULL,
        payment_intent_id             VARCHAR(255),
        amount_cents                  INT NOT NULL,
        currency                      VARCHAR(3) NOT NULL DEFAULT 'INR',
        status                        payment_status NOT NULL DEFAULT 'PENDING',
        provider_reference            VARCHAR(255),
        metadata                      JSONB,
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_intent ON payments(payment_intent_id) WHERE payment_intent_id IS NOT NULL;`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_pay_consultation ON payments(consultation_id, consultation_partition_month);`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_pay_status ON payments(status);`);

    // idempotency_keys
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key  VARCHAR(255) NOT NULL,
        request_hash     VARCHAR(64) NOT NULL,
        response_status  SMALLINT NOT NULL,
        response_body    JSONB NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at       TIMESTAMPTZ NOT NULL
      );
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_idemp_user_key ON idempotency_keys(user_id, idempotency_key);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_idemp_expires ON idempotency_keys(expires_at);`,
    );

    // outbox_events
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS outbox_events (
        id              BIGSERIAL PRIMARY KEY,
        event_type      VARCHAR(100) NOT NULL,
        aggregate_id    UUID NOT NULL,
        aggregate_type  VARCHAR(50) NOT NULL,
        payload         JSONB NOT NULL,
        status          VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        retry_count     SMALLINT NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at    TIMESTAMPTZ
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, created_at) WHERE status IN ('PENDING','PROCESSING');`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_outbox_aggregate ON outbox_events(aggregate_type, aggregate_id);`,
    );

    // processed_webhook_events
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS processed_webhook_events (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider       VARCHAR(50) NOT NULL,
        event_id       VARCHAR(255) NOT NULL,
        response_body  JSONB NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_provider_event ON processed_webhook_events(provider, event_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_webhook_created ON processed_webhook_events(created_at);`,
    );

    // ──────────────────────────────────────────────────
    // 3. Partitioned tables
    // ──────────────────────────────────────────────────

    // availability_slots (partitioned by month)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS availability_slots (
        id              UUID NOT NULL,
        partition_month DATE NOT NULL,
        doctor_id       UUID NOT NULL,
        start_time      TIMESTAMPTZ NOT NULL,
        end_time        TIMESTAMPTZ NOT NULL,
        status          slot_status NOT NULL DEFAULT 'AVAILABLE',
        held_by         UUID,
        held_until      TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (id, partition_month)
      ) PARTITION BY RANGE (partition_month);
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_slots_doctor_status ON availability_slots(doctor_id, status, partition_month);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_slots_start_time ON availability_slots(start_time, partition_month);`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_doctor_time ON availability_slots(doctor_id, start_time, partition_month);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_slots_held_until ON availability_slots(held_until) WHERE status = 'HELD';`,
    );

    // consultations (partitioned by month)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS consultations (
        id                    UUID NOT NULL,
        partition_month       DATE NOT NULL,
        patient_id            UUID NOT NULL,
        doctor_id             UUID NOT NULL,
        slot_id               UUID NOT NULL,
        slot_partition_month  DATE NOT NULL,
        status                consultation_status NOT NULL DEFAULT 'PENDING_PAYMENT',
        scheduled_start       TIMESTAMPTZ NOT NULL,
        scheduled_end         TIMESTAMPTZ NOT NULL,
        reason                TEXT,
        notes_encrypted       TEXT,
        encryption_key_id     VARCHAR(20),
        cancellation_reason   TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (id, partition_month)
      ) PARTITION BY RANGE (partition_month);
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_consult_patient ON consultations(patient_id, partition_month, status);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_consult_doctor ON consultations(doctor_id, partition_month, status);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_consult_status_created ON consultations(status, created_at, partition_month);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_consult_slot ON consultations(slot_id, slot_partition_month, partition_month);`,
    );

    // audit_logs (partitioned by month)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id              UUID NOT NULL,
        partition_month DATE NOT NULL,
        actor_id        UUID,
        action          VARCHAR(100) NOT NULL,
        resource_type   VARCHAR(100) NOT NULL,
        resource_id     UUID,
        ip_address      INET,
        request_id      UUID,
        metadata        JSONB,
        previous_hash   VARCHAR(128) NOT NULL,
        hash            VARCHAR(128) NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (id, partition_month)
      ) PARTITION BY RANGE (partition_month);
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id, partition_month);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id, partition_month);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, partition_month);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at, partition_month);`,
    );

    // ──────────────────────────────────────────────────
    // 4. ensure_partitions() function + initial partitions
    // ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ensure_partitions(months_ahead INT DEFAULT 3)
      RETURNS void AS $$
      DECLARE
        tbl TEXT;
        month_start DATE;
        month_end DATE;
        partition_name TEXT;
        i INT;
      BEGIN
        FOR tbl IN SELECT unnest(ARRAY['availability_slots', 'consultations', 'audit_logs']) LOOP
          FOR i IN 0..months_ahead LOOP
            month_start := date_trunc('month', CURRENT_DATE)::date + (i || ' months')::interval;
            month_end   := month_start + '1 month'::interval;
            partition_name := tbl || '_y' || to_char(month_start, 'YYYY') || 'm' || to_char(month_start, 'MM');

            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
              EXECUTE format(
                'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                partition_name, tbl, month_start, month_end
              );
              RAISE NOTICE 'Created partition: %', partition_name;
            END IF;
          END LOOP;
        END LOOP;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Create initial partitions (current month + 3 ahead)
    await queryRunner.query(`SELECT ensure_partitions(3);`);

    // ──────────────────────────────────────────────────
    // 5. Default partitions (catch-all safety net)
    // ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS availability_slots_default PARTITION OF availability_slots DEFAULT;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS consultations_default PARTITION OF consultations DEFAULT;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS audit_logs_default PARTITION OF audit_logs DEFAULT;
    `);

    // ──────────────────────────────────────────────────
    // 6. Updated_at trigger for auto-updating timestamps
    // ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS trigger AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    const tablesWithUpdatedAt = ['users', 'profiles', 'doctors', 'payments', 'outbox_events'];
    for (const tbl of tablesWithUpdatedAt) {
      await queryRunner.query(`
        DROP TRIGGER IF EXISTS trg_${tbl}_updated_at ON ${tbl};
        CREATE TRIGGER trg_${tbl}_updated_at
          BEFORE UPDATE ON ${tbl}
          FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse dependency order
    const tables = [
      'audit_logs_default',
      'consultations_default',
      'availability_slots_default',
      'processed_webhook_events',
      'outbox_events',
      'idempotency_keys',
      'mfa_recovery_codes',
      'refresh_tokens',
      'prescriptions',
      'payments',
      'audit_logs',
      'consultations',
      'availability_slots',
      'doctors',
      'profiles',
      'users',
    ];
    for (const t of tables) {
      await queryRunner.query(`DROP TABLE IF EXISTS ${t} CASCADE;`);
    }

    await queryRunner.query(`DROP FUNCTION IF EXISTS ensure_partitions;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS update_updated_at_column;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS doctors_search_vector_update;`);

    const types = [
      'outbox_status',
      'payment_status',
      'consultation_status',
      'slot_status',
      'user_role',
    ];
    for (const t of types) {
      await queryRunner.query(`DROP TYPE IF EXISTS ${t};`);
    }
  }
}
