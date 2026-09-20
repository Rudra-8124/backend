import { MigrationInterface, QueryRunner } from 'typeorm';

export class ObservabilityTraceparent1700000000005 implements MigrationInterface {
  name = 'ObservabilityTraceparent1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE outbox_events
      ADD COLUMN IF NOT EXISTS traceparent VARCHAR(255);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_outbox_traceparent
      ON outbox_events(traceparent)
      WHERE traceparent IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_outbox_traceparent;`);
    await queryRunner.query(`ALTER TABLE outbox_events DROP COLUMN IF EXISTS traceparent;`);
  }
}
