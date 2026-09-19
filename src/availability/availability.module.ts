import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AvailabilitySlot } from './entities/availability-slot.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AvailabilitySlot])],
  exports: [TypeOrmModule],
})
export class AvailabilityModule {}
