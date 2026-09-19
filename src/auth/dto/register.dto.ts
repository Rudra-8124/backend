import { IsEmail, IsString, MinLength, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'patient@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'SecureP@ss123!', minLength: 8 })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({ example: 'Jane' })
  @IsString()
  @MinLength(1)
  firstName!: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @MinLength(1)
  lastName!: string;

  @ApiPropertyOptional({ enum: ['patient', 'doctor'], default: 'patient' })
  @IsOptional()
  @IsEnum(['patient', 'doctor'])
  role?: 'patient' | 'doctor';

  // Doctor-specific fields (required when role=doctor)
  @ApiPropertyOptional({ example: 'MED-12345' })
  @IsOptional()
  @IsString()
  licenseNumber?: string;

  @ApiPropertyOptional({ example: ['Ayurveda', 'General Medicine'] })
  @IsOptional()
  @IsString({ each: true })
  specializations?: string[];

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  experienceYears?: number;

  @ApiPropertyOptional({ example: 50000, description: 'Fee in paise (INR cents)' })
  @IsOptional()
  feeCents?: number;
}
