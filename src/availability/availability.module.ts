import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AvailabilitySlot } from './entities/availability-slot.entity';
import { AvailabilityService } from './availability.service';
import { AvailabilityController } from './availability.controller';

@Module({
  imports: [TypeOrmModule.forFeature([AvailabilitySlot])],
  controllers: [AvailabilityController],
  providers: [AvailabilityService],
  exports: [TypeOrmModule, AvailabilityService],
})
export class AvailabilityModule {}
