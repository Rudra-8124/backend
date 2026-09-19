export interface CreateIntentParams {
  consultationId: string;
  amountCents: number;
  currency: string;
  customerEmail?: string;
}

export interface CreateIntentResult {
  intentId: string;
  clientSecret: string;
  paymentUrl: string;
}

export interface RefundParams {
  paymentIntentId: string;
  amountCents: number;
  reason?: string;
}

export interface RefundResult {
  refundId: string;
  status: 'SUCCESS' | 'FAILED';
}

export interface IPaymentProvider {
  createIntent(params: CreateIntentParams): Promise<CreateIntentResult>;
  refund(params: RefundParams): Promise<RefundResult>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
