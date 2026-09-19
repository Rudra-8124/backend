import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Doctor } from './entities/doctor.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Doctor])],
  exports: [TypeOrmModule],
})
export class DoctorsModule {}
