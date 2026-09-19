import { IsOptional, IsString, IsNumber, Min, Max, IsEnum, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum DoctorSortOption {
  RELEVANCE = 'relevance',
  RATING_DESC = 'rating_desc',
  PRICE_ASC = 'price_asc',
  PRICE_DESC = 'price_desc',
  EXPERIENCE_DESC = 'experience_desc',
}

export class SearchDoctorsDto {
  @ApiPropertyOptional({
    description: 'Full-text & typo-tolerant search query (name, specialty, bio)',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    description: 'Filter by specialty (e.g. Cardiology, Ayurveda, Dermatology)',
  })
  @IsOptional()
  @IsString()
  specialty?: string;

  @ApiPropertyOptional({ description: 'Filter by doctor city (e.g. Pune, Mumbai)' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ description: 'Filter by spoken language (e.g. English, Hindi)' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ description: 'Minimum consultation fee in cents' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  min_price?: number;

  @ApiPropertyOptional({ description: 'Maximum consultation fee in cents' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  max_price?: number;

  @ApiPropertyOptional({ description: 'Minimum rating (0.00 to 5.00)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  min_rating?: number;

  @ApiPropertyOptional({ description: 'Filter by availability window start (ISO date-time)' })
  @IsOptional()
  @IsDateString()
  available_from?: string;

  @ApiPropertyOptional({ description: 'Filter by availability window end (ISO date-time)' })
  @IsOptional()
  @IsDateString()
  available_to?: string;

  @ApiPropertyOptional({
    description: 'Sort criteria',
    enum: DoctorSortOption,
    default: DoctorSortOption.RELEVANCE,
  })
  @IsOptional()
  @IsEnum(DoctorSortOption)
  sort_by?: DoctorSortOption;

  @ApiPropertyOptional({ description: 'Results limit per page (1-100)', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ description: 'Opaque keyset cursor for pagination (base64)' })
  @IsOptional()
  @IsString()
  cursor?: string;
}
