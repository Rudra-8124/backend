import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createHash, randomUUID } from 'crypto';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Append an audit log entry with per-partition hash chain.
   * Uses an advisory lock to serialize writes within the same partition.
   */
  async log(params: {
    actorId?: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    ipAddress?: string | null;
    requestId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    const now = new Date();
    const partitionMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString()
      .slice(0, 10);

    await this.dataSource.transaction(async (manager) => {
      // Advisory lock scoped to partition month
      const lockKey = this.hashToInt(partitionMonth);
      await manager.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

      // Get previous hash in this partition
      const prevRows = await manager.query(
        `SELECT hash FROM audit_logs
         WHERE partition_month = $1
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [partitionMonth],
      );
      const previousHash: string = prevRows.length > 0 ? prevRows[0].hash : '';

      // Compute new hash
      const id = randomUUID();
      const hashInput = [
        previousHash,
        params.actorId || '',
        params.action,
        params.resourceType,
        params.resourceId || '',
        now.toISOString(),
        params.requestId || '',
      ].join('|');
      const hash = createHash('sha256').update(hashInput).digest('hex');

      await manager.query(
        `INSERT INTO audit_logs
         (id, partition_month, actor_id, action, resource_type, resource_id,
          ip_address, request_id, metadata, previous_hash, hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          partitionMonth,
          params.actorId || null,
          params.action,
          params.resourceType,
          params.resourceId || null,
          params.ipAddress || null,
          params.requestId || null,
          params.metadata ? JSON.stringify(params.metadata) : null,
          previousHash,
          hash,
          now,
        ],
      );
    });
  }

  private hashToInt(str: string): number {
    const h = createHash('md5').update(str).digest();
    return h.readInt32BE(0);
  }
}
