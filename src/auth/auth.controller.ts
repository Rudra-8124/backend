import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { MfaVerifyDto } from './dto/mfa-verify.dto';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, RequestUser } from '../common/decorators/current-user.decorator';
import { RateLimit } from '../common/rate-limit/rate-limit.guard';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @RateLimit('strict')
  @ApiOperation({ summary: 'Register a new patient or doctor' })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit('strict')
  @ApiOperation({ summary: 'Login — returns tokens or MFA challenge' })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit('strict')
  @ApiOperation({ summary: 'Complete MFA verification (login step 2)' })
  async verifyMfa(@Body() dto: MfaVerifyDto) {
    return this.authService.verifyMfa(dto.mfaToken, dto.totpCode, dto.recoveryCode);
  }

  @Post('mfa/setup')
  @ApiBearerAuth('access-token')
  @Roles('doctor', 'admin')
  @RateLimit('strict')
  @ApiOperation({ summary: 'Generate TOTP secret and recovery codes' })
  async setupMfa(@CurrentUser() user: RequestUser) {
    return this.authService.setupMfa(user.userId);
  }

  @Post('mfa/setup/confirm')
  @ApiBearerAuth('access-token')
  @Roles('doctor', 'admin')
  @RateLimit('strict')
  @ApiOperation({ summary: 'Confirm MFA setup with a TOTP code' })
  async confirmMfaSetup(@CurrentUser() user: RequestUser, @Body() body: { totpCode: string }) {
    return this.authService.confirmMfaSetup(user.userId, body.totpCode);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiOperation({ summary: 'Refresh access token (rotates refresh token)' })
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshTokens(dto.refreshToken);
  }

  @Post('logout')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiOperation({ summary: 'Logout — revoke refresh token' })
  async logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }
}
