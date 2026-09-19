import { IsString, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CompleteConsultationDto {
  @ApiPropertyOptional({ example: 'Patient advised rest and follow-up in 1 week' })
  @IsString()
  @IsOptional()
  notes?: string;
}
