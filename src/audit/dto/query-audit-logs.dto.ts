import { IsOptional, IsString, IsNumber, Min, Max, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryAuditLogsDto {
  @ApiPropertyOptional({ description: 'Filter by actor ID (user ID who performed action)' })
  @IsOptional()
  @IsString()
  actor_id?: string;

  @ApiPropertyOptional({ description: 'Filter by action (e.g. AUTH_LOGIN, PHI_READ, PHI_WRITE)' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({
    description: 'Filter by resource type (e.g. prescription, consultation, user)',
  })
  @IsOptional()
  @IsString()
  resource_type?: string;

  @ApiPropertyOptional({ description: 'Filter by resource ID' })
  @IsOptional()
  @IsString()
  resource_id?: string;

  @ApiPropertyOptional({ description: 'Start date (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  date_from?: string;

  @ApiPropertyOptional({ description: 'End date (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  date_to?: string;

  @ApiPropertyOptional({ description: 'Number of records (1-100)', default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit: number = 50;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor (base64)' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class VerifyAuditChainDto {
  @ApiPropertyOptional({
    description: 'Partition month to verify (YYYY-MM-01). Defaults to current month.',
  })
  @IsOptional()
  @IsString()
  partition_month?: string;
}
