import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { Logger } from 'nestjs-pino';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../src/common/redis/redis.constants';
import { AuditService } from '../src/audit/audit.service';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';

describe('Phase 4: Search, Caching, Admin Analytics, and Audit (e2e)', () => {
  let app: NestFastifyApplication;
  let dataSource: DataSource;
  let redis: Redis;
  let auditService: AuditService;

  let adminToken: string;
  let doctorToken: string;
  let doctorUserId: string;
  let doctorId: string;
  let patientToken: string;

  const password = 'TestPassword123!Secure';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      rawBody: true,
    });
    const logger = app.get(Logger);
    app.useLogger(logger);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    dataSource = app.get(DataSource);
    redis = app.get(REDIS_CLIENT);
    auditService = app.get(AuditService);

    // Clear rate limits
    const rlKeys = await redis.keys('rl:*');
    if (rlKeys.length > 0) await redis.del(...rlKeys);

    // Clear test cache keys
    const cacheKeys = await redis.keys('*search:doctors*');
    if (cacheKeys.length > 0) await redis.del(...cacheKeys);

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    // 1. Admin user
    const adminEmail = `admin_p4_${Date.now()}@amrutam.local`;
    const adminUser = await dataSource.query(
      `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
       VALUES (gen_random_uuid(), $1, $2, 'admin', true, true)
       RETURNING id;`,
      [adminEmail, passwordHash],
    );
    await dataSource.query(
      `INSERT INTO profiles (user_id, first_name, last_name) VALUES ($1, 'Admin', 'Officer');`,
      [adminUser[0].id],
    );

    // 2. Doctor user
    const doctorEmail = `doc_p4_${Date.now()}@amrutam.local`;
    const docUser = await dataSource.query(
      `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
       VALUES (gen_random_uuid(), $1, $2, 'doctor', true, true)
       RETURNING id;`,
      [doctorEmail, passwordHash],
    );
    doctorUserId = docUser[0].id;
    await dataSource.query(
      `INSERT INTO profiles (user_id, first_name, last_name, city) VALUES ($1, 'Devendra', 'Joshi', 'Pune');`,
      [doctorUserId],
    );

    const docResult = await dataSource.query(
      `INSERT INTO doctors (
        user_id, bio, license_number, specializations, languages,
        experience_years, fee_cents, rating_avg, rating_count, is_verified
      ) VALUES (
        $1, 'Holistic Ayurvedic specialist with extensive knowledge in Panchakarma therapies.',
        $2, ARRAY['Ayurveda', 'Panchakarma'], ARRAY['Hindi', 'English', 'Marathi'],
        12, 45000, 4.85, 42, true
      ) RETURNING id;`,
      [doctorUserId, `LIC-P4-${Date.now()}`],
    );
    doctorId = docResult[0].id;

    // 3. Patient user
    const patientEmail = `pat_p4_${Date.now()}@amrutam.local`;
    const patUser = await dataSource.query(
      `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
       VALUES (gen_random_uuid(), $1, $2, 'patient', true, true)
       RETURNING id;`,
      [patientEmail, passwordHash],
    );
    await dataSource.query(
      `INSERT INTO profiles (user_id, first_name, last_name, city) VALUES ($1, 'Rahul', 'Sharma', 'Mumbai');`,
      [patUser[0].id],
    );

    // Log in to retrieve JWT access tokens
    const adminLoginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: adminEmail, password },
    });
    adminToken = JSON.parse(adminLoginRes.body).accessToken;

    const docLoginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: doctorEmail, password },
    });
    doctorToken = JSON.parse(docLoginRes.body).accessToken;

    const patLoginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: patientEmail, password },
    });
    patientToken = JSON.parse(patLoginRes.body).accessToken;

    // Seed test consultation data for analytics tests
    const slotMonth = new Date().toISOString().slice(0, 7) + '-01';
    const slotTime = new Date(Date.now() - 24 * 3600 * 1000);
    const slotEndTime = new Date(slotTime.getTime() + 30 * 60 * 1000);

    const slotRes = await dataSource.query(
      `INSERT INTO availability_slots (id, partition_month, doctor_id, start_time, end_time, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'COMPLETED', $3, $3)
       RETURNING id, partition_month;`,
      [slotMonth, doctorId, slotTime, slotEndTime],
    );

    const consultRes = await dataSource.query(
      `INSERT INTO consultations (
         id, partition_month, patient_id, doctor_id, slot_id, slot_partition_month,
         status, scheduled_start, scheduled_end, created_at, updated_at
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $5,
         'COMPLETED', $6, $7, $6, $6
       ) RETURNING id;`,
      [
        slotMonth,
        patUser[0].id,
        doctorId,
        slotRes[0].id,
        slotRes[0].partition_month,
        slotTime,
        slotEndTime,
      ],
    );

    await dataSource.query(
      `INSERT INTO payments (id, consultation_id, consultation_partition_month, amount_cents, currency, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 45000, 'INR', 'SUCCESS', $3, $3);`,
      [consultRes[0].id, slotMonth, slotTime],
    );

    await dataSource.query(
      'REFRESH MATERIALIZED VIEW CONCURRENTLY daily_consultation_analytics_mv;',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 1: DOCTOR SEARCH & FILTERING
  // ──────────────────────────────────────────────────────────────────────────

  describe('1. Doctor Search & Filtering', () => {
    it('should search doctors by specialty', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/search/doctors?specialty=Ayurveda&limit=10',
        headers: { authorization: `Bearer ${patientToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results).toBeDefined();
      expect(body.results.length).toBeGreaterThan(0);
      for (const doc of body.results) {
        expect(doc.specializations).toContain('Ayurveda');
      }
    });

    it('should search doctors by spoken language', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/search/doctors?language=Marathi&limit=10',
        headers: { authorization: `Bearer ${patientToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results).toBeDefined();
      expect(body.results.length).toBeGreaterThan(0);
      for (const doc of body.results) {
        expect(doc.languages).toContain('Marathi');
      }
    });

    it('should filter doctors by fee price range and minimum rating', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/search/doctors?min_price=40000&max_price=50000&min_rating=4.5&limit=10',
        headers: { authorization: `Bearer ${patientToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results.length).toBeGreaterThan(0);
      for (const doc of body.results) {
        expect(doc.feeCents).toBeGreaterThanOrEqual(40000);
        expect(doc.feeCents).toBeLessThanOrEqual(50000);
        expect(Number(doc.ratingAvg)).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('should perform typo-tolerant trigram search on doctor name', async () => {
      // Searching for "Devndra Jshi" should match "Devendra Joshi"
      const res = await app.inject({
        method: 'GET',
        url: '/search/doctors?q=Devndra Jshi',
        headers: { authorization: `Bearer ${patientToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results.length).toBeGreaterThan(0);
      const matched = body.results.find((d: any) => d.id === doctorId);
      expect(matched).toBeDefined();
      expect(matched.fullName).toBe('Devendra Joshi');
      expect(Number(matched.relevanceScore)).toBeGreaterThan(0);
    });

    it('should paginate results using keyset pagination (no OFFSET)', async () => {
      // Page 1: limit = 3
      const page1Res = await app.inject({
        method: 'GET',
        url: '/search/doctors?specialty=Ayurveda&limit=3&sort_by=price_asc',
        headers: { authorization: `Bearer ${patientToken}` },
      });

      expect(page1Res.statusCode).toBe(200);
      const page1 = JSON.parse(page1Res.body);
      expect(page1.results.length).toBe(3);
      expect(page1.next_cursor).toBeDefined();

      // Page 2 using next_cursor
      const page2Res = await app.inject({
        method: 'GET',
        url: `/search/doctors?specialty=Ayurveda&limit=3&sort_by=price_asc&cursor=${encodeURIComponent(page1.next_cursor)}`,
        headers: { authorization: `Bearer ${patientToken}` },
      });

      expect(page2Res.statusCode).toBe(200);
      const page2 = JSON.parse(page2Res.body);
      expect(page2.results.length).toBe(3);

      // Verify zero overlapping IDs between page 1 and page 2
      const page1Ids = page1.results.map((r: any) => r.id);
      const page2Ids = page2.results.map((r: any) => r.id);
      const overlap = page1Ids.filter((id: string) => page2Ids.includes(id));
      expect(overlap.length).toBe(0);
    });

    it('should neutralize SQL-injection attempts in query and filters', async () => {
      // SQL injection in specialty filter
      const sqlInj1 = await app.inject({
        method: 'GET',
        url: "/search/doctors?specialty=Ayurveda' OR '1'='1",
        headers: { authorization: `Bearer ${patientToken}` },
      });
      expect(sqlInj1.statusCode).toBe(200);
      const body1 = JSON.parse(sqlInj1.body);
      // Literal string match -> 0 results
      expect(body1.results.length).toBe(0);

      // SQL injection in text search
      const sqlInj2 = await app.inject({
        method: 'GET',
        url: "/search/doctors?q='; DROP TABLE users; --",
        headers: { authorization: `Bearer ${patientToken}` },
      });
      expect(sqlInj2.statusCode).toBe(200);

      // Verify users table remains completely intact
      const [{ count }] = await dataSource.query('SELECT count(*)::int AS count FROM users;');
      expect(count).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 2: REDIS CACHE-ASIDE, INVALIDATION, STAMPEDE LOCK
  // ──────────────────────────────────────────────────────────────────────────

  describe('2. Redis Cache-Aside, Invalidation & Stampede Protection', () => {
    it('should return cached: false on first query and cached: true on repeat query', async () => {
      const testQuery = 'specialty=Ayurveda&language=Hindi&limit=5';

      // Call 1: Miss
      const res1 = await app.inject({
        method: 'GET',
        url: `/search/doctors?${testQuery}`,
        headers: { authorization: `Bearer ${patientToken}` },
      });
      expect(res1.statusCode).toBe(200);
      const body1 = JSON.parse(res1.body);
      expect(body1.cached).toBe(false);

      // Call 2: Hit
      const res2 = await app.inject({
        method: 'GET',
        url: `/search/doctors?${testQuery}`,
        headers: { authorization: `Bearer ${patientToken}` },
      });
      expect(res2.statusCode).toBe(200);
      const body2 = JSON.parse(res2.body);
      expect(body2.cached).toBe(true);
      expect(body2.results).toEqual(body1.results);
    });

    it('should cache doctor profile and return cached: true on second request', async () => {
      const res1 = await app.inject({
        method: 'GET',
        url: `/doctors/${doctorId}`,
        headers: { authorization: `Bearer ${patientToken}` },
      });
      expect(res1.statusCode).toBe(200);
      const body1 = JSON.parse(res1.body);
      expect(body1.cached).toBe(false);

      const res2 = await app.inject({
        method: 'GET',
        url: `/doctors/${doctorId}`,
        headers: { authorization: `Bearer ${patientToken}` },
      });
      expect(res2.statusCode).toBe(200);
      const body2 = JSON.parse(res2.body);
      expect(body2.cached).toBe(true);
      expect(body2.data.id).toBe(doctorId);
    });

    it('should invalidate cache when doctor updates profile (version counter increment)', async () => {
      // Warm the doctor profile cache
      await app.inject({
        method: 'GET',
        url: `/doctors/${doctorId}`,
        headers: { authorization: `Bearer ${patientToken}` },
      });

      // Doctor updates profile
      const updateRes = await app.inject({
        method: 'PATCH',
        url: '/doctors/me',
        headers: {
          authorization: `Bearer ${doctorToken}`,
          'Idempotency-Key': randomUUID(),
        },
        payload: {
          bio: 'Updated bio: Integrative Ayurvedic medicine and therapeutic rejuvenation.',
          fee_cents: 48000,
        },
      });
      expect(updateRes.statusCode).toBe(200);

      // Next profile query should be a CACHE MISS with new data
      const resAfter = await app.inject({
        method: 'GET',
        url: `/doctors/${doctorId}`,
        headers: { authorization: `Bearer ${patientToken}` },
      });
      expect(resAfter.statusCode).toBe(200);
      const bodyAfter = JSON.parse(resAfter.body);
      expect(bodyAfter.cached).toBe(false);
      expect(bodyAfter.data.feeCents).toBe(48000);
      expect(bodyAfter.data.bio).toContain('Integrative Ayurvedic medicine');
    });

    it('should protect against stampede with single-flight distributed lock', async () => {
      const stampedeQuery = 'specialty=Ayurveda&city=Pune&limit=4&min_price=41000';

      // Fire 10 concurrent requests simultaneously on a cold key
      const requests = Array.from({ length: 10 }, () =>
        app.inject({
          method: 'GET',
          url: `/search/doctors?${stampedeQuery}`,
          headers: { authorization: `Bearer ${patientToken}` },
        }),
      );

      const responses = await Promise.all(requests);

      // All requests must succeed
      for (const res of responses) {
        expect(res.statusCode).toBe(200);
        const b = JSON.parse(res.body);
        expect(b.results).toBeDefined();
      }

      // Exactly 1 request acquired lock and fetched from DB (cached: false)
      // The other 9 waited and got the cached result (cached: true)
      const cachedCount = responses.filter((r) => JSON.parse(r.body).cached === true).length;
      expect(cachedCount).toBeGreaterThanOrEqual(9);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 3: ADMIN ANALYTICS
  // ──────────────────────────────────────────────────────────────────────────

  describe('3. Admin Analytics', () => {
    const today = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    it('should reject non-admin users with 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/analytics/consultations?date_from=${thirtyDaysAgo}&date_to=${today}`,
        headers: { authorization: `Bearer ${patientToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should return consultations per day, rates, and revenue for admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/analytics/consultations?date_from=${thirtyDaysAgo}&date_to=${today}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.summary).toBeDefined();
      expect(body.summary.totalConsultations).toBeGreaterThan(0);
      expect(body.summary.completedConsultations).toBeGreaterThan(0);
      expect(body.summary.revenueCents).toBeGreaterThan(0);
      expect(body.summary.cancellationRate).toBeGreaterThanOrEqual(0);
      expect(body.summary.noShowRate).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(body.timeSeries)).toBe(true);
      expect(body.timeSeries.length).toBeGreaterThan(0);
    });

    it('should enforce maximum 90-day date range constraint', async () => {
      // 120 days requested
      const res = await app.inject({
        method: 'GET',
        url: '/admin/analytics/consultations?date_from=2026-01-01&date_to=2026-05-15',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(400);
      const err = JSON.parse(res.body);
      expect(err.detail || err.message).toContain('exceeds maximum allowed limit of 90 days');
    });

    it('should return doctor utilization and productivity metrics with pagination', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/analytics/doctors?date_from=${thirtyDaysAgo}&date_to=${today}&limit=10`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.doctors).toBeDefined();
      expect(body.doctors.length).toBeGreaterThan(0);
      expect(body.doctors[0].doctorId).toBeDefined();
      expect(body.doctors[0].doctorName).toBeDefined();
      expect(body.doctors[0].completedConsultations).toBeGreaterThan(0);
      expect(body.doctors[0].utilizationRate).toBeDefined();
    });

    it('should allow admin to refresh the analytics materialized view concurrently', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/analytics/refresh',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': randomUUID(),
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('success');
      expect(body.refreshedAt).toBeDefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 4: AUDIT MODULE, HASH CHAIN & TAMPER DETECTION
  // ──────────────────────────────────────────────────────────────────────────

  describe('4. Audit Module, Hash Chain & Tamper Detection', () => {
    const currentMonth = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    )
      .toISOString()
      .slice(0, 10);

    it('should write append-only audit rows and verify unbroken hash chain', async () => {
      // Write 2 audit logs
      await auditService.log({
        actorId: doctorUserId,
        action: 'TEST_ACTION_1',
        resourceType: 'doctor',
        resourceId: doctorId,
        ipAddress: '127.0.0.1',
        requestId: randomUUID(),
      });

      await auditService.log({
        actorId: doctorUserId,
        action: 'TEST_ACTION_2',
        resourceType: 'consultation',
        resourceId: randomUUID(),
        ipAddress: '127.0.0.1',
        requestId: randomUUID(),
      });

      const verifyRes = await auditService.verifyPartitionChain(currentMonth);
      expect(verifyRes.valid).toBe(true);
      expect(verifyRes.totalRows).toBeGreaterThanOrEqual(2);
    });

    it('should query audit logs via admin endpoint with filters', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/audit-logs?action=TEST_ACTION_1&limit=5`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.logs).toBeDefined();
      expect(body.logs.length).toBeGreaterThan(0);
      expect(body.logs[0].action).toBe('TEST_ACTION_1');
    });

    it('should detect tampering when an audit row is modified in the database', async () => {
      // Find the last row in current partition
      const rows = await dataSource.query(
        `SELECT id, action FROM audit_logs WHERE partition_month = $1 ORDER BY created_at DESC, id DESC LIMIT 1;`,
        [currentMonth],
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const targetRow = rows[0];
      const originalAction = targetRow.action;

      // Tamper with row by mutating action directly
      await dataSource.query(
        `UPDATE audit_logs SET action = 'TAMPERED_MALICIOUS_ACTION' WHERE id = $1;`,
        [targetRow.id],
      );

      // Run cryptographic verification
      const verifyTampered = await auditService.verifyPartitionChain(currentMonth);
      expect(verifyTampered.valid).toBe(false);
      expect(verifyTampered.brokenRowId).toBe(targetRow.id);
      expect(verifyTampered.error).toContain('Hash mismatch');

      // Revert tamper back to original state
      await dataSource.query(`UPDATE audit_logs SET action = $1 WHERE id = $2;`, [
        originalAction,
        targetRow.id,
      ]);

      // Verify chain is restored
      const verifyRestored = await auditService.verifyPartitionChain(currentMonth);
      expect(verifyRestored.valid).toBe(true);
    });

    it('should deny UPDATE and DELETE on audit_logs from the restricted app role', async () => {
      // Connect as amrutam_app (restricted role)
      const appRoleDataSource = new DataSource({
        type: 'postgres',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        username: 'amrutam_app',
        password: 'amrutam_app_pw',
        database: process.env.DB_NAME || 'amrutam',
      });

      await appRoleDataSource.initialize();

      try {
        // 1. SELECT should be granted
        const selectResult = await appRoleDataSource.query(
          `SELECT id FROM audit_logs WHERE partition_month = $1 LIMIT 1;`,
          [currentMonth],
        );
        expect(Array.isArray(selectResult)).toBe(true);

        // 2. UPDATE should be strictly DENIED with SQLSTATE 42501 (permission denied)
        let updateError: any = null;
        try {
          await appRoleDataSource.query(
            `UPDATE audit_logs SET action = 'ILLEGAL_UPDATE' WHERE partition_month = $1;`,
            [currentMonth],
          );
        } catch (err) {
          updateError = err;
        }
        expect(updateError).toBeDefined();
        expect(updateError.code).toBe('42501'); // 42501 = insufficient_privilege

        // 3. DELETE should be strictly DENIED with SQLSTATE 42501 (permission denied)
        let deleteError: any = null;
        try {
          await appRoleDataSource.query(`DELETE FROM audit_logs WHERE partition_month = $1;`, [
            currentMonth,
          ]);
        } catch (err) {
          deleteError = err;
        }
        expect(deleteError).toBeDefined();
        expect(deleteError.code).toBe('42501'); // 42501 = insufficient_privilege
      } finally {
        await appRoleDataSource.destroy();
      }
    });
  });
});
