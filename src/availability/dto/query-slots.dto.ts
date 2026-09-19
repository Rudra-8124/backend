import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsISO8601, IsEnum } from 'class-validator';
import { SlotStatus } from '../entities/availability-slot.entity';

export class QuerySlotsDto {
  @ApiPropertyOptional({ description: 'Filter slots starting at or after this time' })
  @IsISO8601()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Filter slots starting before or at this time' })
  @IsISO8601()
  @IsOptional()
  endDate?: string;

  @ApiPropertyOptional({ enum: SlotStatus, description: 'Filter by slot status' })
  @IsEnum(SlotStatus)
  @IsOptional()
  status?: SlotStatus;
}
