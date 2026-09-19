import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsString, IsOptional, MaxLength } from 'class-validator';

export class BookConsultationDto {
  @ApiProperty({
    example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    description: 'The UUID of the availability slot to book',
  })
  @IsUUID()
  slotId!: string;

  @ApiPropertyOptional({
    example: 'Persistent headache and fatigue for 3 days',
    description: 'Reason for consultation or chief symptoms',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  reason?: string;
}
