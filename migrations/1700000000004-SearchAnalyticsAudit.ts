import { MigrationInterface, QueryRunner } from 'typeorm';

export class SearchAnalyticsAudit1700000000004 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Install pg_trgm for trigram typo-tolerance
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

    // 2. Add languages, rating_avg, rating_count to doctors
    await queryRunner.query(`
      ALTER TABLE doctors
        ADD COLUMN IF NOT EXISTS languages TEXT[] NOT NULL DEFAULT '{"English"}',
        ADD COLUMN IF NOT EXISTS rating_avg NUMERIC(3,2) NOT NULL DEFAULT 0.00,
        ADD COLUMN IF NOT EXISTS rating_count INT NOT NULL DEFAULT 0;
    `);

    // 3. Create indexes for doctor search & filtering
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_doctors_languages
        ON doctors USING gin(languages);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_doctors_fee_rating
        ON doctors(fee_cents, rating_avg DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_profiles_name_trgm
        ON profiles USING gin((first_name || ' ' || last_name) gin_trgm_ops);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_doctors_bio_trgm
        ON doctors USING gin(bio gin_trgm_ops);
    `);

    // 4. Create Materialized View for Admin Analytics
    await queryRunner.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS daily_consultation_analytics_mv AS
      SELECT
        date_trunc('day', c.created_at)::date AS day,
        c.doctor_id,
        count(*)::int AS total_consultations,
        count(*) FILTER (WHERE c.status = 'COMPLETED')::int AS completed_count,
        count(*) FILTER (WHERE c.status = 'CANCELLED')::int AS cancelled_count,
        count(*) FILTER (WHERE c.status = 'NO_SHOW')::int AS no_show_count,
        count(*) FILTER (WHERE c.status = 'PENDING_PAYMENT')::int AS pending_payment_count,
        count(*) FILTER (WHERE c.status = 'CONFIRMED')::int AS confirmed_count,
        coalesce(sum(p.amount_cents) FILTER (WHERE p.status = 'SUCCESS'), 0)::bigint AS revenue_cents
      FROM consultations c
      LEFT JOIN payments p ON p.consultation_id = c.id AND p.status = 'SUCCESS'
      GROUP BY date_trunc('day', c.created_at)::date, c.doctor_id;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_analytics_mv_day_doctor
        ON daily_consultation_analytics_mv(day, doctor_id);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_daily_analytics_mv_day
        ON daily_consultation_analytics_mv(day);
    `);

    // 5. Create app role with REVOKE UPDATE/DELETE on audit_logs
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'amrutam_app') THEN
          CREATE ROLE amrutam_app WITH LOGIN PASSWORD 'amrutam_app_pw';
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      GRANT CONNECT ON DATABASE amrutam TO amrutam_app;
      GRANT USAGE ON SCHEMA public TO amrutam_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO amrutam_app;
      REVOKE UPDATE, DELETE ON audit_logs FROM amrutam_app;
    `);

    // Revoke UPDATE/DELETE on all child audit_logs partition tables as well
    await queryRunner.query(`
      DO $$
      DECLARE
        r RECORD;
      BEGIN
        FOR r IN (
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename LIKE 'audit_logs_%'
        ) LOOP
          EXECUTE 'REVOKE UPDATE, DELETE ON ' || quote_ident(r.tablename) || ' FROM amrutam_app';
        END LOOP;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS daily_consultation_analytics_mv;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_doctors_bio_trgm;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_profiles_name_trgm;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_doctors_fee_rating;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_doctors_languages;`);
    await queryRunner.query(`
      ALTER TABLE doctors
        DROP COLUMN IF EXISTS rating_count,
        DROP COLUMN IF EXISTS rating_avg,
        DROP COLUMN IF EXISTS languages;
    `);
  }
}
