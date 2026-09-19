import { IsString, Length, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MfaVerifyDto {
  @ApiProperty({ description: 'Short-lived MFA token from login step 1' })
  @IsString()
  mfaToken!: string;

  @ApiPropertyOptional({ description: '6-digit TOTP code' })
  @IsOptional()
  @IsString()
  @Length(6, 6)
  totpCode?: string;

  @ApiPropertyOptional({ description: 'Single-use recovery code' })
  @IsOptional()
  @IsString()
  recoveryCode?: string;
}
