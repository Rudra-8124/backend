import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';

import { envValidationSchema } from './common/config/env.validation';
import { pinoLoggerConfig } from './common/logger/logger.config';
import { DatabaseModule } from './common/database/database.module';
import { RedisModule } from './common/redis/redis.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { HealthModule } from './common/health/health.module';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { RateLimitGuard } from './common/rate-limit/rate-limit.guard';

import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { DoctorsModule } from './doctors/doctors.module';
import { AvailabilityModule } from './availability/availability.module';
import { ConsultationsModule } from './consultations/consultations.module';
import { PrescriptionsModule } from './prescriptions/prescriptions.module';
import { PaymentsModule } from './payments/payments.module';
import { SearchModule } from './search/search.module';
import { AuditModule } from './audit/audit.module';
import { AdminAnalyticsModule } from './admin-analytics/admin-analytics.module';
import { IdempotencyModule } from './idempotency/idempotency.module';

@Module({
  imports: [
    // ── Config (fail fast on missing vars) ──
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: true },
      envFilePath: ['.env'],
    }),

    // ── Logging ──
    LoggerModule.forRootAsync({
      useFactory: () => pinoLoggerConfig(),
    }),

    // ── Infrastructure ──
    DatabaseModule,
    RedisModule,
    CryptoModule,
    RateLimitModule,
    HealthModule,

    // ── Domain modules ──
    AuthModule,
    UsersModule,
    DoctorsModule,
    AvailabilityModule,
    ConsultationsModule,
    PrescriptionsModule,
    PaymentsModule,
    SearchModule,
    AuditModule,
    AdminAnalyticsModule,
    IdempotencyModule,
  ],
  providers: [
    // ── Global exception filter (RFC 7807) ──
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },

    // ── Global validation pipe ──
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    },

    // ── Global guards (order matters: auth → roles → rate limit) ──
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },

    // ── Global interceptor (Idempotency) ──
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
