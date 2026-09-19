import { IsOptional, IsString, IsArray, IsNumber, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateDoctorProfileDto {
  @ApiPropertyOptional({ description: 'Professional biography / summary' })
  @IsOptional()
  @IsString()
  bio?: string;

  @ApiPropertyOptional({ description: 'List of medical specializations', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  specializations?: string[];

  @ApiPropertyOptional({ description: 'Languages spoken', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  languages?: string[];

  @ApiPropertyOptional({ description: 'Consultation fee in cents' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  fee_cents?: number;

  @ApiPropertyOptional({ description: 'Years of clinical experience' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  experience_years?: number;
}
