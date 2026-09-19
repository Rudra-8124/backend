import { MigrationInterface, QueryRunner } from 'typeorm';

export class AvailabilityBooking1700000000002 implements MigrationInterface {
  name = 'AvailabilityBooking1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add timezone to profiles
    await queryRunner.query(`
      ALTER TABLE profiles ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) NOT NULL DEFAULT 'UTC';
    `);

    // 2. Add hold_expires_at to availability_slots (propagated across all partitions)
    await queryRunner.query(`
      ALTER TABLE availability_slots ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ;
    `);

    // Also copy any existing held_until to hold_expires_at
    await queryRunner.query(`
      UPDATE availability_slots SET hold_expires_at = held_until WHERE hold_expires_at IS NULL AND held_until IS NOT NULL;
    `);

    // Index on hold_expires_at for fast hold-expiry queries
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_slots_hold_expires ON availability_slots(hold_expires_at) WHERE status = 'HELD';
    `);

    // 3. Update idempotency_keys table
    await queryRunner.query(`
      ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS endpoint VARCHAR(255) NOT NULL DEFAULT '';
      ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS';
      ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
      ALTER TABLE idempotency_keys ALTER COLUMN response_status DROP NOT NULL;
      ALTER TABLE idempotency_keys ALTER COLUMN response_body DROP NOT NULL;
    `);

    // Drop old unique index and create new compound index (user_id, endpoint, idempotency_key)
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_idemp_user_key;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_idemp_user_endpoint_key ON idempotency_keys(user_id, endpoint, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_idemp_status ON idempotency_keys(status);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_idemp_status;
      DROP INDEX IF EXISTS idx_idemp_user_endpoint_key;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_idemp_user_key ON idempotency_keys(user_id, idempotency_key);
      ALTER TABLE idempotency_keys DROP COLUMN IF EXISTS updated_at;
      ALTER TABLE idempotency_keys DROP COLUMN IF EXISTS status;
      ALTER TABLE idempotency_keys DROP COLUMN IF EXISTS endpoint;
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_slots_hold_expires;
      ALTER TABLE availability_slots DROP COLUMN IF EXISTS hold_expires_at;
    `);

    await queryRunner.query(`
      ALTER TABLE profiles DROP COLUMN IF EXISTS timezone;
    `);
  }
}
