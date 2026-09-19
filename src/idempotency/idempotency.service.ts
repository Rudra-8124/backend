import {
  Injectable,
  UnprocessableEntityException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';

export interface ClaimResult {
  status: 'CLAIMED' | 'COMPLETED';
  keyId?: string;
  responseStatus?: number;
  responseBody?: Record<string, unknown>;
}

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly CRASH_TIMEOUT_MS = 60_000; // 60 seconds for in-progress crash recovery
  private readonly EXPIRY_HOURS = 24;

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Compute a SHA-256 hash of the request payload.
   */
  hashPayload(payload: unknown): string {
    const serialized = JSON.stringify(payload ?? {});
    return createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Atomically claim an idempotency key.
   * - If new: inserts with status IN_PROGRESS.
   * - If completed: returns stored response for replay.
   * - If same key + different body: throws 422 Unprocessable Entity.
   * - If in progress: checks crash recovery timeout; if recent, throws 409 with Retry-After.
   */
  async claimKey(params: {
    userId: string;
    endpoint: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<ClaimResult> {
    const { userId, endpoint, idempotencyKey, requestHash } = params;

    // 1. Attempt atomic INSERT ... ON CONFLICT DO NOTHING
    const insertResult = await this.dataSource.query(
      `INSERT INTO idempotency_keys
        (id, user_id, endpoint, idempotency_key, request_hash, status, response_status, response_body, expires_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'IN_PROGRESS', NULL, NULL, now() + interval '${this.EXPIRY_HOURS} hours', now(), now())
       ON CONFLICT (user_id, endpoint, idempotency_key) DO NOTHING
       RETURNING id, status`,
      [userId, endpoint, idempotencyKey, requestHash],
    );

    if (insertResult.length > 0) {
      return { status: 'CLAIMED', keyId: insertResult[0].id };
    }

    // 2. Conflict occurred — fetch the existing record
    const rows = await this.dataSource.query(
      `SELECT id, status, request_hash, response_status, response_body, expires_at, updated_at
       FROM idempotency_keys
       WHERE user_id = $1 AND endpoint = $2 AND idempotency_key = $3`,
      [userId, endpoint, idempotencyKey],
    );

    if (rows.length === 0) {
      // Very rare race condition where existing was deleted concurrently
      return this.claimKey(params);
    }

    const existing = rows[0];

    // Check if key is expired (> 24h)
    const isExpired = new Date(existing.expires_at).getTime() <= Date.now();
    if (isExpired) {
      // Recycle expired key atomically
      const updateResult = await this.dataSource.query(
        `UPDATE idempotency_keys
         SET request_hash = $4, status = 'IN_PROGRESS', response_status = NULL, response_body = NULL,
             expires_at = now() + interval '${this.EXPIRY_HOURS} hours', updated_at = now()
         WHERE id = $1 AND expires_at <= now()
         RETURNING id`,
        [existing.id, userId, endpoint, requestHash],
      );
      if (updateResult.length > 0) {
        return { status: 'CLAIMED', keyId: existing.id };
      }
    }

    // 3. Request Hash comparison: Same key + different body -> 422
    if (existing.request_hash !== requestHash) {
      throw new UnprocessableEntityException({
        type: 'https://httpstatuses.io/422',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'Idempotency key already used with a different request payload',
        message: 'Idempotency key already used with a different request payload',
      });
    }

    // 4. Stored response replay: If COMPLETED, return cached response
    if (existing.status === 'COMPLETED') {
      return {
        status: 'COMPLETED',
        keyId: existing.id,
        responseStatus: existing.response_status,
        responseBody: existing.response_body,
      };
    }

    // 5. In-flight request: check for crash recovery
    const updatedAt = new Date(existing.updated_at).getTime();
    const isCrashed = Date.now() - updatedAt > this.CRASH_TIMEOUT_MS;

    if (isCrashed) {
      this.logger.warn({
        msg: 'Recovering from crashed IN_PROGRESS idempotency key',
        keyId: existing.id,
        userId,
        endpoint,
      });

      const recoverResult = await this.dataSource.query(
        `UPDATE idempotency_keys
         SET request_hash = $2, status = 'IN_PROGRESS', response_status = NULL, response_body = NULL, updated_at = now()
         WHERE id = $1 AND status = 'IN_PROGRESS'
         RETURNING id`,
        [existing.id, requestHash],
      );

      if (recoverResult.length > 0) {
        return { status: 'CLAIMED', keyId: existing.id };
      }
    }

    // 6. Active concurrent duplicate -> 409 Conflict with Retry-After
    throw new HttpException(
      {
        type: 'https://httpstatuses.io/409',
        title: 'Conflict',
        status: 409,
        detail:
          'A request with this idempotency key is currently in progress. Please retry shortly.',
        retryAfter: 2,
      },
      HttpStatus.CONFLICT,
    );
  }

  /**
   * Mark an idempotency key as COMPLETED with the stored response status and body.
   */
  async completeKey(
    keyId: string,
    responseStatus: number,
    responseBody: Record<string, unknown>,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE idempotency_keys
       SET status = 'COMPLETED', response_status = $2, response_body = $3, updated_at = now()
       WHERE id = $1`,
      [keyId, responseStatus, JSON.stringify(responseBody ?? {})],
    );
  }

  /**
   * Delete or release key in case of unhandled error where client should be able to retry immediately.
   */
  async releaseKey(keyId: string): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM idempotency_keys WHERE id = $1 AND status = 'IN_PROGRESS'`,
      [keyId],
    );
  }
}
