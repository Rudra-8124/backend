import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConsultationsPrescriptionsPayments1700000000003 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add NO_SHOW to consultation_status enum
    await queryRunner.query(`
      ALTER TYPE consultation_status ADD VALUE IF NOT EXISTS 'NO_SHOW';
    `);

    // 2. Add version and payment_intent_id to consultations table
    await queryRunner.query(`
      ALTER TABLE consultations
        ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS payment_intent_id VARCHAR(255);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_consult_payment_intent
        ON consultations(payment_intent_id);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_consult_timeout
        ON consultations(status, created_at)
        WHERE status = 'PENDING_PAYMENT';
    `);

    // 3. Add attempts, error, next_retry_at to outbox_events
    await queryRunner.query(`
      ALTER TABLE outbox_events
        ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS error TEXT,
        ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_outbox_processing
        ON outbox_events(status, updated_at);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_outbox_retry
        ON outbox_events(status, next_retry_at)
        WHERE status IN ('PENDING', 'FAILED');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_outbox_retry;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_outbox_processing;`);
    await queryRunner.query(`
      ALTER TABLE outbox_events
        DROP COLUMN IF EXISTS next_retry_at,
        DROP COLUMN IF EXISTS error,
        DROP COLUMN IF EXISTS attempts;
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_consult_timeout;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_consult_payment_intent;`);
    await queryRunner.query(`
      ALTER TABLE consultations
        DROP COLUMN IF EXISTS payment_intent_id,
        DROP COLUMN IF EXISTS version;
    `);
  }
}
