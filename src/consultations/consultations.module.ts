import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Consultation } from './entities/consultation.entity';
import { ConsultationsService } from './consultations.service';
import { ConsultationsController } from './consultations.controller';
import { AvailabilityModule } from '../availability/availability.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';

@Module({
  imports: [TypeOrmModule.forFeature([Consultation]), AvailabilityModule, IdempotencyModule],
  controllers: [ConsultationsController],
  providers: [ConsultationsService],
  exports: [TypeOrmModule, ConsultationsService],
})
export class ConsultationsModule {}
