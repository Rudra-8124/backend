import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Consultation } from './entities/consultation.entity';
import { ConsultationsService } from './consultations.service';
import { ConsultationsController } from './consultations.controller';
import { SagaOutboxService } from './saga-outbox.service';
import { AvailabilityModule } from '../availability/availability.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { CryptoModule } from '../common/crypto/crypto.module';
import { PaymentsModule } from '../payments/payments.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Consultation]),
    AvailabilityModule,
    IdempotencyModule,
    CryptoModule,
    forwardRef(() => PaymentsModule),
    AuditModule,
  ],
  controllers: [ConsultationsController],
  providers: [ConsultationsService, SagaOutboxService],
  exports: [TypeOrmModule, ConsultationsService, SagaOutboxService],
})
export class ConsultationsModule {}
