import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsInt, Min, Max, IsOptional } from 'class-validator';

export class CreateSlotDto {
  @ApiProperty({
    example: '2026-10-01T09:00:00.000Z',
    description: 'Slot start time in UTC ISO 8601 format',
  })
  @IsISO8601()
  startTime!: string;

  @ApiProperty({
    example: 30,
    description: 'Slot duration in minutes (between 10 and 120)',
    default: 30,
  })
  @IsInt()
  @Min(10)
  @Max(120)
  @IsOptional()
  durationMinutes: number = 30;
}
