import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Consultation } from './entities/consultation.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Consultation])],
  exports: [TypeOrmModule],
})
export class ConsultationsModule {}
