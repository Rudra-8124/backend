import {
  Controller,
  Post,
  Get,
  Req,
  Body,
  Headers,
  Param,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import { DataSource } from 'typeorm';
import { PaymentsService } from './payments.service';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, RequestUser } from '../common/decorators/current-user.decorator';

@ApiTags('Payments')
@Controller()
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly dataSource: DataSource,
  ) {}

  @Post('webhooks/payments')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Process payment provider webhook with HMAC signature verification' })
  async handlePaymentWebhook(
    @Req() req: FastifyRequest & { rawBody?: Buffer },
    @Body() body: any,
    @Headers('x-webhook-signature') sigHeader?: string,
    @Headers('x-signature') altSigHeader?: string,
    @Headers('x-timestamp') tsHeader?: string,
  ) {
    const rawBody = req.rawBody ? req.rawBody.toString('utf-8') : JSON.stringify(body);
    const signature = sigHeader || altSigHeader || (body && body.signature);
    const timestamp = tsHeader || (body && body.created_at);

    return this.paymentsService.processWebhook(rawBody, body, signature, timestamp);
  }

  @Post('webhooks/payment')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Alias for webhooks/payments' })
  async handlePaymentWebhookAlias(
    @Req() req: FastifyRequest & { rawBody?: Buffer },
    @Body() body: any,
    @Headers('x-webhook-signature') sigHeader?: string,
    @Headers('x-signature') altSigHeader?: string,
    @Headers('x-timestamp') tsHeader?: string,
  ) {
    return this.handlePaymentWebhook(req, body, sigHeader, altSigHeader, tsHeader);
  }

  @Get('payments/:id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get payment details by ID (Patient owner, Doctor assigned, or Admin)' })
  async getPaymentById(@CurrentUser() user: RequestUser, @Param('id') paymentId: string) {
    const payRows = await this.dataSource.query(
      `SELECT p.id, p.consultation_id, p.consultation_partition_month, p.payment_intent_id,
              p.amount_cents, p.currency, p.status, p.provider_reference, p.created_at, p.updated_at,
              c.patient_id, c.doctor_id
       FROM payments p
       LEFT JOIN consultations c ON c.id = p.consultation_id
       WHERE p.id = $1`,
      [paymentId],
    );

    if (payRows.length === 0) {
      throw new NotFoundException(`Payment ${paymentId} not found`);
    }

    const pay = payRows[0];
    if (user.role !== 'admin' && pay.patient_id !== user.userId) {
      // Check if user is the assigned doctor
      const docRows = await this.dataSource.query('SELECT id FROM doctors WHERE user_id = $1', [
        user.userId,
      ]);
      const doctorId = docRows.length > 0 ? docRows[0].id : null;
      if (pay.doctor_id !== doctorId) {
        throw new ForbiddenException('You do not have permission to view this payment');
      }
    }

    return {
      id: pay.id,
      consultationId: pay.consultation_id,
      paymentIntentId: pay.payment_intent_id,
      amountCents: pay.amount_cents,
      currency: pay.currency,
      status: pay.status,
      providerReference: pay.provider_reference,
      createdAt: pay.created_at,
      updatedAt: pay.updated_at,
    };
  }
}
