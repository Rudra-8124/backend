import { IsEmail, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'patient@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'SecureP@ss123!' })
  @IsString()
  password!: string;
}
