import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Prescription } from './entities/prescription.entity';
import { PrescriptionsService } from './prescriptions.service';
import { PrescriptionsController } from './prescriptions.controller';
import { CryptoModule } from '../common/crypto/crypto.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TypeOrmModule.forFeature([Prescription]), CryptoModule, AuditModule],
  controllers: [PrescriptionsController],
  providers: [PrescriptionsService],
  exports: [TypeOrmModule, PrescriptionsService],
})
export class PrescriptionsModule {}
