import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { User } from '../users/entities/user.entity';
import { Profile } from '../users/entities/profile.entity';
import { Doctor } from '../doctors/entities/doctor.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { MfaRecoveryCode } from './entities/mfa-recovery-code.entity';
import { CryptoModule } from '../common/crypto/crypto.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Profile, Doctor, RefreshToken, MfaRecoveryCode]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>('JWT_ACCESS_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
    CryptoModule,
    ConfigModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtModule, PassportModule],
})
export class AuthModule {}
