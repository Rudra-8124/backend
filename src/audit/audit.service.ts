import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createHash, randomUUID } from 'crypto';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto';

export interface AuditVerificationResult {
  valid: boolean;
  totalRows: number;
  partitionMonth: string;
  brokenRowId?: string;
  error?: string;
}

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
    const partitionMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    const createdAtIso = now.toISOString();

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
        createdAtIso,
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
          createdAtIso,
        ],
      );
    });
  }

  /**
   * Verify the integrity of the hash chain within a specific monthly partition.
   * Traverses all rows in sequential order to ensure:
   * 1. Genesis row has previous_hash = ''
   * 2. Row N.previous_hash == Row N-1.hash
   * 3. Row N.hash == SHA256(previous_hash | actor_id | action | resource_type | resource_id | created_at | request_id)
   */
  async verifyPartitionChain(partitionMonth: string): Promise<AuditVerificationResult> {
    const rows = await this.dataSource.query(
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

    if (rows.length === 0) {
      return { valid: true, totalRows: 0, partitionMonth };
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const createdAtIso =
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString();

      // Check link to previous hash
      if (i === 0) {
        if (row.previous_hash !== '') {
          return {
            valid: false,
            totalRows: rows.length,
            partitionMonth,
            brokenRowId: row.id,
            error: `Genesis row previous_hash is not empty: "${row.previous_hash}"`,
          };
        }
      } else {
        const prevRow = rows[i - 1];
        if (row.previous_hash !== prevRow.hash) {
          return {
            valid: false,
            totalRows: rows.length,
            partitionMonth,
            brokenRowId: row.id,
            error: `Chain broken at row ${row.id}: previous_hash "${row.previous_hash}" does not match prior row hash "${prevRow.hash}"`,
          };
        }
      }

      // Recompute and verify current hash
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
        return {
          valid: false,
          totalRows: rows.length,
          partitionMonth,
          brokenRowId: row.id,
          error: `Hash mismatch at row ${row.id}: expected "${expectedHash}", found "${row.hash}" (row content tampered)`,
        };
      }
    }

    return {
      valid: true,
      totalRows: rows.length,
      partitionMonth,
    };
  }

  /**
   * Query audit logs with filtering and keyset pagination (Admin only).
   */
  async getLogs(filter: QueryAuditLogsDto): Promise<{ logs: any[]; next_cursor: string | null }> {
    const limit = Math.min(Math.max(filter.limit || 50, 1), 100);
    const params: any[] = [];
    const whereClauses: string[] = ['1=1'];

    if (filter.actor_id) {
      params.push(filter.actor_id);
      whereClauses.push(`actor_id = $${params.length}`);
    }

    if (filter.action) {
      params.push(filter.action);
      whereClauses.push(`action = $${params.length}`);
    }

    if (filter.resource_type) {
      params.push(filter.resource_type);
      whereClauses.push(`resource_type = $${params.length}`);
    }

    if (filter.resource_id) {
      params.push(filter.resource_id);
      whereClauses.push(`resource_id = $${params.length}`);
    }

    if (filter.date_from) {
      params.push(new Date(filter.date_from));
      whereClauses.push(`created_at >= $${params.length}`);
    }

    if (filter.date_to) {
      params.push(new Date(filter.date_to));
      whereClauses.push(`created_at <= $${params.length}`);
    }

    if (filter.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(filter.cursor, 'base64').toString('utf-8'));
        if (decoded.createdAt && decoded.id) {
          params.push(new Date(decoded.createdAt), decoded.id);
          whereClauses.push(
            `(created_at < $${params.length - 1} OR (created_at = $${params.length - 1} AND id < $${params.length}))`,
          );
        }
      } catch {
        // Ignore invalid cursor
      }
    }

    params.push(limit + 1);
    const limitIdx = params.length;

    const sql = `
      SELECT
        id,
        partition_month AS "partitionMonth",
        actor_id AS "actorId",
        action,
        resource_type AS "resourceType",
        resource_id AS "resourceId",
        ip_address AS "ipAddress",
        request_id AS "requestId",
        metadata,
        previous_hash AS "previousHash",
        hash,
        created_at AS "createdAt"
      FROM audit_logs
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT $${limitIdx};
    `;

    const rows = await this.dataSource.query(sql, params);
    const hasNext = rows.length > limit;
    const logs = hasNext ? rows.slice(0, limit) : rows;

    let next_cursor: string | null = null;
    if (hasNext) {
      const last = logs[logs.length - 1];
      const payload = { id: last.id, createdAt: last.createdAt };
      next_cursor = Buffer.from(JSON.stringify(payload)).toString('base64');
    }

    return { logs, next_cursor };
  }

  private hashToInt(str: string): number {
    const h = createHash('md5').update(str).digest();
    return h.readInt32BE(0);
  }
}
