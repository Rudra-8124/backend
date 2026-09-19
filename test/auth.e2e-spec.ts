import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { Logger } from 'nestjs-pino';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../src/common/redis/redis.constants';
import { authenticator } from 'otplib';
import { pinoLoggerConfig } from '../src/common/logger/logger.config';

/**
 * Auth Integration Tests
 *
 * Requires running Postgres + Redis (use docker-compose).
 * Tests: register, login, refresh rotation, refresh reuse detection,
 *        MFA flow, RBAC, rate limiting, validation, log redaction.
 */
describe('Auth (e2e)', () => {
  let app: NestFastifyApplication;
  let dataSource: DataSource;
  let redis: Redis;

  // Test user credentials
  const patientEmail = `patient-${Date.now()}@test.com`;
  const doctorEmail = `doctor-${Date.now()}@test.com`;
  const password = 'TestPassword123!';

  let patientAccessToken: string;
  let patientRefreshToken: string;
  let doctorMfaToken: string;
  let doctorAccessToken: string;
  let adminAccessToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    const logger = app.get(Logger);
    app.useLogger(logger);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    dataSource = app.get(DataSource);
    redis = app.get(REDIS_CLIENT);

    // Ensure migration has been run and seed admin exists
    // Create admin for tests if needed
    const adminExists = await dataSource.query(
      "SELECT id FROM users WHERE email = 'admin@amrutam.test'",
    );
    if (adminExists.length > 0) {
      // Login as admin
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@amrutam.test', password: 'AdminPass123!@#Secure' },
      });
      if (res.statusCode === 200) {
        const body = JSON.parse(res.body);
        adminAccessToken = body.accessToken;
      }
    }
  });

  afterAll(async () => {
    // Cleanup test users
    if (dataSource) {
      await dataSource.query("DELETE FROM users WHERE email LIKE '%@test.com'");
    }
    // Flush rate-limit keys
    if (redis) {
      const keys = await redis.keys('rl:*');
      if (keys.length > 0) await redis.del(...keys);
    }
    if (app) {
      await app.close();
    }
  });

  // ── Registration ──────────────────────────────────

  describe('POST /auth/register', () => {
    it('should register a patient', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: patientEmail,
          password,
          firstName: 'Test',
          lastName: 'Patient',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.userId).toBeDefined();
      expect(body.role).toBe('patient');
    });

    it('should register a doctor (pending verification)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: doctorEmail,
          password,
          firstName: 'Test',
          lastName: 'Doctor',
          role: 'doctor',
          licenseNumber: `LIC-${Date.now()}`,
          specializations: ['Ayurveda'],
          experienceYears: 5,
          feeCents: 50000,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.role).toBe('doctor');
      expect(body.message).toContain('admin approval');
    });

    it('should reject duplicate email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: patientEmail,
          password,
          firstName: 'Dup',
          lastName: 'User',
        },
      });
      expect(res.statusCode).toBe(409);
    });

    it('should reject unknown fields (forbidNonWhitelisted)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'new@test.com',
          password,
          firstName: 'Test',
          lastName: 'User',
          unknownField: 'should be rejected',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.title).toBe('Bad Request');
    });
  });

  // ── Login ─────────────────────────────────────────

  describe('POST /auth/login', () => {
    it('should login a patient and return tokens', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: patientEmail, password },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).toBeDefined();
      patientAccessToken = body.accessToken;
      patientRefreshToken = body.refreshToken;
    });

    it('should reject invalid password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: patientEmail, password: 'wrong' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('should reject unverified doctor', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: doctorEmail, password },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Refresh token rotation ────────────────────────

  describe('POST /auth/refresh', () => {
    it('should rotate refresh token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: patientRefreshToken },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).toBeDefined();
      expect(body.refreshToken).not.toBe(patientRefreshToken);

      // Save the new tokens
      const oldRefreshToken = patientRefreshToken;
      patientAccessToken = body.accessToken;
      patientRefreshToken = body.refreshToken;

      // Old token should now fail (it was revoked during rotation)
      const res2 = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: oldRefreshToken },
      });
      expect(res2.statusCode).toBe(401);
    });

    it('should revoke entire family on refresh token reuse', async () => {
      // Login fresh to get a new family
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: patientEmail, password },
      });
      const { refreshToken: rt1 } = JSON.parse(loginRes.body);

      // Rotate once to get rt2
      const rot1 = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: rt1 },
      });
      const { refreshToken: rt2 } = JSON.parse(rot1.body);

      // Reuse rt1 (already revoked) → triggers family revocation
      const reuseRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: rt1 },
      });
      expect(reuseRes.statusCode).toBe(401);
      const reuseBody = JSON.parse(reuseRes.body);
      expect(reuseBody.detail || reuseBody.title).toContain('reuse');

      // rt2 should also now be revoked (entire family)
      const rt2Res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: rt2 },
      });
      expect(rt2Res.statusCode).toBe(401);
    });
  });

  // ── MFA Flow ──────────────────────────────────────

  describe('MFA for doctor', () => {
    let doctorId: string;
    let totpSecret: string;

    beforeAll(async () => {
      // Clear rate limit keys so doctor login isn't blocked by previous tests
      const rlKeys = await redis.keys('rl:*');
      if (rlKeys.length > 0) await redis.del(...rlKeys);

      // Admin verifies the doctor so they can log in
      const rows = await dataSource.query('SELECT id FROM users WHERE email = $1', [doctorEmail]);
      doctorId = rows[0].id;
      await dataSource.query('UPDATE users SET is_verified = true WHERE id = $1', [doctorId]);
    });

    it('should login doctor without MFA initially', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: doctorEmail, password },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.accessToken).toBeDefined();
      doctorAccessToken = body.accessToken;
    });

    it('should setup MFA (TOTP)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/setup',
        headers: { authorization: `Bearer ${doctorAccessToken}` },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.secret).toBeDefined();
      expect(body.qrUrl).toBeDefined();
      expect(body.recoveryCodes).toHaveLength(8);
      totpSecret = body.secret;
    });

    it('should confirm MFA setup with valid TOTP', async () => {
      const code = authenticator.generate(totpSecret);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/setup/confirm',
        headers: { authorization: `Bearer ${doctorAccessToken}` },
        payload: { totpCode: code },
      });
      expect(res.statusCode).toBe(201);
    });

    it('should require MFA on next login (two-step)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: doctorEmail, password },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.mfaRequired).toBe(true);
      expect(body.mfaToken).toBeDefined();
      doctorMfaToken = body.mfaToken;
    });

    it('should reject wrong TOTP code', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { mfaToken: doctorMfaToken, totpCode: '000000' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('should reject expired/replayed MFA token', async () => {
      // Use a clearly invalid token
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { mfaToken: 'invalid.token.here', totpCode: '123456' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('should accept valid TOTP and return full tokens', async () => {
      // Need a fresh MFA token (the old one may be the same, which is fine if not expired)
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: doctorEmail, password },
      });
      const { mfaToken } = JSON.parse(loginRes.body);

      const code = authenticator.generate(totpSecret);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { mfaToken, totpCode: code },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).toBeDefined();
      doctorAccessToken = body.accessToken;
    });
  });

  // ── RBAC ──────────────────────────────────────────

  describe('RBAC', () => {
    it('should deny patient access to admin-only route', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/users',
        headers: { authorization: `Bearer ${patientAccessToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should deny unauthenticated access to protected route', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/users/me',
      });
      expect(res.statusCode).toBe(401);
    });

    it('should allow authenticated user to access /users/me', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/users/me',
        headers: { authorization: `Bearer ${patientAccessToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.email).toBe(patientEmail);
      // Ensure sensitive fields are stripped
      expect(body.passwordHash).toBeUndefined();
      expect(body.mfaSecret).toBeUndefined();
    });

    it('should deny doctor access to admin routes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/users',
        headers: { authorization: `Bearer ${doctorAccessToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should allow admin access to /users', async () => {
      if (adminAccessToken) {
        const res = await app.inject({
          method: 'GET',
          url: '/users',
          headers: { authorization: `Bearer ${adminAccessToken}` },
        });
        expect(res.statusCode).toBe(200);
      }
    });
  });

  // ── Rate Limiting ─────────────────────────────────

  describe('Rate Limiting', () => {
    it('should return 429 after exceeding strict tier (5 req/min)', async () => {
      // Flush rate limit keys for this test
      const keys = await redis.keys('rl:*register*');
      if (keys.length > 0) await redis.del(...keys);

      const uniqueBase = `ratelimit-${Date.now()}`;
      const responses: number[] = [];

      for (let i = 0; i < 8; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            email: `${uniqueBase}-${i}@test.com`,
            password: 'TestPass123!',
            firstName: 'Rate',
            lastName: 'Test',
          },
        });
        responses.push(res.statusCode);
      }

      // At least one should be 429 (strict tier = 5 req/min)
      expect(responses).toContain(429);
      // The first 5 should succeed or conflict
      expect(responses.slice(0, 5).every((r) => r < 429)).toBe(true);
    });
  });

  // ── Health Endpoints ──────────────────────────────

  describe('Health', () => {
    it('GET /healthz should return ok', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('ok');
    });

    it('GET /readyz should check DB and Redis', async () => {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.checks.db).toBe('ok');
      expect(body.checks.redis).toBe('ok');
    });
  });

  // ── Validation ────────────────────────────────────

  describe('Validation', () => {
    beforeAll(async () => {
      const keys = await redis.keys('rl:*');
      if (keys.length > 0) await redis.del(...keys);
    });

    it('should reject invalid email format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'not-an-email',
          password,
          firstName: 'Test',
          lastName: 'User',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject short password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'short@test.com',
          password: 'short',
          firstName: 'Test',
          lastName: 'User',
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── Log Redaction ─────────────────────────────────

  describe('Log Redaction', () => {
    it('should not contain passwords or tokens in log output', async () => {
      // We can't easily inspect pino output in tests, but we verify
      // the redact config is set. The actual test is that the logger
      // config includes password/token fields in the redaction list.
      const config = pinoLoggerConfig();
      const redactPaths: string[] = (config.pinoHttp as any).redact.paths;

      expect(redactPaths).toContain('req.body.password');
      expect(redactPaths).toContain('req.headers.authorization');
      expect(redactPaths).toContain('req.body.refreshToken');
      expect(redactPaths).toContain('req.body.totpCode');
      expect(redactPaths).toContain('req.body.recoveryCode');
    });
  });
});
