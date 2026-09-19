import { IsOptional, IsDateString, IsNumber, Min, Max, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ConsultationsAnalyticsDto {
  @ApiProperty({
    description: 'Start date for analytics window (YYYY-MM-DD)',
    example: '2026-08-01',
  })
  @IsDateString()
  date_from!: string;

  @ApiProperty({ description: 'End date for analytics window (YYYY-MM-DD)', example: '2026-09-19' })
  @IsDateString()
  date_to!: string;
}

export class DoctorsAnalyticsDto {
  @ApiProperty({
    description: 'Start date for analytics window (YYYY-MM-DD)',
    example: '2026-08-01',
  })
  @IsDateString()
  date_from!: string;

  @ApiProperty({ description: 'End date for analytics window (YYYY-MM-DD)', example: '2026-09-19' })
  @IsDateString()
  date_to!: string;

  @ApiPropertyOptional({ description: 'Number of doctors to return (1-100)', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor (base64)' })
  @IsOptional()
  @IsString()
  cursor?: string;
}
