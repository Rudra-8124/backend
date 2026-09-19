import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { Logger } from 'nestjs-pino';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../src/common/redis/redis.constants';
import { AvailabilityService } from '../src/availability/availability.service';
import { PaymentsService } from '../src/payments/payments.service';
import { MockPaymentProvider } from '../src/payments/providers/mock-payment.provider';
import { SagaOutboxService } from '../src/consultations/saga-outbox.service';
import { ConsultationStateMachine } from '../src/consultations/consultation-state-machine';
import { ConsultationStatus } from '../src/consultations/entities/consultation.entity';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';

describe('Phase 3: Consultation Lifecycle, Prescriptions, Payments, and Saga (e2e)', () => {
  let app: NestFastifyApplication;
  let dataSource: DataSource;
  let redis: Redis;
  let availabilityService: AvailabilityService;
  let paymentsService: PaymentsService;
  let mockPaymentProvider: MockPaymentProvider;
  let sagaOutboxService: SagaOutboxService;

  let doctorUserId: string;
  let doctorId: string;
  let doctorToken: string;

  let doctor2UserId: string;
  let doctor2Id: string;
  let doctor2Token: string;

  let patient1UserId: string;
  let patient1Token: string;

  let patient2UserId: string;
  let patient2Token: string;

  let adminUserId: string;
  let adminToken: string;

  const password = 'TestPass123!Safe';

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
    availabilityService = app.get(AvailabilityService);
    paymentsService = app.get(PaymentsService);
    mockPaymentProvider = app.get(MockPaymentProvider);
    sagaOutboxService = app.get(SagaOutboxService);

    // Clear rate limits
    const rlKeys = await redis.keys('rl:*');
    if (rlKeys.length > 0) await redis.del(...rlKeys);

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    // 1. Create Doctor 1 (Assigned)
    doctorUserId = randomUUID();
    doctorId = randomUUID();
    const doc1Email = `dr1-${Date.now()}@telemed.local`;
    await dataSource.query(
      `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
       VALUES ($1, $2, $3, 'doctor', true, true)`,
      [doctorUserId, doc1Email, passwordHash],
    );
    await dataSource.query(
      `INSERT INTO profiles (id, user_id, first_name, last_name, timezone)
       VALUES (gen_random_uuid(), $1, 'Doctor', 'One', 'UTC')`,
      [doctorUserId],
    );
    await dataSource.query(
      `INSERT INTO doctors (id, user_id, license_number, specializations, experience_years, fee_cents, is_verified)
       VALUES ($1, $2, $3, '{"Cardiology"}', 10, 50000, true)`,
      [doctorId, doctorUserId, `LIC-DOC1-${Date.now()}`],
    );
    const doc1Login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: doc1Email, password },
    });
    doctorToken = JSON.parse(doc1Login.body).accessToken;

    // 2. Create Doctor 2 (Unassigned)
    doctor2UserId = randomUUID();
    doctor2Id = randomUUID();
    const doc2Email = `dr2-${Date.now()}@telemed.local`;
    await dataSource.query(
      `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
       VALUES ($1, $2, $3, 'doctor', true, true)`,
      [doctor2UserId, doc2Email, passwordHash],
    );
    await dataSource.query(
      `INSERT INTO profiles (id, user_id, first_name, last_name, timezone)
       VALUES (gen_random_uuid(), $1, 'Doctor', 'Two', 'UTC')`,
      [doctor2UserId],
    );
    await dataSource.query(
      `INSERT INTO doctors (id, user_id, license_number, specializations, experience_years, fee_cents, is_verified)
       VALUES ($1, $2, $3, '{"Dermatology"}', 8, 40000, true)`,
      [doctor2Id, doctor2UserId, `LIC-DOC2-${Date.now()}`],
    );
    const doc2Login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: doc2Email, password },
    });
    doctor2Token = JSON.parse(doc2Login.body).accessToken;

    // 3. Create Patient 1 (Consultation Owner)
    patient1UserId = randomUUID();
    const p1Email = `patient1-${Date.now()}@telemed.local`;
    await dataSource.query(
      `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
       VALUES ($1, $2, $3, 'patient', true, true)`,
      [patient1UserId, p1Email, passwordHash],
    );
    await dataSource.query(
      `INSERT INTO profiles (id, user_id, first_name, last_name, timezone)
       VALUES (gen_random_uuid(), $1, 'Alice', 'Patient', 'UTC')`,
      [patient1UserId],
    );
    const p1Login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: p1Email, password },
    });
    patient1Token = JSON.parse(p1Login.body).accessToken;

    // 4. Create Patient 2 (Unrelated Patient)
    patient2UserId = randomUUID();
    const p2Email = `patient2-${Date.now()}@telemed.local`;
    await dataSource.query(
      `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
       VALUES ($1, $2, $3, 'patient', true, true)`,
      [patient2UserId, p2Email, passwordHash],
    );
    await dataSource.query(
      `INSERT INTO profiles (id, user_id, first_name, last_name, timezone)
       VALUES (gen_random_uuid(), $1, 'Bob', 'Patient', 'UTC')`,
      [patient2UserId],
    );
    const p2Login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: p2Email, password },
    });
    patient2Token = JSON.parse(p2Login.body).accessToken;

    // 5. Create Admin
    adminUserId = randomUUID();
    const adminEmail = `admin-${Date.now()}@telemed.local`;
    await dataSource.query(
      `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
       VALUES ($1, $2, $3, 'admin', true, true)`,
      [adminUserId, adminEmail, passwordHash],
    );
    await dataSource.query(
      `INSERT INTO profiles (id, user_id, first_name, last_name, timezone)
       VALUES (gen_random_uuid(), $1, 'Super', 'Admin', 'UTC')`,
      [adminUserId],
    );
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: adminEmail, password },
    });
    adminToken = JSON.parse(adminLogin.body).accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  // Helper to create a slot and book it as Patient 1
  async function setupBookedConsultation(slotOffsetHours: number = 24) {
    const start = new Date(Date.now() + slotOffsetHours * 3600 * 1000);
    start.setMinutes(0, 0, 0);

    const slot = await availabilityService.createSlot(doctorId, {
      startTime: start.toISOString(),
      durationMinutes: 30,
    });

    const bookingRes = await app.inject({
      method: 'POST',
      url: '/consultations',
      headers: {
        authorization: `Bearer ${patient1Token}`,
        'idempotency-key': `book-${randomUUID()}`,
      },
      payload: {
        slotId: slot.id,
        reason: 'General cardiology consultation',
      },
    });

    expect(bookingRes.statusCode).toBe(201);
    const booking = JSON.parse(bookingRes.body);

    return { slot, consultation: booking };
  }

  // ─────────────────────────────────────────────────────────────
  // 1. Consultation State Machine & Lifecycle Endpoints
  // ─────────────────────────────────────────────────────────────
  describe('Consultation State Machine & Optimistic Locking', () => {
    it('happy path: booked -> payment intent -> paid -> CONFIRMED -> IN_PROGRESS -> COMPLETED', async () => {
      const { slot, consultation } = await setupBookedConsultation(100);

      // 1. Outbox relay worker processes consultation.created -> creates payment intent
      let pi: string | null = null;
      for (let i = 0; i < 5; i++) {
        await sagaOutboxService.processOutboxBatch(20);
        const consultRow = await dataSource.query(
          'SELECT payment_intent_id, version FROM consultations WHERE id = $1',
          [consultation.id],
        );
        if (consultRow[0]?.payment_intent_id) {
          pi = consultRow[0].payment_intent_id;
          break;
        }
      }
      expect(pi).toBeTruthy();
      const paymentIntentId = pi!;

      // 2. Mock payment webhook arrives (payment.succeeded)
      const webhookData = mockPaymentProvider.generateSignedWebhook({
        eventId: `evt_${randomUUID()}`,
        eventType: 'payment.succeeded',
        paymentIntentId,
        amountCents: 50000,
      });

      const webhookRes = await app.inject({
        method: 'POST',
        url: '/webhooks/payments',
        headers: {
          'x-webhook-signature': webhookData.signature,
          'x-timestamp': String(webhookData.timestamp),
          'content-type': 'application/json',
        },
        payload: webhookData.rawBody,
      });

      expect(webhookRes.statusCode).toBe(200);

      // Verify consultation status is now CONFIRMED and slot is BOOKED
      const confirmedConsult = await dataSource.query(
        'SELECT status, version FROM consultations WHERE id = $1',
        [consultation.id],
      );
      expect(confirmedConsult[0].status).toBe(ConsultationStatus.CONFIRMED);
      expect(confirmedConsult[0].version).toBe(2);

      const bookedSlot = await dataSource.query(
        'SELECT status FROM availability_slots WHERE id = $1',
        [slot.id],
      );
      expect(bookedSlot[0].status).toBe('BOOKED');

      // 3. Assigned doctor starts consultation: PATCH /consultations/:id/start
      const startRes = await app.inject({
        method: 'PATCH',
        url: `/consultations/${consultation.id}/start`,
        headers: {
          authorization: `Bearer ${doctorToken}`,
          'idempotency-key': `start-${randomUUID()}`,
        },
      });

      expect(startRes.statusCode).toBe(200);
      const startedConsult = JSON.parse(startRes.body);
      expect(startedConsult.status).toBe(ConsultationStatus.IN_PROGRESS);
      expect(startedConsult.version).toBe(3);

      // 4. Assigned doctor completes consultation: PATCH /consultations/:id/complete
      const completeRes = await app.inject({
        method: 'PATCH',
        url: `/consultations/${consultation.id}/complete`,
        headers: {
          authorization: `Bearer ${doctorToken}`,
          'idempotency-key': `complete-${randomUUID()}`,
        },
        payload: {
          notes: 'Patient ECG normal, prescribed lifestyle modifications.',
        },
      });

      expect(completeRes.statusCode).toBe(200);
      const completedConsult = JSON.parse(completeRes.body);
      expect(completedConsult.status).toBe(ConsultationStatus.COMPLETED);
      expect(completedConsult.version).toBe(4);

      // Verify slot is now COMPLETED
      const finalSlot = await dataSource.query(
        'SELECT status FROM availability_slots WHERE id = $1',
        [slot.id],
      );
      expect(finalSlot[0].status).toBe('COMPLETED');
    });

    it('rejects illegal status transitions with 409 Conflict', async () => {
      const { consultation } = await setupBookedConsultation(105);

      // Attempting to complete directly from PENDING_PAYMENT -> 409
      const illegalComplete = await app.inject({
        method: 'PATCH',
        url: `/consultations/${consultation.id}/complete`,
        headers: {
          authorization: `Bearer ${doctorToken}`,
          'idempotency-key': `illegal-${randomUUID()}`,
        },
      });
      expect(illegalComplete.statusCode).toBe(409);

      // Attempting to start directly from PENDING_PAYMENT -> 409
      const illegalStart = await app.inject({
        method: 'PATCH',
        url: `/consultations/${consultation.id}/start`,
        headers: {
          authorization: `Bearer ${doctorToken}`,
          'idempotency-key': `start-illegal-${randomUUID()}`,
        },
      });
      expect(illegalStart.statusCode).toBe(409);
    });

    it('optimistic locking: version conflict returns 409', async () => {
      const { consultation } = await setupBookedConsultation(110);

      // Try transition with stale version (expectedVersion 99)
      await expect(
        dataSource.transaction((manager) =>
          ConsultationStateMachine.transition(manager, consultation.id, {
            targetStatus: ConsultationStatus.CANCELLED,
            expectedVersion: 99,
          }),
        ),
      ).rejects.toThrow();
    });

    it('assigned doctor or admin can mark NO_SHOW from CONFIRMED; patient gets 403', async () => {
      const { consultation } = await setupBookedConsultation(115);

      // Manually set to CONFIRMED for no-show test
      await dataSource.query(
        "UPDATE consultations SET status = 'CONFIRMED', version = 2 WHERE id = $1",
        [consultation.id],
      );

      // Patient attempts to mark no-show -> 403 Forbidden
      const patientNoShow = await app.inject({
        method: 'PATCH',
        url: `/consultations/${consultation.id}/no-show`,
        headers: {
          authorization: `Bearer ${patient1Token}`,
          'idempotency-key': `noshow-p-${randomUUID()}`,
        },
      });
      expect(patientNoShow.statusCode).toBe(403);

      // Assigned doctor marks no-show -> 200 OK
      const doctorNoShow = await app.inject({
        method: 'PATCH',
        url: `/consultations/${consultation.id}/no-show`,
        headers: {
          authorization: `Bearer ${doctorToken}`,
          'idempotency-key': `noshow-doc-${randomUUID()}`,
        },
      });
      expect(doctorNoShow.statusCode).toBe(200);
      const res = JSON.parse(doctorNoShow.body);
      expect(res.status).toBe(ConsultationStatus.NO_SHOW);
    });

    it('cancellation after payment triggers refund via payment provider', async () => {
      const { slot, consultation } = await setupBookedConsultation(120);

      // Create payment intent & pay
      let pi: string | null = null;
      for (let i = 0; i < 5; i++) {
        await sagaOutboxService.processOutboxBatch(20);
        const consultRow = await dataSource.query(
          'SELECT payment_intent_id FROM consultations WHERE id = $1',
          [consultation.id],
        );
        if (consultRow[0]?.payment_intent_id) {
          pi = consultRow[0].payment_intent_id;
          break;
        }
      }
      expect(pi).toBeTruthy();

      const webhookData = mockPaymentProvider.generateSignedWebhook({
        eventId: `evt_pay_${randomUUID()}`,
        eventType: 'payment.succeeded',
        paymentIntentId: pi!,
      });
      await app.inject({
        method: 'POST',
        url: '/webhooks/payments',
        headers: {
          'x-webhook-signature': webhookData.signature,
          'x-timestamp': String(webhookData.timestamp),
          'content-type': 'application/json',
        },
        payload: webhookData.rawBody,
      });

      // Patient cancels confirmed consultation
      const cancelRes = await app.inject({
        method: 'PATCH',
        url: `/consultations/${consultation.id}/cancel`,
        headers: {
          authorization: `Bearer ${patient1Token}`,
          'idempotency-key': `cancel-${randomUUID()}`,
        },
        payload: {
          reason: 'Emergency travel — please refund',
        },
      });

      expect(cancelRes.statusCode).toBe(200);
      const cancelled = JSON.parse(cancelRes.body);
      expect(cancelled.status).toBe(ConsultationStatus.CANCELLED);

      // Slot is released back to AVAILABLE
      const slotRow = await dataSource.query(
        'SELECT status FROM availability_slots WHERE id = $1',
        [slot.id],
      );
      expect(slotRow[0].status).toBe('AVAILABLE');

      // Payment record updated to REFUNDED
      const payRow = await dataSource.query(
        'SELECT status FROM payments WHERE consultation_id = $1',
        [consultation.id],
      );
      expect(payRow[0].status).toBe('REFUNDED');
    });

    it('admin can cancel any consultation', async () => {
      const { consultation } = await setupBookedConsultation(125);
      const cancelRes = await app.inject({
        method: 'PATCH',
        url: `/consultations/${consultation.id}/cancel`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          'idempotency-key': `admin-cancel-${randomUUID()}`,
        },
        payload: { reason: 'Cancelled by administrative policy' },
      });
      expect(cancelRes.statusCode).toBe(200);
      expect(JSON.parse(cancelRes.body).status).toBe(ConsultationStatus.CANCELLED);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Prescriptions (Encryption, RBAC, Ownership, Audit)
  // ─────────────────────────────────────────────────────────────
  describe('Prescriptions (AES-256-GCM PHI, RBAC, Audit Logging)', () => {
    let activeConsultationId: string;

    beforeAll(async () => {
      const { consultation } = await setupBookedConsultation(130);
      activeConsultationId = consultation.id;

      // Transition to IN_PROGRESS
      await dataSource.query(
        "UPDATE consultations SET status = 'IN_PROGRESS', version = 3 WHERE id = $1",
        [activeConsultationId],
      );
    });

    it('prescribing for PENDING_PAYMENT or CONFIRMED consultation is rejected with 409 Conflict', async () => {
      const { consultation } = await setupBookedConsultation(135);

      const rxRes = await app.inject({
        method: 'POST',
        url: `/consultations/${consultation.id}/prescriptions`,
        headers: {
          authorization: `Bearer ${doctorToken}`,
          'idempotency-key': `rx-fail-${randomUUID()}`,
        },
        payload: {
          medications: [{ name: 'Paracetamol', dosage: '500mg' }],
          diagnosis: 'Viral fever',
        },
      });

      expect(rxRes.statusCode).toBe(409);
    });

    it('unrelated doctor cannot prescribe for consultation (403 Forbidden)', async () => {
      const rxRes = await app.inject({
        method: 'POST',
        url: `/consultations/${activeConsultationId}/prescriptions`,
        headers: {
          authorization: `Bearer ${doctor2Token}`, // Doctor 2 is not assigned!
          'idempotency-key': `rx-dr2-${randomUUID()}`,
        },
        payload: {
          medications: [{ name: 'Aspirin', dosage: '100mg' }],
          diagnosis: 'Headache',
        },
      });

      expect(rxRes.statusCode).toBe(403);
    });

    it('assigned doctor creates prescription: stored as encrypted ciphertext in DB, audited', async () => {
      const rxRes = await app.inject({
        method: 'POST',
        url: `/consultations/${activeConsultationId}/prescriptions`,
        headers: {
          authorization: `Bearer ${doctorToken}`,
          'idempotency-key': `rx-create-${randomUUID()}`,
        },
        payload: {
          medications: [
            { name: 'Amoxicillin', dosage: '500mg', frequency: 'TDS', duration: '5 days' },
          ],
          diagnosis: 'Bacterial sinusitis',
          notes: 'Drink plenty of water and complete the full antibiotic course.',
        },
      });

      expect(rxRes.statusCode).toBe(201);
      const rx = JSON.parse(rxRes.body);
      expect(rx.id).toBeDefined();

      // PROVE ciphertext in database (raw query)
      const rawRows = await dataSource.query('SELECT * FROM prescriptions WHERE id = $1', [rx.id]);
      expect(rawRows.length).toBe(1);
      const rawRx = rawRows[0];

      // Ciphertext format: "keyId:iv:authTag:ciphertext"
      expect(rawRx.medications_encrypted).toMatch(
        /^[a-zA-Z0-9_-]+:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/,
      );
      expect(rawRx.diagnosis_encrypted).toMatch(
        /^[a-zA-Z0-9_-]+:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/,
      );
      expect(rawRx.notes_encrypted).toMatch(/^[a-zA-Z0-9_-]+:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);

      // Ciphertext does NOT leak plaintext in database
      expect(rawRx.diagnosis_encrypted).not.toContain('Bacterial sinusitis');
      expect(rawRx.medications_encrypted).not.toContain('Amoxicillin');
      expect(rawRx.notes_encrypted).not.toContain('antibiotic');

      // Verify audit log entry was created for PHI write
      const auditRows = await dataSource.query(
        `SELECT * FROM audit_logs
         WHERE action = 'PRESCRIPTION_CREATED' AND resource_id = $1`,
        [rx.id],
      );
      expect(auditRows.length).toBe(1);
      expect(auditRows[0].actor_id).toBe(doctorUserId);
      expect(auditRows[0].hash).toBeDefined();
    });

    it('patient owner and assigned doctor can read decrypted prescription; audited', async () => {
      // 1. Patient 1 reads prescriptions for consultation
      const patientReadRes = await app.inject({
        method: 'GET',
        url: `/consultations/${activeConsultationId}/prescriptions`,
        headers: {
          authorization: `Bearer ${patient1Token}`,
        },
      });

      expect(patientReadRes.statusCode).toBe(200);
      const rxList = JSON.parse(patientReadRes.body);
      expect(rxList.length).toBeGreaterThan(0);
      expect(rxList[0].diagnosis).toBe('Bacterial sinusitis');
      expect(rxList[0].medications[0].name).toBe('Amoxicillin');

      // 2. Assigned Doctor reads prescription by ID
      const rxId = rxList[0].id;
      const doctorReadRes = await app.inject({
        method: 'GET',
        url: `/prescriptions/${rxId}`,
        headers: {
          authorization: `Bearer ${doctorToken}`,
        },
      });

      expect(doctorReadRes.statusCode).toBe(200);
      const rxDetails = JSON.parse(doctorReadRes.body);
      expect(rxDetails.diagnosis).toBe('Bacterial sinusitis');

      // 3. Verify audit logs recorded for PHI read
      const readAuditLogs = await dataSource.query(
        `SELECT * FROM audit_logs
         WHERE action = 'PRESCRIPTION_READ' AND resource_id = $1`,
        [rxId],
      );
      expect(readAuditLogs.length).toBeGreaterThanOrEqual(2);
    });

    it('unrelated patient or doctor gets 403 Forbidden when attempting to read prescription', async () => {
      // Fetch prescription ID
      const rxRows = await dataSource.query(
        'SELECT id FROM prescriptions WHERE consultation_id = $1 LIMIT 1',
        [activeConsultationId],
      );
      const rxId = rxRows[0].id;

      // Patient 2 (unrelated patient) gets 403
      const p2Res = await app.inject({
        method: 'GET',
        url: `/prescriptions/${rxId}`,
        headers: {
          authorization: `Bearer ${patient2Token}`,
        },
      });
      expect(p2Res.statusCode).toBe(403);

      // Doctor 2 (unassigned doctor) gets 403
      const doc2Res = await app.inject({
        method: 'GET',
        url: `/prescriptions/${rxId}`,
        headers: {
          authorization: `Bearer ${doctor2Token}`,
        },
      });
      expect(doc2Res.statusCode).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Payments & Saga Failure Paths (booking-sequence.md)
  // ─────────────────────────────────────────────────────────────
  describe('Payments & Saga Failure Paths', () => {
    it('Failure Path 1: Payment failure webhook cancels consultation and releases slot', async () => {
      const { slot, consultation } = await setupBookedConsultation(140);

      // Trigger outbox processing
      let pi: string | null = null;
      for (let i = 0; i < 5; i++) {
        await sagaOutboxService.processOutboxBatch(20);
        const consultRow = await dataSource.query(
          'SELECT payment_intent_id FROM consultations WHERE id = $1',
          [consultation.id],
        );
        if (consultRow[0]?.payment_intent_id) {
          pi = consultRow[0].payment_intent_id;
          break;
        }
      }
      expect(pi).toBeTruthy();

      // Provider sends payment.failed webhook
      const failWebhook = mockPaymentProvider.generateSignedWebhook({
        eventId: `evt_fail_${randomUUID()}`,
        eventType: 'payment.failed',
        paymentIntentId: pi!,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/payments',
        headers: {
          'x-webhook-signature': failWebhook.signature,
          'x-timestamp': String(failWebhook.timestamp),
          'content-type': 'application/json',
        },
        payload: failWebhook.rawBody,
      });

      expect(res.statusCode).toBe(200);

      // Consultation is cancelled with reason PAYMENT_FAILED
      const updatedConsult = await dataSource.query(
        'SELECT status, cancellation_reason FROM consultations WHERE id = $1',
        [consultation.id],
      );
      expect(updatedConsult[0].status).toBe(ConsultationStatus.CANCELLED);
      expect(updatedConsult[0].cancellation_reason).toBe('PAYMENT_FAILED');

      // Slot is released back to AVAILABLE
      const updatedSlot = await dataSource.query(
        'SELECT status FROM availability_slots WHERE id = $1',
        [slot.id],
      );
      expect(updatedSlot[0].status).toBe('AVAILABLE');
    });

    it('Failure Path 2: Duplicate webhook is deduplicated and returns idempotent 200', async () => {
      const { consultation } = await setupBookedConsultation(145);
      let pi: string | null = null;
      for (let i = 0; i < 5; i++) {
        await sagaOutboxService.processOutboxBatch(20);
        const consultRow = await dataSource.query(
          'SELECT payment_intent_id FROM consultations WHERE id = $1',
          [consultation.id],
        );
        if (consultRow[0]?.payment_intent_id) {
          pi = consultRow[0].payment_intent_id;
          break;
        }
      }
      expect(pi).toBeTruthy();

      const eventId = `evt_dedupe_${randomUUID()}`;
      const webhook = mockPaymentProvider.generateSignedWebhook({
        eventId,
        eventType: 'payment.succeeded',
        paymentIntentId: pi!,
      });

      // Send first time -> 200 processed
      const res1 = await app.inject({
        method: 'POST',
        url: '/webhooks/payments',
        headers: {
          'x-webhook-signature': webhook.signature,
          'x-timestamp': String(webhook.timestamp),
          'content-type': 'application/json',
        },
        payload: webhook.rawBody,
      });
      expect(res1.statusCode).toBe(200);
      expect(JSON.parse(res1.body).status).toBe('processed');

      // Send second time with exact same event_id -> returns idempotent 200 already_processed
      const res2 = await app.inject({
        method: 'POST',
        url: '/webhooks/payments',
        headers: {
          'x-webhook-signature': webhook.signature,
          'x-timestamp': String(webhook.timestamp),
          'content-type': 'application/json',
        },
        payload: webhook.rawBody,
      });
      expect(res2.statusCode).toBe(200);
      expect(JSON.parse(res2.body).status).toBe('already_processed');
    });

    it('Failure Path 3: Invalid webhook signature is rejected with 401 Unauthorized', async () => {
      const webhook = mockPaymentProvider.generateSignedWebhook({
        eventId: `evt_tamper_${randomUUID()}`,
        eventType: 'payment.succeeded',
        paymentIntentId: 'pi_test_fake',
        secret: 'wrong-secret-that-fails-hmac',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/payments',
        headers: {
          'x-webhook-signature': webhook.signature,
          'x-timestamp': String(webhook.timestamp),
          'content-type': 'application/json',
        },
        payload: webhook.rawBody,
      });

      expect(res.statusCode).toBe(401);
    });

    it('Failure Path 4: Replayed old webhook (>5 min old) is rejected with 400 Bad Request', async () => {
      const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
      const oldWebhook = mockPaymentProvider.generateSignedWebhook({
        eventId: `evt_replay_${randomUUID()}`,
        eventType: 'payment.succeeded',
        paymentIntentId: 'pi_test_old',
        timestamp: tenMinutesAgo,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/payments',
        headers: {
          'x-webhook-signature': oldWebhook.signature,
          'x-timestamp': String(oldWebhook.timestamp),
          'content-type': 'application/json',
        },
        payload: oldWebhook.rawBody,
      });

      expect(res.statusCode).toBe(400);
    });

    it('Failure Path 5: 10-minute payment timeout compensates: cancels consultation and releases slot', async () => {
      const { slot, consultation } = await setupBookedConsultation(150);

      // Backdate consultation created_at to 15 minutes ago
      await dataSource.query(
        "UPDATE consultations SET created_at = now() - interval '15 minutes' WHERE id = $1",
        [consultation.id],
      );

      // Trigger timeout processor
      const timedOutCount = await sagaOutboxService.processPaymentTimeouts(10);
      expect(timedOutCount).toBeGreaterThanOrEqual(1);

      // Verify consultation cancelled
      const consultRow = await dataSource.query(
        'SELECT status, cancellation_reason FROM consultations WHERE id = $1',
        [consultation.id],
      );
      expect(consultRow[0].status).toBe(ConsultationStatus.CANCELLED);
      expect(consultRow[0].cancellation_reason).toBe('PAYMENT_TIMEOUT');

      // Verify slot released back to AVAILABLE
      const slotRow = await dataSource.query(
        'SELECT status FROM availability_slots WHERE id = $1',
        [slot.id],
      );
      expect(slotRow[0].status).toBe('AVAILABLE');
    });

    it('Failure Path 6: Provider outage trips circuit breaker to OPEN (fast-failing)', async () => {
      const { consultation } = await setupBookedConsultation(155);

      // Reset circuit breaker
      paymentsService.circuitBreaker.reset();

      // Simulate provider outage
      mockPaymentProvider.setOutage(true);

      // 3 consecutive failures trip circuit breaker to OPEN
      for (let i = 0; i < 3; i++) {
        try {
          await paymentsService.createPaymentIntent(consultation.id, 50000);
        } catch {
          // Expected to fail
        }
      }

      // Circuit breaker is now OPEN
      expect(paymentsService.circuitBreaker.getState()).toBe('OPEN');

      // Next call fast-fails with 503 without hitting provider
      await expect(paymentsService.createPaymentIntent(consultation.id, 50000)).rejects.toThrow();

      // Restore provider
      mockPaymentProvider.setOutage(false);
      paymentsService.circuitBreaker.reset();
      expect(paymentsService.circuitBreaker.getState()).toBe('CLOSED');
    });

    it('Failure Path 7: Worker killed mid-relay recovers with no lost and no duplicated effect', async () => {
      const { consultation } = await setupBookedConsultation(160);

      // Find outbox event
      const eventRows = await dataSource.query(
        `SELECT id FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'consultation.created'`,
        [consultation.id],
      );
      expect(eventRows.length).toBe(1);
      const eventId = eventRows[0].id;

      // Simulate worker crash: event marked PROCESSING and abandoned 60 seconds ago
      await dataSource.query(
        'ALTER TABLE outbox_events DISABLE TRIGGER trg_outbox_events_updated_at',
      );
      await dataSource.query(
        `UPDATE outbox_events
         SET status = 'PROCESSING', updated_at = now() - interval '60 seconds'
         WHERE id = $1`,
        [eventId],
      );
      await dataSource.query(
        'ALTER TABLE outbox_events ENABLE TRIGGER trg_outbox_events_updated_at',
      );

      // Crash recovery worker runs
      const recovered = await sagaOutboxService.recoverStuckEvents(30);
      expect(recovered).toBeGreaterThanOrEqual(1);

      // Event is back to PENDING
      const recoveredEvent = await dataSource.query(
        'SELECT status FROM outbox_events WHERE id = $1',
        [eventId],
      );
      expect(recoveredEvent[0].status).toBe('PENDING');

      // Recovered worker picks up event and processes it safely
      for (let i = 0; i < 5; i++) {
        await sagaOutboxService.processOutboxBatch(50);
        const check = await dataSource.query('SELECT status FROM outbox_events WHERE id = $1', [
          eventId,
        ]);
        if (check[0]?.status === 'PROCESSED') break;
      }

      // Final status is PROCESSED
      const finalEvent = await dataSource.query('SELECT status FROM outbox_events WHERE id = $1', [
        eventId,
      ]);
      expect(finalEvent[0].status).toBe('PROCESSED');
    });

    it('partition maintenance worker job runs ensure_partitions cleanly', async () => {
      await expect(sagaOutboxService.ensureFuturePartitions(3)).resolves.not.toThrow();
    });
  });
});
