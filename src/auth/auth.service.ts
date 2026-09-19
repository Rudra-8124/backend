import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';

import { User, UserRole } from '../users/entities/user.entity';
import { Profile } from '../users/entities/profile.entity';
import { Doctor } from '../doctors/entities/doctor.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { MfaRecoveryCode } from './entities/mfa-recovery-code.entity';
import { EncryptionService } from '../common/crypto/encryption.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './jwt.strategy';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly REFRESH_TOKEN_EXPIRY_DAYS = 30;
  private readonly RECOVERY_CODE_COUNT = 8;

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Profile) private readonly profileRepo: Repository<Profile>,
    @InjectRepository(Doctor) private readonly doctorRepo: Repository<Doctor>,
    @InjectRepository(RefreshToken) private readonly refreshTokenRepo: Repository<RefreshToken>,
    @InjectRepository(MfaRecoveryCode) private readonly mfaCodeRepo: Repository<MfaRecoveryCode>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly encryptionService: EncryptionService,
    private readonly dataSource: DataSource,
  ) {}

  // ── Register ──────────────────────────────────────

  async register(dto: RegisterDto) {
    const existing = await this.userRepo.findOne({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    const role = dto.role === 'doctor' ? UserRole.DOCTOR : UserRole.PATIENT;

    return this.dataSource.transaction(async (manager) => {
      const user = manager.create(User, {
        email: dto.email,
        passwordHash,
        role,
        isVerified: role === UserRole.PATIENT, // patients auto-verified, doctors need admin approval
      });
      await manager.save(user);

      const profile = manager.create(Profile, {
        userId: user.id,
        firstName: dto.firstName,
        lastName: dto.lastName,
      });
      await manager.save(profile);

      if (role === UserRole.DOCTOR) {
        if (!dto.licenseNumber) {
          throw new BadRequestException('License number required for doctor registration');
        }
        const doctor = manager.create(Doctor, {
          userId: user.id,
          licenseNumber: dto.licenseNumber,
          specializations: dto.specializations || [],
          experienceYears: dto.experienceYears || 0,
          feeCents: dto.feeCents || 0,
          isVerified: false, // requires admin approval
        });
        await manager.save(doctor);
      }

      this.logger.log({ msg: 'User registered', userId: user.id, role });

      return {
        userId: user.id,
        role: user.role,
        message:
          role === UserRole.DOCTOR
            ? 'Doctor registration submitted. Awaiting admin approval.'
            : 'Registration successful.',
      };
    });
  }

  // ── Login (two-step for MFA) ──────────────────────

  async login(dto: LoginDto) {
    const user = await this.userRepo.findOne({ where: { email: dto.email } });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    if (!user.isActive) throw new ForbiddenException('Account deactivated');

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    if (user.role === UserRole.DOCTOR && !user.isVerified) {
      throw new ForbiddenException('Doctor account pending verification');
    }

    // If MFA is enabled, return a short-lived MFA token instead of full access
    if (user.mfaEnabled) {
      const mfaToken = this.jwtService.sign(
        { sub: user.id, email: user.email, role: user.role, type: 'mfa' } as JwtPayload,
        {
          secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
          expiresIn: '5m',
        },
      );
      return { mfaRequired: true, mfaToken };
    }

    // No MFA — issue full tokens
    return this.issueTokenPair(user);
  }

  // ── MFA Setup ─────────────────────────────────────

  async setupMfa(userId: string) {
    const user = await this.userRepo.findOneOrFail({ where: { id: userId } });
    if (user.mfaEnabled) throw new ConflictException('MFA already enabled');

    const secret = authenticator.generateSecret();
    const issuer = this.configService.get<string>('TOTP_ISSUER', 'Amrutam');
    const otpauthUrl = authenticator.keyuri(user.email, issuer, secret);

    // Store encrypted secret (not yet enabled — user must verify first)
    const encryptedSecret = await this.encryptionService.encrypt(secret);
    await this.userRepo.update(user.id, { mfaSecret: encryptedSecret });

    // Generate recovery codes
    const recoveryCodes: string[] = [];
    const codeEntities: MfaRecoveryCode[] = [];
    for (let i = 0; i < this.RECOVERY_CODE_COUNT; i++) {
      const code = randomBytes(4).toString('hex').toUpperCase(); // 8-char hex
      recoveryCodes.push(code);
      codeEntities.push(
        this.mfaCodeRepo.create({
          userId: user.id,
          codeHash: this.hashRecoveryCode(code),
          isUsed: false,
        }),
      );
    }

    // Delete old codes and insert new ones
    await this.mfaCodeRepo.delete({ userId: user.id });
    await this.mfaCodeRepo.save(codeEntities);

    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

    return { secret, qrUrl: qrDataUrl, recoveryCodes };
  }

  async confirmMfaSetup(userId: string, totpCode: string) {
    const user = await this.userRepo.findOneOrFail({ where: { id: userId } });
    if (!user.mfaSecret) throw new BadRequestException('MFA setup not initiated');

    const secret = await this.encryptionService.decrypt(user.mfaSecret);
    const valid = authenticator.verify({ token: totpCode, secret });
    if (!valid) throw new UnauthorizedException('Invalid TOTP code');

    await this.userRepo.update(user.id, { mfaEnabled: true });
    return { message: 'MFA enabled successfully' };
  }

  // ── MFA Verify (login step 2) ─────────────────────

  async verifyMfa(mfaToken: string, totpCode?: string, recoveryCode?: string) {
    if (!totpCode && !recoveryCode) {
      throw new BadRequestException('Provide either totpCode or recoveryCode');
    }

    // Verify the MFA token
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(mfaToken, {
        secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired MFA token');
    }

    if (payload.type !== 'mfa') {
      throw new UnauthorizedException('Invalid token type');
    }

    const user = await this.userRepo.findOneOrFail({ where: { id: payload.sub } });
    if (!user.mfaSecret) throw new UnauthorizedException('MFA not configured');

    if (totpCode) {
      const secret = await this.encryptionService.decrypt(user.mfaSecret);
      const valid = authenticator.verify({ token: totpCode, secret });
      if (!valid) throw new UnauthorizedException('Invalid TOTP code');
    } else if (recoveryCode) {
      await this.consumeRecoveryCode(user.id, recoveryCode);
    }

    return this.issueTokenPair(user);
  }

  // ── Refresh Token ─────────────────────────────────

  async refreshTokens(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    const storedToken = await this.refreshTokenRepo.findOne({
      where: { tokenHash },
    });

    if (!storedToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Check if token has been revoked (reuse detection)
    if (storedToken.isRevoked) {
      // Reuse detected! Revoke the entire family
      this.logger.warn({
        msg: 'Refresh token reuse detected — revoking family',
        userId: storedToken.userId,
        familyId: storedToken.familyId,
      });
      await this.refreshTokenRepo.update({ familyId: storedToken.familyId }, { isRevoked: true });
      throw new UnauthorizedException('Refresh token reuse detected — all sessions revoked');
    }

    // Check expiry
    if (storedToken.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    // Revoke the current token (rotation)
    await this.refreshTokenRepo.update(storedToken.id, { isRevoked: true });

    // Issue new pair with same family
    const user = await this.userRepo.findOneOrFail({ where: { id: storedToken.userId } });
    return this.issueTokenPair(user, storedToken.familyId);
  }

  // ── Logout ────────────────────────────────────────

  async logout(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    const storedToken = await this.refreshTokenRepo.findOne({
      where: { tokenHash },
    });
    if (storedToken) {
      await this.refreshTokenRepo.update(storedToken.id, { isRevoked: true });
    }
    return { message: 'Logged out successfully' };
  }

  // ── Private helpers ───────────────────────────────

  private async issueTokenPair(user: User, familyId?: string) {
    const accessPayload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      type: 'access',
    };

    const accessToken = this.jwtService.sign(accessPayload, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: '15m',
    });

    // Generate refresh token (random, stored hashed)
    const rawRefreshToken = randomBytes(48).toString('base64url');
    const tokenHash = this.hashToken(rawRefreshToken);
    const newFamilyId = familyId || randomUUID();

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.REFRESH_TOKEN_EXPIRY_DAYS);

    const rt = this.refreshTokenRepo.create({
      userId: user.id,
      tokenHash,
      familyId: newFamilyId,
      isRevoked: false,
      expiresAt,
    });
    await this.refreshTokenRepo.save(rt);

    return {
      accessToken,
      refreshToken: rawRefreshToken,
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private hashRecoveryCode(code: string): string {
    return createHash('sha256').update(code.toUpperCase()).digest('hex');
  }

  private async consumeRecoveryCode(userId: string, code: string): Promise<void> {
    const hash = this.hashRecoveryCode(code);
    const stored = await this.mfaCodeRepo.findOne({
      where: { userId, codeHash: hash, isUsed: false },
    });
    if (!stored) throw new UnauthorizedException('Invalid or already used recovery code');
    await this.mfaCodeRepo.update(stored.id, { isUsed: true });
  }
}
