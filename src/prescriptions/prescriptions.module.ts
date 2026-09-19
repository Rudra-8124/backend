import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Prescription } from './entities/prescription.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Prescription])],
  exports: [TypeOrmModule],
})
export class PrescriptionsModule {}
