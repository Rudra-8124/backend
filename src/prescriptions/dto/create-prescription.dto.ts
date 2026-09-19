import { IsString, IsNotEmpty, IsArray, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MedicationItemDto {
  @ApiProperty({ example: 'Amoxicillin' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: '500mg' })
  @IsString()
  @IsNotEmpty()
  dosage!: string;

  @ApiPropertyOptional({ example: 'TDS' })
  @IsString()
  @IsOptional()
  frequency?: string;

  @ApiPropertyOptional({ example: '5 days' })
  @IsString()
  @IsOptional()
  duration?: string;
}

export class CreatePrescriptionDto {
  @ApiProperty({
    type: [MedicationItemDto],
    example: [{ name: 'Amoxicillin', dosage: '500mg', frequency: 'TDS', duration: '5 days' }],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MedicationItemDto)
  medications!: MedicationItemDto[];

  @ApiProperty({ example: 'Viral upper respiratory tract infection' })
  @IsString()
  @IsNotEmpty()
  diagnosis!: string;

  @ApiPropertyOptional({ example: 'Drink plenty of warm fluids, rest for 3 days.' })
  @IsString()
  @IsOptional()
  notes?: string;
}
