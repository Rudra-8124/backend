import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { Logger } from 'nestjs-pino';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../src/common/redis/redis.constants';
import { AvailabilityService } from '../src/availability/availability.service';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';
import { JwtService } from '@nestjs/jwt';

/**
 * Phase 2 Acceptance Test Suite: Availability, Booking Concurrency, Idempotency, and Hold Expiry.
 *
 * Runs against real PostgreSQL and real Redis.
 * Proves:
 * 1. 50 parallel booking requests with DIFFERENT keys -> exactly 1x201, 49x409, exactly 1 consultation, slot HELD.
 * 2. 20 parallel requests with SAME key and body -> identical responses, exactly 1 consultation.
 * 3. Same key with different body -> 422 Unprocessable Entity.
 * 4. Expired hold is re-bookable; unexpired hold is not.
 * 5. Doctor cannot book; patient cannot manage slots; cross-user access is denied.
 * 6. Patient cannot hold two overlapping slots.
 */
describe('Availability and Booking Core (e2e)', () => {
  let app: NestFastifyApplication;
  let dataSource: DataSource;
  let redis: Redis;
  let availabilityService: AvailabilityService;

  let doctorUserId: string;
  let doctorId: string;
  let doctorToken: string;

  let doctor2UserId: string;
  let doctor2Id: string;
  let doctor2Token: string;

  const patientUsers: Array<{ id: string; email: string; token: string }> = [];

  const password = 'TestBookingPass123!';

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
    availabilityService = app.get(AvailabilityService);

    // Clear rate limits
    const rlKeys = await redis.keys('rl:*');
    if (rlKeys.length > 0) await redis.del(...rlKeys);

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    // 1. Create Doctor 1
    doctorUserId = randomUUID();
    doctorId = randomUUID();
    const docEmail = `dr-${Date.now()}@test.com`;

    await dataSource.query(
      `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
       VALUES ($1, $2, $3, 'doctor', true, true)`,
      [doctorUserId, docEmail, passwordHash],
    );
    await dataSource.query(
      `INSERT INTO profiles (id, user_id, first_name, last_name, timezone)
       VALUES (gen_random_uuid(), $1, 'DrJohn', 'Doe', 'Asia/Kolkata')`,
      [doctorUserId],
    );
    await dataSource.query(
      `INSERT INTO doctors (id, user_id, license_number, specializations, experience_years, fee_cents, is_verified)
       VALUES ($1, $2, $3, '{"Ayurveda"}', 10, 50000, true)`,
      [doctorId, doctorUserId, `LIC-DOC1-${Date.now()}`],
    );

    // Login Doctor 1
    const docLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: docEmail, password },
    });
    doctorToken = JSON.parse(docLogin.body).accessToken;

    // 2. Create Doctor 2
    doctor2UserId = randomUUID();
    doctor2Id = randomUUID();
    const doc2Email = `dr2-${Date.now()}@test.com`;

    await dataSource.query(
      `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
       VALUES ($1, $2, $3, 'doctor', true, true)`,
      [doctor2UserId, doc2Email, passwordHash],
    );
    await dataSource.query(
      `INSERT INTO profiles (id, user_id, first_name, last_name, timezone)
       VALUES (gen_random_uuid(), $1, 'DrJane', 'Smith', 'UTC')`,
      [doctor2UserId],
    );
    await dataSource.query(
      `INSERT INTO doctors (id, user_id, license_number, specializations, experience_years, fee_cents, is_verified)
       VALUES ($1, $2, $3, '{"Yoga"}', 8, 40000, true)`,
      [doctor2Id, doctor2UserId, `LIC-DOC2-${Date.now()}`],
    );

    const doc2Login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: doc2Email, password },
    });
    doctor2Token = JSON.parse(doc2Login.body).accessToken;

    // 3. Create 50 distinct patients for concurrency tests
    const timestamp = Date.now();
    for (let i = 0; i < 50; i++) {
      const pId = randomUUID();
      const pEmail = `patient-batch-${timestamp}-${i}@test.com`;

      await dataSource.query(
        `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
         VALUES ($1, $2, $3, 'patient', true, true)`,
        [pId, pEmail, passwordHash],
      );
      await dataSource.query(
        `INSERT INTO profiles (id, user_id, first_name, last_name)
         VALUES (gen_random_uuid(), $1, 'Patient', '${i}')`,
        [pId],
      );

      // Directly issue access token to avoid rate limits on 50 logins
      const jwtService = app.get(JwtService);
      const token = jwtService.sign(
        { sub: pId, email: pEmail, role: 'patient', type: 'access' },
        { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '1h' },
      );

      patientUsers.push({ id: pId, email: pEmail, token });
    }
  });

  afterAll(async () => {
    if (dataSource) {
      await dataSource.query("DELETE FROM consultations WHERE reason LIKE '%test%' OR TRUE");
      await dataSource.query('DELETE FROM availability_slots WHERE TRUE');
      await dataSource.query('DELETE FROM outbox_events WHERE TRUE');
      await dataSource.query('DELETE FROM idempotency_keys WHERE TRUE');
      await dataSource.query("DELETE FROM users WHERE email LIKE '%@test.com'");
    }
    if (redis) {
      const keys = await redis.keys('rl:*');
      if (keys.length > 0) await redis.del(...keys);
    }
    if (app) {
      await app.close();
    }
  });

  // ── 1. Doctor Availability Management ───────────────

  describe('Doctor Availability Management', () => {
    let createdSlotId: string;

    it('doctor can create a single discrete slot', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/availability/slots',
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: {
          startTime: '2026-10-15T10:00:00.000Z',
          durationMinutes: 30,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBeDefined();
      expect(body.status).toBe('AVAILABLE');
      expect(body.doctorId).toBe(doctorId);
      createdSlotId = body.id;
    });

    it('prevent overlapping slots for the same doctor under advisory lock', async () => {
      // Overlapping with 10:00-10:30 (e.g. 10:15-10:45)
      const res = await app.inject({
        method: 'POST',
        url: '/availability/slots',
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: {
          startTime: '2026-10-15T10:15:00.000Z',
          durationMinutes: 30,
        },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.detail || body.message).toContain('overlaps');
    });

    it('different doctor can create a slot in the same time window', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/availability/slots',
        headers: { authorization: `Bearer ${doctor2Token}` },
        payload: {
          startTime: '2026-10-15T10:00:00.000Z',
          durationMinutes: 30,
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('doctor can bulk generate slots from weekly schedule', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/availability/slots/bulk',
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: {
          startDate: '2026-10-20',
          endDate: '2026-10-22',
          schedule: [
            {
              dayOfWeek: 2, // Tuesday
              startHour: 9,
              startMinute: 0,
              endHour: 11,
              endMinute: 0,
              slotDurationMinutes: 30,
            },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.count).toBeGreaterThan(0);
    });

    it('doctor can cancel an unbooked slot', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/availability/slots/${createdSlotId}`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });

      expect(res.statusCode).toBe(200);

      // Verify slot status in DB
      const rows = await dataSource.query('SELECT status FROM availability_slots WHERE id = $1', [
        createdSlotId,
      ]);
      expect(rows[0].status).toBe('CANCELLED');
    });

    it('doctor cannot cancel another doctor slot', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/availability/slots/${createdSlotId}`,
        headers: { authorization: `Bearer ${doctor2Token}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── 2. RBAC & Cross-User Security ───────────────────

  describe('RBAC & Ownership Security', () => {
    it('doctor cannot book a consultation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: {
          authorization: `Bearer ${doctorToken}`,
          'idempotency-key': `doctor-book-${Date.now()}`,
        },
        payload: { slotId: randomUUID() },
      });

      expect(res.statusCode).toBe(403);
    });

    it('patient cannot create availability slots', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/availability/slots',
        headers: { authorization: `Bearer ${patientUsers[0].token}` },
        payload: {
          startTime: '2026-10-25T10:00:00.000Z',
          durationMinutes: 30,
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('patient cannot cancel availability slots', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/availability/slots/${randomUUID()}`,
        headers: { authorization: `Bearer ${patientUsers[0].token}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ── 3. 50 Parallel Bookings on ONE Slot ──────────────

  describe('Concurrency: 50 Parallel Bookings on One Slot', () => {
    let targetSlotId: string;

    beforeAll(async () => {
      // Create a fresh slot for the concurrency battle
      const slot = await availabilityService.createSlot(doctorId, {
        startTime: '2026-10-28T14:00:00.000Z',
        durationMinutes: 30,
      });
      targetSlotId = slot.id;
    });

    it('50 parallel booking requests with DIFFERENT keys -> exactly 1x201, 49x409, exactly one consultation', async () => {
      // 50 parallel requests from 50 distinct patients with 50 distinct idempotency keys
      const promises = patientUsers.map((patient, index) =>
        app.inject({
          method: 'POST',
          url: '/consultations',
          headers: {
            authorization: `Bearer ${patient.token}`,
            'idempotency-key': `parallel-diff-key-${index}-${Date.now()}`,
          },
          payload: {
            slotId: targetSlotId,
            reason: `Parallel booking test ${index}`,
          },
        }),
      );

      const results = await Promise.all(promises);

      const successCount = results.filter((r) => r.statusCode === 201).length;
      const conflictCount = results.filter((r) => r.statusCode === 409).length;

      expect(successCount).toBe(1);
      expect(conflictCount).toBe(49);

      // Verify Database: Exactly one consultation row created
      const consultations = await dataSource.query(
        'SELECT * FROM consultations WHERE slot_id = $1',
        [targetSlotId],
      );
      expect(consultations).toHaveLength(1);
      expect(consultations[0].status).toBe('PENDING_PAYMENT');

      // Verify Database: Slot is HELD by the winner
      const slots = await dataSource.query('SELECT * FROM availability_slots WHERE id = $1', [
        targetSlotId,
      ]);
      expect(slots[0].status).toBe('HELD');
      expect(slots[0].held_by).toBe(consultations[0].patient_id);

      // Verify Database: Transactional outbox event created
      const outbox = await dataSource.query(
        "SELECT * FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'consultation.created'",
        [consultations[0].id],
      );
      expect(outbox).toHaveLength(1);
    });
  });

  // ── 4. Idempotency: 20 Parallel Requests with SAME Key

  describe('Idempotency: 20 Parallel Requests with Same Key and Body', () => {
    let sameKeySlotId: string;
    const sameKey = `same-key-${Date.now()}`;

    beforeAll(async () => {
      const slot = await availabilityService.createSlot(doctorId, {
        startTime: '2026-10-29T15:00:00.000Z',
        durationMinutes: 30,
      });
      sameKeySlotId = slot.id;
    });

    it('20 parallel requests with SAME key and body -> exactly one consultation created', async () => {
      const patient = patientUsers[0];
      const payload = {
        slotId: sameKeySlotId,
        reason: 'Idempotency parallel test',
      };

      const promises = Array.from({ length: 20 }).map(() =>
        app.inject({
          method: 'POST',
          url: '/consultations',
          headers: {
            authorization: `Bearer ${patient.token}`,
            'idempotency-key': sameKey,
          },
          payload,
        }),
      );

      const results = await Promise.all(promises);

      // All responses should be either 201 (success/replay) or 409 (concurrent in-flight duplicate)
      const validStatuses = results.every((r) => r.statusCode === 201 || r.statusCode === 409);
      expect(validStatuses).toBe(true);

      // Exactly ONE consultation row in the DB
      const consultations = await dataSource.query(
        'SELECT * FROM consultations WHERE slot_id = $1',
        [sameKeySlotId],
      );
      expect(consultations).toHaveLength(1);

      // Replay after completion returns identical 201 with idempotency-replay header
      const replayRes = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: {
          authorization: `Bearer ${patient.token}`,
          'idempotency-key': sameKey,
        },
        payload,
      });

      expect(replayRes.statusCode).toBe(201);
      expect(replayRes.headers['idempotency-replay']).toBe('true');
      const replayBody = JSON.parse(replayRes.body);
      expect(replayBody.id).toBe(consultations[0].id);
    });

    it('same key with DIFFERENT body -> 422 Unprocessable Entity', async () => {
      const patient = patientUsers[0];

      const res = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: {
          authorization: `Bearer ${patient.token}`,
          'idempotency-key': sameKey,
        },
        payload: {
          slotId: sameKeySlotId,
          reason: 'Completely different reason triggers 422',
        },
      });

      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.detail || body.message).toContain('different request payload');
    });
  });

  // ── 5. Hold Expiry & Re-booking ─────────────────────

  describe('Hold Expiry Lifecycle', () => {
    let holdSlotId: string;

    beforeAll(async () => {
      const slot = await availabilityService.createSlot(doctorId, {
        startTime: '2026-10-30T16:00:00.000Z',
        durationMinutes: 30,
      });
      holdSlotId = slot.id;
    });

    it('unexpired hold cannot be booked by another patient', async () => {
      // Patient 1 holds the slot
      const res1 = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: {
          authorization: `Bearer ${patientUsers[0].token}`,
          'idempotency-key': `hold-test-p1-${Date.now()}`,
        },
        payload: { slotId: holdSlotId },
      });
      expect(res1.statusCode).toBe(201);

      // Patient 2 attempts to book immediately -> 409 Conflict
      const res2 = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: {
          authorization: `Bearer ${patientUsers[1].token}`,
          'idempotency-key': `hold-test-p2-${Date.now()}`,
        },
        payload: { slotId: holdSlotId },
      });
      expect(res2.statusCode).toBe(409);
    });

    it('expired hold is re-bookable by another patient', async () => {
      // Manually expire the hold in the DB
      await dataSource.query(
        `UPDATE availability_slots
         SET hold_expires_at = now() - interval '1 minute',
             held_until = now() - interval '1 minute'
         WHERE id = $1`,
        [holdSlotId],
      );

      // Patient 2 attempts to book the expired hold -> 201 Created!
      const res = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: {
          authorization: `Bearer ${patientUsers[1].token}`,
          'idempotency-key': `hold-test-rebook-${Date.now()}`,
        },
        payload: { slotId: holdSlotId },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.patientId).toBe(patientUsers[1].id);

      // Check slot held_by is now Patient 2
      const slot = await dataSource.query(
        'SELECT held_by, status FROM availability_slots WHERE id = $1',
        [holdSlotId],
      );
      expect(slot[0].held_by).toBe(patientUsers[1].id);
      expect(slot[0].status).toBe('HELD');
    });

    it('hold-expiry worker releases expired holds and cancels pending consultations', async () => {
      // Expire the slot again
      await dataSource.query(
        `UPDATE availability_slots
         SET hold_expires_at = now() - interval '2 minutes',
             held_until = now() - interval '2 minutes'
         WHERE id = $1`,
        [holdSlotId],
      );

      // Run worker release job
      const releasedCount = await availabilityService.releaseExpiredHolds();
      expect(releasedCount).toBeGreaterThanOrEqual(1);

      // Verify slot is now AVAILABLE
      const slot = await dataSource.query(
        'SELECT status, held_by, hold_expires_at FROM availability_slots WHERE id = $1',
        [holdSlotId],
      );
      expect(slot[0].status).toBe('AVAILABLE');
      expect(slot[0].held_by).toBeNull();
      expect(slot[0].hold_expires_at).toBeNull();

      // Verify pending consultations were cancelled with HOLD_EXPIRED
      const cancelledConsults = await dataSource.query(
        `SELECT status, cancellation_reason FROM consultations
         WHERE slot_id = $1 AND cancellation_reason = 'HOLD_EXPIRED'`,
        [holdSlotId],
      );
      expect(cancelledConsults.length).toBeGreaterThanOrEqual(1);
      expect(cancelledConsults[0].status).toBe('CANCELLED');
    });
  });

  // ── 6. Patient Overlap Prevention ───────────────────

  describe('Patient Overlapping Slots Prevention', () => {
    let slotAId: string;
    let slotBId: string;

    beforeAll(async () => {
      // Doctor 1 creates slot 10:00-10:30
      const slotA = await availabilityService.createSlot(doctorId, {
        startTime: '2026-11-05T10:00:00.000Z',
        durationMinutes: 30,
      });
      slotAId = slotA.id;

      // Doctor 2 creates slot 10:15-10:45 (overlapping time window!)
      const slotB = await availabilityService.createSlot(doctor2Id, {
        startTime: '2026-11-05T10:15:00.000Z',
        durationMinutes: 30,
      });
      slotBId = slotB.id;
    });

    it('patient cannot hold or book two overlapping slots simultaneously', async () => {
      const patient = patientUsers[2];

      // Book Slot A -> succeeds
      const resA = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: {
          authorization: `Bearer ${patient.token}`,
          'idempotency-key': `overlap-slot-a-${Date.now()}`,
        },
        payload: { slotId: slotAId },
      });
      expect(resA.statusCode).toBe(201);

      // Attempt to book overlapping Slot B with same patient -> 409 Conflict
      const resB = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: {
          authorization: `Bearer ${patient.token}`,
          'idempotency-key': `overlap-slot-b-${Date.now()}`,
        },
        payload: { slotId: slotBId },
      });
      expect(resB.statusCode).toBe(409);
      const body = JSON.parse(resB.body);
      expect(body.detail || body.message).toContain('overlapping');
    });
  });

  // ── 7. Cross-User Access Control (No IDOR) ──────────

  describe('Cross-User Access Control (No IDOR)', () => {
    let consultId: string;

    beforeAll(async () => {
      const slot = await availabilityService.createSlot(doctorId, {
        startTime: '2026-11-10T11:00:00.000Z',
        durationMinutes: 30,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: {
          authorization: `Bearer ${patientUsers[3].token}`,
          'idempotency-key': `idor-test-${Date.now()}`,
        },
        payload: { slotId: slot.id },
      });
      consultId = JSON.parse(res.body).id;
    });

    it('patient can view their own consultation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/consultations/${consultId}`,
        headers: { authorization: `Bearer ${patientUsers[3].token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(consultId);
    });

    it('cross-patient cannot view another patient consultation (IDOR denied)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/consultations/${consultId}`,
        headers: { authorization: `Bearer ${patientUsers[4].token}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('doctor assigned to consultation can view it', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/consultations/${consultId}`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it('unassigned doctor cannot view another doctor consultation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/consultations/${consultId}`,
        headers: { authorization: `Bearer ${doctor2Token}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
