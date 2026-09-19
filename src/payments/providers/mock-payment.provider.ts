import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'crypto';
import {
  IPaymentProvider,
  CreateIntentParams,
  CreateIntentResult,
  RefundParams,
  RefundResult,
} from './payment-provider.interface';

@Injectable()
export class MockPaymentProvider implements IPaymentProvider {
  private isOutage: boolean = false;
  private readonly webhookSecret: string;

  constructor(private readonly configService: ConfigService) {
    this.webhookSecret =
      this.configService.get<string>('PAYMENT_WEBHOOK_SECRET') ||
      'mock_webhook_secret_amrutam_telemedicine_32_bytes_long';
  }

  public setOutage(outage: boolean): void {
    this.isOutage = outage;
  }

  public getOutage(): boolean {
    return this.isOutage;
  }

  public getWebhookSecret(): string {
    return this.webhookSecret;
  }

  public async createIntent(params: CreateIntentParams): Promise<CreateIntentResult> {
    if (this.isOutage) {
      throw new ServiceUnavailableException('Mock payment provider outage: network timeout (503)');
    }

    const intentId = `pi_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const clientSecret = `pi_secret_${randomUUID().replace(/-/g, '')}`;
    const paymentUrl = `https://checkout.mock-pay.local/pay/${intentId}?amount=${params.amountCents}`;

    return {
      intentId,
      clientSecret,
      paymentUrl,
    };
  }

  public async refund(_params: RefundParams): Promise<RefundResult> {
    if (this.isOutage) {
      throw new ServiceUnavailableException('Mock payment provider outage: refund failed (503)');
    }

    const refundId = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    return {
      refundId,
      status: 'SUCCESS',
    };
  }

  /**
   * Helper to generate HMAC-SHA256 signed webhook requests for testing / simulation.
   */
  public generateSignedWebhook(params: {
    eventId: string;
    eventType: 'payment.succeeded' | 'payment.failed';
    paymentIntentId: string;
    amountCents?: number;
    timestamp?: number;
    secret?: string;
  }): { payload: any; rawBody: string; signature: string; timestamp: number } {
    const timestamp = params.timestamp ?? Math.floor(Date.now() / 1000);
    const secret = params.secret ?? this.webhookSecret;

    const payload = {
      event_id: params.eventId,
      type: params.eventType,
      created_at: timestamp,
      data: {
        payment_intent_id: params.paymentIntentId,
        amount_cents: params.amountCents ?? 50000,
        currency: 'INR',
        status: params.eventType === 'payment.succeeded' ? 'SUCCESS' : 'FAILED',
      },
    };

    const rawBody = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

    return { payload, rawBody, signature, timestamp };
  }
}
