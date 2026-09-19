import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsArray,
  ValidateNested,
  IsInt,
  Min,
  Max,
  IsOptional,
  IsString,
} from 'class-validator';
import { Type } from 'class-transformer';

export class WeeklyScheduleItemDto {
  @ApiProperty({ example: 1, description: 'Day of week: 0=Sun, 1=Mon, ..., 6=Sat' })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({ example: 9, description: 'Start hour (0-23)' })
  @IsInt()
  @Min(0)
  @Max(23)
  startHour!: number;

  @ApiProperty({ example: 0, description: 'Start minute (0-59)' })
  @IsInt()
  @Min(0)
  @Max(59)
  startMinute!: number;

  @ApiProperty({ example: 17, description: 'End hour (0-23)' })
  @IsInt()
  @Min(0)
  @Max(23)
  endHour!: number;

  @ApiProperty({ example: 0, description: 'End minute (0-59)' })
  @IsInt()
  @Min(0)
  @Max(59)
  endMinute!: number;

  @ApiProperty({ example: 30, description: 'Slot duration in minutes' })
  @IsInt()
  @Min(10)
  @Max(120)
  slotDurationMinutes!: number;
}

export class BulkCreateSlotsDto {
  @ApiProperty({ example: '2026-10-01', description: 'Start date (YYYY-MM-DD)' })
  @IsDateString()
  startDate!: string;

  @ApiProperty({ example: '2026-10-07', description: 'End date (YYYY-MM-DD)' })
  @IsDateString()
  endDate!: string;

  @ApiProperty({ type: [WeeklyScheduleItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyScheduleItemDto)
  schedule!: WeeklyScheduleItemDto[];

  @ApiPropertyOptional({
    example: 'Asia/Kolkata',
    description: 'Timezone for schedule generation; defaults to doctor profile timezone',
  })
  @IsString()
  @IsOptional()
  timezone?: string;
}
