import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PaymentsService } from '../payments/payments.service';
import { ConsultationsService } from './consultations.service';

export interface ProcessOutboxResult {
  processed: number;
  failed: number;
  dlq: number;
}

@Injectable()
export class SagaOutboxService {
  private readonly logger = new Logger(SagaOutboxService.name);
  private readonly MAX_ATTEMPTS = 3;
  private readonly BASE_BACKOFF_MS = 200;
  private readonly MAX_BACKOFF_MS = 10000;

  constructor(
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => PaymentsService))
    private readonly paymentsService: PaymentsService,
    @Inject(forwardRef(() => ConsultationsService))
    private readonly consultationsService: ConsultationsService,
  ) {}

  /**
   * Process a batch of pending outbox events using SELECT ... FOR UPDATE SKIP LOCKED.
   * Guarantees at-least-once delivery with idempotent handling.
   */
  async processOutboxBatch(limit: number = 10): Promise<ProcessOutboxResult> {
    let processed = 0;
    let failed = 0;
    let dlq = 0;

    // 1. Claim batch of events atomically with SELECT FOR UPDATE SKIP LOCKED
    const eventsToProcess = await this.dataSource.transaction(async (manager) => {
      const rows = await manager.query(
        `SELECT id, event_type, aggregate_id, aggregate_type, payload, status, attempts, retry_count
         FROM outbox_events
         WHERE status IN ('PENDING', 'FAILED')
           AND (next_retry_at IS NULL OR next_retry_at <= now())
         ORDER BY id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit],
      );

      if (rows.length === 0) {
        return [];
      }

      const ids = rows.map((r: any) => r.id);
      await manager.query(
        `UPDATE outbox_events
         SET status = 'PROCESSING', updated_at = now()
         WHERE id = ANY($1::bigint[])`,
        [ids],
      );

      return rows;
    });

    // 2. Process each claimed event
    for (const event of eventsToProcess) {
      try {
        await this.handleEvent(event);

        // Mark as PROCESSED
        await this.dataSource.query(
          `UPDATE outbox_events
           SET status = 'PROCESSED', processed_at = now(), updated_at = now()
           WHERE id = $1`,
          [event.id],
        );
        processed++;
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const nextAttempts = (event.attempts || 0) + 1;

        if (nextAttempts >= this.MAX_ATTEMPTS) {
          // Route to Dead Letter Queue (DLQ)
          await this.dataSource.query(
            `UPDATE outbox_events
             SET status = 'DLQ', error = $1, attempts = $2, updated_at = now()
             WHERE id = $3`,
            [errorMsg, nextAttempts, event.id],
          );
          this.logger.error(
            `Outbox event ${event.id} routed to DLQ after ${nextAttempts} attempts: ${errorMsg}`,
          );
          dlq++;
        } else {
          // Retry with exponential backoff + full jitter
          const maxWait = Math.min(
            this.MAX_BACKOFF_MS,
            this.BASE_BACKOFF_MS * Math.pow(2, nextAttempts),
          );
          const jitter = Math.floor(Math.random() * maxWait);
          const nextRetryAt = new Date(Date.now() + jitter);

          await this.dataSource.query(
            `UPDATE outbox_events
             SET status = 'FAILED', error = $1, attempts = $2, next_retry_at = $3, updated_at = now()
             WHERE id = $4`,
            [errorMsg, nextAttempts, nextRetryAt, event.id],
          );
          failed++;
        }
      }
    }

    return { processed, failed, dlq };
  }

  /**
   * Stale event crash recovery:
   * Resets any outbox event stuck in PROCESSING for > 30 seconds back to PENDING.
   */
  async recoverStuckEvents(timeoutSeconds: number = 30): Promise<number> {
    const result = await this.dataSource.query(
      `UPDATE outbox_events
       SET status = 'PENDING', updated_at = now()
       WHERE status = 'PROCESSING'
         AND updated_at < now() - interval '${timeoutSeconds} seconds'
       RETURNING id`,
    );

    const recoveredRows = Array.isArray(result[0]) ? result[0] : result;
    const count = recoveredRows ? recoveredRows.length : 0;
    if (count > 0) {
      this.logger.warn(`Recovered ${count} abandoned outbox events stuck in PROCESSING`);
    }
    return count;
  }

  /**
   * Process 10-minute payment timeouts for pending consultations.
   */
  async processPaymentTimeouts(timeoutMinutes: number = 10): Promise<number> {
    const rows = await this.dataSource.query(
      `SELECT id FROM consultations
       WHERE status = 'PENDING_PAYMENT'
         AND created_at < now() - interval '${timeoutMinutes} minutes'`,
    );

    let cancelledCount = 0;
    for (const row of rows) {
      try {
        await this.consultationsService.handlePaymentTimeout(row.id);
        cancelledCount++;
      } catch (err) {
        this.logger.error(`Failed to cancel timed-out consultation ${row.id}: ${err}`);
      }
    }

    return cancelledCount;
  }

  /**
   * Ensure future table partitions exist for the next N months.
   */
  async ensureFuturePartitions(monthsAhead: number = 3): Promise<void> {
    try {
      await this.dataSource.query(`SELECT ensure_partitions($1);`, [monthsAhead]);
      this.logger.log(`Ensured partitions for the next ${monthsAhead} months`);
    } catch (err) {
      this.logger.error(`Failed to ensure partitions: ${err}`);
    }
  }

  /**
   * Event dispatcher for idempotent saga execution.
   */
  private async handleEvent(event: any): Promise<void> {
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;

    switch (event.event_type) {
      case 'consultation.created': {
        const consultationId = payload.consultationId;

        // Idempotency check: check if payment intent is already created
        const existingPayments = await this.dataSource.query(
          `SELECT id, payment_intent_id FROM payments WHERE consultation_id = $1`,
          [consultationId],
        );

        if (existingPayments.length > 0 && existingPayments[0].payment_intent_id) {
          this.logger.log(
            `Payment intent already exists for consultation ${consultationId} — skipping`,
          );
          return;
        }

        // Consult fee or standard default amount
        const amountCents = payload.amountCents || 50000;
        await this.paymentsService.createPaymentIntent(consultationId, amountCents, 'INR');
        break;
      }

      case 'consultation.cancelled': {
        const consultationId = payload.consultationId;
        // Check if refund is needed
        const paidRows = await this.dataSource.query(
          `SELECT id, status FROM payments WHERE consultation_id = $1 AND status = 'SUCCESS'`,
          [consultationId],
        );
        if (paidRows.length > 0) {
          await this.paymentsService.refundConsultation(consultationId, payload.cancellationReason);
        }
        break;
      }

      default:
        // Other events (consultation.confirmed, etc.) require no async saga action
        break;
    }
  }
}
