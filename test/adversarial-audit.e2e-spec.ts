import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { Logger } from 'nestjs-pino';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../src/common/redis/redis.constants';
import { randomUUID, createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';

/**
 * Phase 8 Adversarial Security & Resilience Audit Suite
 *
 * Tests:
 * 1. Idempotency across state-changing endpoints (booking, cancellations, slots, webhooks)
 * 2. IDOR Matrix across all resource endpoints and roles
 * 3. Mass assignment defenses
 * 4. JWT tampering (alg none, wrong secret, expired, mfa token privilege escalation)
 * 5. Refresh token reuse & family invalidation
 * 6. MFA bypass attempts & recovery code replay
 * 7. Rate limiting & X-Forwarded-For spoofing resistance
 * 8. SQL injection on query parameters and pagination cursors
 */
describe('Phase 8 Adversarial Audit (e2e)', () => {
  let app: NestFastifyApplication;
  let dataSource: DataSource;
  let redis: Redis;
  let configService: ConfigService;

  // Test identities
  let patientA: { id: string; userId: string; token: string; email: string };
  let patientB: { id: string; userId: string; token: string; email: string };
  let doctorA: { id: string; userId: string; token: string; email: string };
  let doctorB: { id: string; userId: string; token: string; email: string };
  let admin: { userId: string; token: string; email: string };

  const password = 'AuditPassword123!@#';

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
    configService = app.get(ConfigService);

    // Flush rate limits
    const rlKeys = await redis.keys('rl:*');
    if (rlKeys.length > 0) await redis.del(...rlKeys);

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    const setupUser = async (role: 'patient' | 'doctor' | 'admin', name: string) => {
      const userId = randomUUID();
      const email = `${name.toLowerCase()}-${Date.now()}-${Math.random().toString(36).substring(7)}@audit.test`;
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
         VALUES ($1, $2, $3, $4, true, true)`,
        [userId, email, passwordHash, role],
      );
      await dataSource.query(
        `INSERT INTO profiles (id, user_id, first_name, last_name, timezone)
         VALUES (gen_random_uuid(), $1, $2, 'User', 'Asia/Kolkata')`,
        [userId, name],
      );

      let doctorId = '';
      if (role === 'doctor') {
        doctorId = randomUUID();
        await dataSource.query(
          `INSERT INTO doctors (id, user_id, license_number, specializations, experience_years, fee_cents, is_verified)
           VALUES ($1, $2, $3, '{"Ayurveda"}', 8, 40000, true)`,
          [doctorId, userId, `LIC-${name}-${Date.now()}`],
        );
      }

      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password },
      });
      const token = JSON.parse(loginRes.body).accessToken;

      return { id: doctorId, userId, token, email };
    };

    patientA = await setupUser('patient', 'PatientA');
    patientB = await setupUser('patient', 'PatientB');
    doctorA = await setupUser('doctor', 'DoctorA');
    doctorB = await setupUser('doctor', 'DoctorB');
    const adminUser = await setupUser('admin', 'AdminUser');
    admin = { userId: adminUser.userId, token: adminUser.token, email: adminUser.email };
  });

  afterAll(async () => {
    if (dataSource) {
      await dataSource.query("DELETE FROM users WHERE email LIKE '%@audit.test'");
    }
    if (redis) {
      const rlKeys = await redis.keys('rl:*');
      if (rlKeys.length > 0) await redis.del(...rlKeys);
    }
    if (app) {
      await app.close();
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // 1. IDEMPOTENCY AUDIT ACROSS ALL STATE-CHANGING ENDPOINTS
  // ══════════════════════════════════════════════════════════════════
  describe('Idempotency Deep Audit', () => {
    let testSlotId: string;
    let testConsultationId: string;

    beforeAll(async () => {
      // Create slot for testing
      const slotRes = await app.inject({
        method: 'POST',
        url: '/availability/slots',
        headers: {
          authorization: `Bearer ${doctorA.token}`,
          'idempotency-key': `slot-setup-${Date.now()}`,
        },
        payload: {
          startTime: '2026-11-10T10:00:00.000Z',
          durationMinutes: 30,
        },
      });
      testSlotId = JSON.parse(slotRes.body).id;

      // Book consultation
      const bookRes = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: {
          authorization: `Bearer ${patientA.token}`,
          'idempotency-key': `book-setup-${Date.now()}`,
        },
        payload: { slotId: testSlotId, reason: 'Initial Booking' },
      });
      testConsultationId = JSON.parse(bookRes.body).id;
    });

    it('POST /consultations: replay returns stored response with idempotency-replay header', async () => {
      // Create a dedicated slot
      const sRes = await app.inject({
        method: 'POST',
        url: '/availability/slots',
        headers: {
          authorization: `Bearer ${doctorA.token}`,
          'idempotency-key': `slot-idemp-${Date.now()}`,
        },
        payload: { startTime: '2026-11-11T14:00:00.000Z', durationMinutes: 30 },
      });
      const sId = JSON.parse(sRes.body).id;
      const idempKey = `idemp-book-${Date.now()}`;
      const payload = { slotId: sId, reason: 'Test Idempotency Replay' };

      const res1 = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: { authorization: `Bearer ${patientA.token}`, 'idempotency-key': idempKey },
        payload,
      });
      expect(res1.statusCode).toBe(201);
      const b1 = JSON.parse(res1.body);

      // Replay
      const res2 = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: { authorization: `Bearer ${patientA.token}`, 'idempotency-key': idempKey },
        payload,
      });
      expect(res2.statusCode).toBe(201);
      expect(res2.headers['idempotency-replay']).toBe('true');
      const b2 = JSON.parse(res2.body);
      expect(b2.id).toBe(b1.id);
    });

    it('POST /consultations: same key with DIFFERENT payload returns 422 Unprocessable Entity', async () => {
      const sRes = await app.inject({
        method: 'POST',
        url: '/availability/slots',
        headers: {
          authorization: `Bearer ${doctorA.token}`,
          'idempotency-key': `slot-idemp-422-${Date.now()}`,
        },
        payload: { startTime: '2026-11-12T14:00:00.000Z', durationMinutes: 30 },
      });
      const sId = JSON.parse(sRes.body).id;
      const idempKey = `idemp-422-${Date.now()}`;

      await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: { authorization: `Bearer ${patientA.token}`, 'idempotency-key': idempKey },
        payload: { slotId: sId, reason: 'First payload' },
      });

      const resDiff = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: { authorization: `Bearer ${patientA.token}`, 'idempotency-key': idempKey },
        payload: { slotId: sId, reason: 'Mutated different payload' },
      });
      expect(resDiff.statusCode).toBe(422);
    });

    it('PATCH /consultations/:id/cancel: replaying cancellation returns stored 200 replay', async () => {
      const cancelKey = `cancel-key-${Date.now()}`;
      const payload = { reason: 'Schedule conflict' };

      const res1 = await app.inject({
        method: 'PATCH',
        url: `/consultations/${testConsultationId}/cancel`,
        headers: { authorization: `Bearer ${patientA.token}`, 'idempotency-key': cancelKey },
        payload,
      });
      expect(res1.statusCode).toBe(200);

      // Replay
      const res2 = await app.inject({
        method: 'PATCH',
        url: `/consultations/${testConsultationId}/cancel`,
        headers: { authorization: `Bearer ${patientA.token}`, 'idempotency-key': cancelKey },
        payload,
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.headers['idempotency-replay']).toBe('true');
    });

    it('POST /webhooks/payments: duplicate event_id is safely deduplicated without reprocessing', async () => {
      const eventId = `evt-dedupe-${Date.now()}`;
      const timestamp = Math.floor(Date.now() / 1000);
      const secret = configService.get<string>('PAYMENT_WEBHOOK_SECRET') || '';

      const payload = {
        event_id: eventId,
        provider: 'mock-stripe',
        type: 'payment.succeeded',
        consultationId: testConsultationId,
        paymentIntentId: `pi-test-${Date.now()}`,
        amountCents: 40000,
        timestamp,
      };

      const rawPayload = JSON.stringify(payload);
      const hmac = createHmac('sha256', secret).update(`${timestamp}.${rawPayload}`).digest('hex');

      // First webhook delivery
      const res1 = await app.inject({
        method: 'POST',
        url: '/webhooks/payments',
        headers: {
          'x-webhook-signature': hmac,
          'x-webhook-timestamp': String(timestamp),
        },
        payload,
      });
      expect(res1.statusCode).toBe(200);

      // Duplicate delivery
      const res2 = await app.inject({
        method: 'POST',
        url: '/webhooks/payments',
        headers: {
          'x-webhook-signature': hmac,
          'x-webhook-timestamp': String(timestamp),
        },
        payload,
      });
      expect(res2.statusCode).toBe(200);
      expect(JSON.parse(res2.body).status).toBe('already_processed');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 2. SECURITY AUDIT: IDOR MATRIX
  // ══════════════════════════════════════════════════════════════════
  describe('Security Audit: IDOR Matrix', () => {
    let consultId: string;
    let rxId: string;

    beforeAll(async () => {
      // Create slot by DoctorA
      const sRes = await app.inject({
        method: 'POST',
        url: '/availability/slots',
        headers: {
          authorization: `Bearer ${doctorA.token}`,
          'idempotency-key': `idor-slot-${Date.now()}`,
        },
        payload: { startTime: '2026-11-20T09:00:00.000Z', durationMinutes: 30 },
      });
      const sId = JSON.parse(sRes.body).id;

      // Booked by PatientA
      const bRes = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: {
          authorization: `Bearer ${patientA.token}`,
          'idempotency-key': `idor-book-${Date.now()}`,
        },
        payload: { slotId: sId, reason: 'IDOR evaluation consultation' },
      });
      consultId = JSON.parse(bRes.body).id;

      // Transition to CONFIRMED and IN_PROGRESS
      await dataSource.query("UPDATE consultations SET status = 'IN_PROGRESS' WHERE id = $1", [
        consultId,
      ]);

      // DoctorA issues prescription
      const rxRes = await app.inject({
        method: 'POST',
        url: `/consultations/${consultId}/prescriptions`,
        headers: {
          authorization: `Bearer ${doctorA.token}`,
          'idempotency-key': `idor-rx-${Date.now()}`,
        },
        payload: {
          medications: [{ name: 'Ashwagandha', dosage: '500mg', frequency: 'daily' }],
          diagnosis: 'General Fatigue',
          notes: 'Sensitive clinical notes for Patient A',
        },
      });
      rxId = JSON.parse(rxRes.body).id;
    });

    it('IDOR Read Consultation: Patient owner (200), Doctor assigned (200), Admin (200)', async () => {
      const resP = await app.inject({
        method: 'GET',
        url: `/consultations/${consultId}`,
        headers: { authorization: `Bearer ${patientA.token}` },
      });
      expect(resP.statusCode).toBe(200);

      const resD = await app.inject({
        method: 'GET',
        url: `/consultations/${consultId}`,
        headers: { authorization: `Bearer ${doctorA.token}` },
      });
      expect(resD.statusCode).toBe(200);

      const resA = await app.inject({
        method: 'GET',
        url: `/consultations/${consultId}`,
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(resA.statusCode).toBe(200);
    });

    it('IDOR Read Consultation: Unrelated Patient B receives 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/consultations/${consultId}`,
        headers: { authorization: `Bearer ${patientB.token}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('IDOR Read Consultation: Unassigned Doctor B receives 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/consultations/${consultId}`,
        headers: { authorization: `Bearer ${doctorB.token}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('IDOR Prescription Read: Unrelated Patient B receives 403 Forbidden', async () => {
      const res1 = await app.inject({
        method: 'GET',
        url: `/consultations/${consultId}/prescriptions`,
        headers: { authorization: `Bearer ${patientB.token}` },
      });
      expect(res1.statusCode).toBe(403);

      const res2 = await app.inject({
        method: 'GET',
        url: `/prescriptions/${rxId}`,
        headers: { authorization: `Bearer ${patientB.token}` },
      });
      expect(res2.statusCode).toBe(403);
    });

    it('IDOR Prescription Read: Unassigned Doctor B receives 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/prescriptions/${rxId}`,
        headers: { authorization: `Bearer ${doctorB.token}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('IDOR Prescription Write: Unassigned Doctor B receives 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/consultations/${consultId}/prescriptions`,
        headers: {
          authorization: `Bearer ${doctorB.token}`,
          'idempotency-key': `idor-write-docb-${Date.now()}`,
        },
        payload: {
          medications: [{ name: 'Fake Med', dosage: '100mg', frequency: 'daily' }],
          diagnosis: 'Forged diagnosis',
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('IDOR Prescription Write: Patient cannot write prescriptions (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/consultations/${consultId}/prescriptions`,
        headers: {
          authorization: `Bearer ${patientA.token}`,
          'idempotency-key': `idor-write-pat-${Date.now()}`,
        },
        payload: {
          medications: [{ name: 'Self Med', dosage: '100mg', frequency: 'daily' }],
          diagnosis: 'Self diagnosis',
        },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 3. MASS ASSIGNMENT DEFENSE
  // ══════════════════════════════════════════════════════════════════
  describe('Mass Assignment Prevention', () => {
    it('PATCH /users/me: rejects non-whitelisted property { role: "admin" } with 400 Bad Request', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/users/me',
        headers: {
          authorization: `Bearer ${patientA.token}`,
          'idempotency-key': `mass-assign-${Date.now()}`,
        },
        payload: {
          firstName: 'Hacked',
          role: 'admin', // Injected privileged field
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.detail || body.message || '').toContain('Validation failed');
    });

    it('POST /auth/register: rejects non-whitelisted property { isVerified: true } with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: `attacker-${Date.now()}@test.com`,
          password: 'Password123!@#',
          firstName: 'Attacker',
          lastName: 'User',
          isVerified: true, // Non-whitelisted field
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 4. JWT TAMPERING & SIGNATURE VALIDATION
  // ══════════════════════════════════════════════════════════════════
  describe('JWT Tampering & Algorithm Confusion', () => {
    it('Rejects JWT with "alg: none" with 401 Unauthorized', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: patientA.userId,
          email: patientA.email,
          role: 'admin', // Escalated role
          type: 'access',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');

      const tamperedToken = `${header}.${payload}.`;

      const res = await app.inject({
        method: 'GET',
        url: '/users/me',
        headers: { authorization: `Bearer ${tamperedToken}` },
      });

      expect(res.statusCode).toBe(401);
    });

    it('Rejects JWT signed with wrong secret with 401 Unauthorized', async () => {
      const forgedToken = jwt.sign(
        { sub: patientA.userId, email: patientA.email, role: 'admin', type: 'access' },
        'wrong-secret-key-that-does-not-match-jwt-access-secret',
        { expiresIn: '1h' },
      );

      const res = await app.inject({
        method: 'GET',
        url: '/users/me',
        headers: { authorization: `Bearer ${forgedToken}` },
      });

      expect(res.statusCode).toBe(401);
    });

    it('Rejects expired JWT with 401 Unauthorized', async () => {
      const accessSecret = configService.get<string>('JWT_ACCESS_SECRET') || 'secret';
      const expiredToken = jwt.sign(
        { sub: patientA.userId, email: patientA.email, role: 'patient', type: 'access' },
        accessSecret,
        { expiresIn: '-10s' }, // Expired 10 seconds ago
      );

      const res = await app.inject({
        method: 'GET',
        url: '/users/me',
        headers: { authorization: `Bearer ${expiredToken}` },
      });

      expect(res.statusCode).toBe(401);
    });

    it('Rejects MFA token (type: "mfa") when used as access token with 401 Unauthorized', async () => {
      const accessSecret = configService.get<string>('JWT_ACCESS_SECRET') || 'secret';
      const mfaToken = jwt.sign(
        { sub: patientA.userId, email: patientA.email, role: 'patient', type: 'mfa' },
        accessSecret,
        { expiresIn: '5m' },
      );

      const res = await app.inject({
        method: 'GET',
        url: '/users/me',
        headers: { authorization: `Bearer ${mfaToken}` },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 5. REFRESH TOKEN REUSE DETECTION & FAMILY REVOCATION
  // ══════════════════════════════════════════════════════════════════
  describe('Refresh Token Reuse & Family Invalidation', () => {
    it('Revokes entire token family when an already-used refresh token is presented', async () => {
      // Clear rate limit before login
      const rlKeys = await redis.keys('rl:*');
      if (rlKeys.length > 0) await redis.del(...rlKeys);

      // 1. Login to obtain fresh token pair
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: patientB.email, password },
      });
      const originalRefresh = JSON.parse(loginRes.body).refreshToken;

      // 2. Legitimate refresh: exchange originalRefresh for new pair
      const refresh1Res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: originalRefresh },
      });
      expect(refresh1Res.statusCode).toBe(200);
      const childRefresh = JSON.parse(refresh1Res.body).refreshToken;

      // 3. Adversary replays the already-used originalRefresh
      const replayRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: originalRefresh },
      });
      expect(replayRes.statusCode).toBe(401);
      const replayBody = JSON.parse(replayRes.body);
      expect(replayBody.detail || replayBody.message || '').toContain('reuse detected');

      // 4. Verify child token has now been revoked as part of the family revocation
      const childRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: childRefresh },
      });
      expect(childRes.statusCode).toBe(401);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 6. MFA BYPASS & RECOVERY CODE DEFENSES
  // ══════════════════════════════════════════════════════════════════
  describe('MFA Bypass Defenses', () => {
    it('Rejects invalid TOTP code during step-2 verification with 401 Unauthorized', async () => {
      // Clear rate limit
      const rlKeys = await redis.keys('rl:*');
      if (rlKeys.length > 0) await redis.del(...rlKeys);

      // Setup doctor with MFA
      const setupRes = await app.inject({
        method: 'POST',
        url: '/auth/mfa/setup',
        headers: {
          authorization: `Bearer ${doctorA.token}`,
          'idempotency-key': `mfa-setup-${Date.now()}`,
        },
      });
      const { secret } = JSON.parse(setupRes.body);

      // Confirm MFA setup
      const validCode = authenticator.generate(secret);
      const confirmRes = await app.inject({
        method: 'POST',
        url: '/auth/mfa/setup/confirm',
        headers: { authorization: `Bearer ${doctorA.token}` },
        payload: { totpCode: validCode },
      });
      expect(confirmRes.statusCode).toBe(201);

      // Login step 1: gets mfa_token
      const step1 = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: doctorA.email, password },
      });
      const { mfaToken } = JSON.parse(step1.body);
      expect(mfaToken).toBeDefined();

      // Attempt step 2 with forged code
      const step2 = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { mfaToken, totpCode: '000000' },
      });
      expect(step2.statusCode).toBe(401);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 7. RATE LIMITING & IP SPOOFING RESISTANCE
  // ══════════════════════════════════════════════════════════════════
  describe('Rate Limiting & X-Forwarded-For Defense', () => {
    it('Does NOT allow rate limit bypass via spoofed X-Forwarded-For header', async () => {
      // Login endpoint has strict tier (5 req/min)
      const requests = Array.from({ length: 6 }).map((_, i) =>
        app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: {
            // Attacker attempts to rotate X-Forwarded-For to bypass IP rate limits
            'x-forwarded-for': `203.0.113.${i + 1}`,
          },
          payload: { email: 'nonexistent@test.com', password: 'wrong' },
        }),
      );

      const responses = await Promise.all(requests);
      const statusCodes = responses.map((r) => r.statusCode);

      // At least one request must hit 429 Too Many Requests
      expect(statusCodes).toContain(429);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 8. SQL INJECTION AUDIT ON QUERY PARAMETERS & CURSORS
  // ══════════════════════════════════════════════════════════════════
  describe('SQL Injection Parameterization Audit', () => {
    it('GET /search/doctors: SQL injection in search text is escaped via plainto_tsquery', async () => {
      const res = await app.inject({
        method: 'GET',
        url: "/search/doctors?q='; DROP TABLE users; --",
        headers: { authorization: `Bearer ${patientA.token}` },
      });

      expect(res.statusCode).toBe(200);

      // Verify users table was NOT dropped
      const checkUsers = await dataSource.query('SELECT COUNT(*) FROM users');
      expect(parseInt(checkUsers[0].count, 10)).toBeGreaterThan(0);
    });

    it('GET /search/doctors: SQL injection in specialty parameter is safely parameterized', async () => {
      const res = await app.inject({
        method: 'GET',
        url: "/search/doctors?specialty=Ayurveda' OR '1'='1",
        headers: { authorization: `Bearer ${patientA.token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results).toBeDefined();
    });

    it('GET /search/doctors: Non-numeric SQL injection in min_price is rejected with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: "/search/doctors?min_price=100' OR 1=1; --",
        headers: { authorization: `Bearer ${patientA.token}` },
      });

      expect(res.statusCode).toBe(400);
    });

    it('GET /search/doctors: SQL injection in base64 pagination cursor is safely parameterized', async () => {
      const maliciousCursor = Buffer.from(
        JSON.stringify({ id: "' OR 1=1; --", sortValue: 5 }),
      ).toString('base64');

      const res = await app.inject({
        method: 'GET',
        url: `/search/doctors?cursor=${maliciousCursor}`,
        headers: { authorization: `Bearer ${patientA.token}` },
      });

      expect(res.statusCode).toBe(200);
    });
  });
});
