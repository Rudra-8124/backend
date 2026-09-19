import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  const partitionMonthArg = process.argv[2];
  const now = new Date();
  const defaultPartition = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const partitionMonth = partitionMonthArg || defaultPartition;

  console.log(`[AuditVerifier] Initializing verification for partition: ${partitionMonth}`);

  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USER || 'amrutam',
    password: process.env.DB_PASSWORD || 'amrutam_dev_password',
    database: process.env.DB_NAME || 'amrutam',
  });

  await dataSource.initialize();
  console.log('[AuditVerifier] Connected to database.');

  try {
    const rows = await dataSource.query(
      `
      SELECT
        id,
        actor_id,
        action,
        resource_type,
        resource_id,
        request_id,
        previous_hash,
        hash,
        created_at
      FROM audit_logs
      WHERE partition_month = $1
      ORDER BY created_at ASC, id ASC;
      `,
      [partitionMonth],
    );

    console.log(`[AuditVerifier] Found ${rows.length} rows in partition ${partitionMonth}.`);

    if (rows.length === 0) {
      console.log('[AuditVerifier] Partition is empty. Chain is trivially valid.');
      process.exit(0);
    }

    let valid = true;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const createdAtIso =
        row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString();

      // Check previous hash link
      if (i === 0) {
        if (row.previous_hash !== '') {
          console.error(`[AuditVerifier] ERROR: Genesis row previous_hash is not empty! id=${row.id}, previous_hash=${row.previous_hash}`);
          valid = false;
          break;
        }
      } else {
        const prevRow = rows[i - 1];
        if (row.previous_hash !== prevRow.hash) {
          console.error(
            `[AuditVerifier] TAMPERING DETECTED: Chain broken at row ${row.id}! Row previous_hash (${row.previous_hash}) does not match prior row hash (${prevRow.hash})`,
          );
          valid = false;
          break;
        }
      }

      // Recompute hash
      const hashInput = [
        row.previous_hash,
        row.actor_id || '',
        row.action,
        row.resource_type,
        row.resource_id || '',
        createdAtIso,
        row.request_id || '',
      ].join('|');

      const expectedHash = createHash('sha256').update(hashInput).digest('hex');
      if (row.hash !== expectedHash) {
        console.error(
          `[AuditVerifier] TAMPERING DETECTED: Hash mismatch at row ${row.id}! Expected ${expectedHash}, found ${row.hash}. Row contents have been altered!`,
        );
        valid = false;
        break;
      }
    }

    if (valid) {
      console.log(`[AuditVerifier] SUCCESS: All ${rows.length} rows in partition ${partitionMonth} verified cryptographically. Chain is INTACT.`);
      process.exit(0);
    } else {
      console.error(`[AuditVerifier] FAILED: Partition ${partitionMonth} audit log integrity check FAILED.`);
      process.exit(1);
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err) => {
  console.error('[AuditVerifier] Fatal error:', err);
  process.exit(1);
});
