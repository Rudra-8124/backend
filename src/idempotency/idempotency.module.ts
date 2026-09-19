import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyKey } from './entities/idempotency-key.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { ProcessedWebhookEvent } from './entities/processed-webhook-event.entity';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';

@Module({
  imports: [TypeOrmModule.forFeature([IdempotencyKey, OutboxEvent, ProcessedWebhookEvent])],
  providers: [IdempotencyService, IdempotencyInterceptor],
  exports: [TypeOrmModule, IdempotencyService, IdempotencyInterceptor],
})
export class IdempotencyModule {}
