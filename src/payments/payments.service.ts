import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { IPaymentProvider, PAYMENT_PROVIDER } from './providers/payment-provider.interface';
import { CircuitBreaker } from './circuit-breaker';
import { ConsultationStateMachine } from '../consultations/consultation-state-machine';
import { ConsultationStatus } from '../consultations/entities/consultation.entity';
import { PaymentStatus } from './entities/payment.entity';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  public readonly circuitBreaker: CircuitBreaker;
  private readonly webhookSecret: string;

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    @Inject(PAYMENT_PROVIDER)
    public readonly paymentProvider: IPaymentProvider,
  ) {
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 5000,
      baseBackoffMs: 20,
      maxBackoffMs: 500,
      maxRetries: 2,
    });

    this.webhookSecret =
      this.configService.get<string>('PAYMENT_WEBHOOK_SECRET') ||
      'mock_webhook_secret_amrutam_telemedicine_32_bytes_long';
  }

  /**
   * Create payment intent via provider through Circuit Breaker and save payment record.
   */
  async createPaymentIntent(
    consultationId: string,
    amountCents: number,
    currency: string = 'INR',
    customerEmail?: string,
  ): Promise<{ intentId: string; paymentUrl: string; clientSecret: string }> {
    // 1. Fetch consultation
    const consultRows = await this.dataSource.query(
      'SELECT id, partition_month, patient_id, status FROM consultations WHERE id = $1',
      [consultationId],
    );

    if (consultRows.length === 0) {
      throw new NotFoundException(`Consultation ${consultationId} not found`);
    }

    const consult = consultRows[0];

    // 2. Call provider through Circuit Breaker
    const intentResult = await this.circuitBreaker.execute(() =>
      this.paymentProvider.createIntent({
        consultationId,
        amountCents,
        currency,
        customerEmail,
      }),
    );

    // 3. Save payment record and update consultation
    await this.dataSource.transaction(async (manager) => {
      const paymentId = randomUUID();
      await manager.query(
        `INSERT INTO payments
         (id, consultation_id, consultation_partition_month, payment_intent_id,
          amount_cents, currency, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
        [
          paymentId,
          consult.id,
          consult.partition_month,
          intentResult.intentId,
          amountCents,
          currency,
          PaymentStatus.PENDING,
        ],
      );

      await manager.query(
        `UPDATE consultations
         SET payment_intent_id = $1, updated_at = now()
         WHERE id = $2`,
        [intentResult.intentId, consult.id],
      );
    });

    return intentResult;
  }

  /**
   * Refund a paid consultation (e.g. after cancellation).
   */
  async refundConsultation(
    consultationId: string,
    reason: string = 'Consultation cancelled',
  ): Promise<{ refundId: string; status: string } | null> {
    const payRows = await this.dataSource.query(
      `SELECT id, payment_intent_id, amount_cents, status
       FROM payments
       WHERE consultation_id = $1 AND status = 'SUCCESS'
       LIMIT 1`,
      [consultationId],
    );

    if (payRows.length === 0) {
      this.logger.log(`No successful payment found for consultation ${consultationId} to refund`);
      return null;
    }

    const payment = payRows[0];

    const refundResult = await this.circuitBreaker.execute(() =>
      this.paymentProvider.refund({
        paymentIntentId: payment.payment_intent_id,
        amountCents: payment.amount_cents,
        reason,
      }),
    );

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE payments
         SET status = 'REFUNDED', updated_at = now(),
             metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{refund}', $1::jsonb)
         WHERE id = $2`,
        [JSON.stringify(refundResult), payment.id],
      );

      await manager.query(
        `INSERT INTO outbox_events
         (event_type, aggregate_id, aggregate_type, payload, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'PENDING', now(), now())`,
        [
          'payment.refunded',
          payment.id,
          'payment',
          JSON.stringify({
            paymentId: payment.id,
            consultationId,
            refundId: refundResult.refundId,
            reason,
          }),
        ],
      );
    });

    return refundResult;
  }

  /**
   * Process webhook from payment gateway:
   * - Timing-safe HMAC verification
   * - Timestamp tolerance (anti-replay)
   * - Deduplication via processed_webhook_events
   * - Durable state updates within transaction
   */
  async processWebhook(
    rawBody: string,
    body: any,
    signatureHeader?: string,
    timestampHeader?: string,
  ): Promise<{ status: string; event_id: string }> {
    // 1. Validate signature header presence
    const signature = signatureHeader || (body && body.signature);
    if (!signature) {
      throw new UnauthorizedException('Missing webhook signature');
    }

    // 2. Validate timestamp tolerance
    const tsRaw = timestampHeader || (body && body.created_at);
    if (!tsRaw) {
      throw new BadRequestException('Missing webhook timestamp');
    }

    const timestamp = typeof tsRaw === 'string' ? parseInt(tsRaw, 10) : Number(tsRaw);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const TOLERANCE_SECONDS = 300; // 5 minutes tolerance

    if (Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) {
      throw new BadRequestException('Webhook timestamp outside acceptable tolerance window');
    }

    // 3. Timing-safe HMAC comparison
    const expectedSignature = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

    const sigBuf = Buffer.from(signature, 'utf-8');
    const expBuf = Buffer.from(expectedSignature, 'utf-8');

    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // 4. Extract event details
    const eventId = body.event_id || body.id;
    const eventType = body.type;
    const paymentIntentId = body.data?.payment_intent_id || body.payment_intent_id || body.data?.id;

    if (!eventId || !eventType) {
      throw new BadRequestException('Webhook payload missing required event_id or type');
    }

    // 5. Deduplication using processed_webhook_events
    const eventRecordId = randomUUID();
    const insertResult = await this.dataSource.query(
      `INSERT INTO processed_webhook_events (id, provider, event_id, response_body, created_at)
       VALUES ($1, 'mock_provider', $2, $3, now())
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id;`,
      [eventRecordId, eventId, JSON.stringify({ status: 'received', eventId, eventType })],
    );

    const insertedRows = Array.isArray(insertResult[0]) ? insertResult[0] : insertResult;
    if (!insertedRows || insertedRows.length === 0) {
      this.logger.warn(
        `Duplicate webhook received: event_id=${eventId}. Returning idempotent 200.`,
      );
      return { status: 'already_processed', event_id: eventId };
    }

    // 6. Durable state transition within transaction
    await this.dataSource.transaction(async (manager) => {
      if (eventType === 'payment.succeeded') {
        const payRows = await manager.query(
          `SELECT id, consultation_id, status FROM payments WHERE payment_intent_id = $1`,
          [paymentIntentId],
        );

        if (payRows.length > 0) {
          const payment = payRows[0];
          await manager.query(
            `UPDATE payments
             SET status = 'SUCCESS', provider_reference = $1, updated_at = now()
             WHERE id = $2`,
            [eventId, payment.id],
          );

          // Fetch consultation status to detect out-of-order execution
          const consultRows = await manager.query(
            `SELECT id, status FROM consultations WHERE id = $1`,
            [payment.consultation_id],
          );

          if (consultRows.length > 0) {
            const currentStatus = consultRows[0].status;
            if (currentStatus === ConsultationStatus.CANCELLED) {
              // Out of order: webhook succeeded after consultation was already cancelled/timed out
              this.logger.warn(
                `Payment succeeded for already cancelled consultation ${payment.consultation_id}. Auto-refunding.`,
              );
              // Trigger automatic refund
              await this.paymentProvider.refund({
                paymentIntentId,
                amountCents: body.data?.amount_cents || 50000,
                reason: 'Payment arrived after cancellation',
              });
              await manager.query(
                `UPDATE payments SET status = 'REFUNDED', updated_at = now() WHERE id = $1`,
                [payment.id],
              );
            } else if (currentStatus === ConsultationStatus.PENDING_PAYMENT) {
              await ConsultationStateMachine.transition(manager, payment.consultation_id, {
                targetStatus: ConsultationStatus.CONFIRMED,
                paymentIntentId,
              });
            }
          }
        }
      } else if (eventType === 'payment.failed') {
        const payRows = await manager.query(
          `SELECT id, consultation_id, status FROM payments WHERE payment_intent_id = $1`,
          [paymentIntentId],
        );

        if (payRows.length > 0) {
          const payment = payRows[0];
          await manager.query(
            `UPDATE payments
             SET status = 'FAILED', provider_reference = $1, updated_at = now()
             WHERE id = $2`,
            [eventId, payment.id],
          );

          // If consultation is still pending, cancel it and release slot
          const consultRows = await manager.query(
            `SELECT id, status FROM consultations WHERE id = $1`,
            [payment.consultation_id],
          );

          if (
            consultRows.length > 0 &&
            consultRows[0].status === ConsultationStatus.PENDING_PAYMENT
          ) {
            await ConsultationStateMachine.transition(manager, payment.consultation_id, {
              targetStatus: ConsultationStatus.CANCELLED,
              cancellationReason: 'PAYMENT_FAILED',
            });
          }
        }
      }

      // Update response stored in processed_webhook_events
      await manager.query(
        `UPDATE processed_webhook_events
         SET response_body = $1
         WHERE id = $2`,
        [JSON.stringify({ status: 'completed', event_id: eventId, eventType }), eventRecordId],
      );
    });

    return { status: 'processed', event_id: eventId };
  }
}
