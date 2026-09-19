import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyKey } from './entities/idempotency-key.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { ProcessedWebhookEvent } from './entities/processed-webhook-event.entity';

@Module({
  imports: [TypeOrmModule.forFeature([IdempotencyKey, OutboxEvent, ProcessedWebhookEvent])],
  exports: [TypeOrmModule],
})
export class IdempotencyModule {}
