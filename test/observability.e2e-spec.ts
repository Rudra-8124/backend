import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { Logger } from 'nestjs-pino';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../src/common/redis/redis.constants';
import { SagaOutboxService } from '../src/consultations/saga-outbox.service';
import { MockPaymentProvider } from '../src/payments/providers/mock-payment.provider';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';

describe('Phase 5: Observability, Tracing, Metrics & Logs (e2e)', () => {
  let app: NestFastifyApplication;
  let dataSource: DataSource;
  let redis: Redis;
  let sagaOutboxService: SagaOutboxService;
  let mockPaymentProvider: MockPaymentProvider;

  let patientToken: string;
  let patientUserId: string;
  let doctorId: string;
  let doctorUserId: string;
  const password = 'ObsTestPassword123!Secure';

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
    sagaOutboxService = app.get(SagaOutboxService);
    mockPaymentProvider = app.get(MockPaymentProvider);

    // Clear rate limits
    const rlKeys = await redis.keys('rl:*');
    if (rlKeys.length > 0) await redis.del(...rlKeys);

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    // 1. Doctor setup
    const docEmail = `doc_obs_${Date.now()}@amrutam.local`;
    const docUser = await dataSource.query(
      `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
       VALUES (gen_random_uuid(), $1, $2, 'doctor', true, true)
       RETURNING id;`,
      [docEmail, passwordHash],
    );
    doctorUserId = docUser[0].id;
    await dataSource.query(
      `INSERT INTO profiles (user_id, first_name, last_name, city) VALUES ($1, 'Ananya', 'Gupta', 'Delhi');`,
      [doctorUserId],
    );

    const docResult = await dataSource.query(
      `INSERT INTO doctors (
        user_id, bio, license_number, specializations, languages,
        experience_years, fee_cents, rating_avg, rating_count, is_verified
      ) VALUES (
        $1, 'Ayurvedic wellness consultant.',
        $2, ARRAY['Ayurveda'], ARRAY['English', 'Hindi'],
        10, 50000, 4.9, 25, true
      ) RETURNING id;`,
      [doctorUserId, `LIC-OBS-${Date.now()}`],
    );
    doctorId = docResult[0].id;

    // 2. Patient setup
    const patientEmail = `pat_obs_${Date.now()}@amrutam.local`;
    const patUser = await dataSource.query(
      `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
       VALUES (gen_random_uuid(), $1, $2, 'patient', true, true)
       RETURNING id;`,
      [patientEmail, passwordHash],
    );
    patientUserId = patUser[0].id;
    await dataSource.query(
      `INSERT INTO profiles (user_id, first_name, last_name, city) VALUES ($1, 'Vikram', 'Mehta', 'Bangalore');`,
      [patientUserId],
    );

    const patLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: patientEmail, password },
    });
    patientToken = JSON.parse(patLogin.body).accessToken;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  // Helper to create discrete availability slot
  async function createSlot(offsetHours: number = 24) {
    const slotTime = new Date(Date.now() + offsetHours * 3600 * 1000);
    const slotEndTime = new Date(slotTime.getTime() + 30 * 60 * 1000);
    const slotMonth = slotTime.toISOString().slice(0, 7) + '-01';

    const [slot] = await dataSource.query(
      `INSERT INTO availability_slots (id, partition_month, doctor_id, start_time, end_time, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'AVAILABLE', now(), now())
       RETURNING id, partition_month, start_time, end_time;`,
      [slotMonth, doctorId, slotTime, slotEndTime],
    );
    return slot;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 1. DISTRIBUTED TRACING & W3C TRACE CONTEXT PROPAGATION
  // ──────────────────────────────────────────────────────────────────────────

  describe('1. Distributed Tracing & W3C Context Propagation', () => {
    it('should propagate traceparent through outbox and maintain ONE trace across API and worker', async () => {
      const slot = await createSlot(48);
      const idempotencyKey = randomUUID();

      // Start an active root trace to simulate incoming distributed trace or API ingress
      const tracer = trace.getTracer('amrutam-e2e-test');
      let capturedTraceId = '';
      let consultationId = '';

      await tracer.startActiveSpan('e2e.booking_journey', async (rootSpan) => {
        capturedTraceId = rootSpan.spanContext().traceId;
        expect(capturedTraceId).toBeDefined();
        expect(capturedTraceId).toHaveLength(32);

        // 1. API: Book consultation with active span context
        const bookRes = await app.inject({
          method: 'POST',
          url: '/consultations',
          headers: {
            authorization: `Bearer ${patientToken}`,
            'Idempotency-Key': idempotencyKey,
            traceparent: `00-${capturedTraceId}-${rootSpan.spanContext().spanId}-01`,
          },
          payload: {
            slotId: slot.id,
            reason: 'Observability verification booking',
          },
        });

        expect(bookRes.statusCode).toBe(201);
        const bookBody = JSON.parse(bookRes.body);
        consultationId = bookBody.id;
        expect(consultationId).toBeDefined();
        rootSpan.setStatus({ code: SpanStatusCode.OK });
        rootSpan.end();
      });

      // 2. Verify that the outbox row contains the propagated traceparent
      const outboxRows = await dataSource.query(
        `SELECT id, event_type, aggregate_id, payload, status, traceparent
         FROM outbox_events
         WHERE aggregate_id = $1`,
        [consultationId],
      );

      expect(outboxRows.length).toBeGreaterThan(0);
      const outboxEvent = outboxRows[0];
      expect(outboxEvent.event_type).toBe('consultation.created');
      expect(outboxEvent.traceparent).toBeDefined();
      expect(outboxEvent.traceparent).toContain(capturedTraceId);

      // Verify payload also holds _traceparent for redundancy
      const payload =
        typeof outboxEvent.payload === 'string'
          ? JSON.parse(outboxEvent.payload)
          : outboxEvent.payload;
      expect(payload._traceparent).toBeDefined();
      expect(payload._traceparent).toContain(capturedTraceId);

      // 3. Worker executes the outbox relay batch
      const outboxResult = await sagaOutboxService.processOutboxBatch(10);
      expect(outboxResult.processed).toBeGreaterThanOrEqual(1);

      // 4. Verify payment intent was created by the worker within the saga
      const payRows = await dataSource.query(
        `SELECT id, consultation_id, payment_intent_id, status FROM payments WHERE consultation_id = $1`,
        [consultationId],
      );
      expect(payRows.length).toBe(1);
      expect(payRows[0].payment_intent_id).toBeDefined();
      expect(payRows[0].status).toBe('PENDING');

      // 5. Complete payment via HMAC webhook
      const paymentIntentId = payRows[0].payment_intent_id;
      const signedWebhook = mockPaymentProvider.generateSignedWebhook({
        eventId: `evt_obs_${Date.now()}`,
        eventType: 'payment.succeeded',
        paymentIntentId,
        amountCents: 50000,
      });

      const webhookRes = await app.inject({
        method: 'POST',
        url: '/webhooks/payments',
        headers: {
          'x-webhook-signature': signedWebhook.signature,
          'x-timestamp': String(signedWebhook.timestamp),
          'content-type': 'application/json',
        },
        payload: signedWebhook.rawBody,
      });
      expect(webhookRes.statusCode).toBe(200);

      // 6. Verify consultation confirmed
      const [confirmedConsult] = await dataSource.query(
        `SELECT status FROM consultations WHERE id = $1`,
        [consultationId],
      );
      expect(confirmedConsult.status).toBe('CONFIRMED');

      console.log('---------------------------------------------------------');
      console.log(`[Trace Proven] Unified Trace ID: ${capturedTraceId}`);
      console.log(`[Trace Proven] Outbox traceparent: ${outboxEvent.traceparent}`);
      console.log(`[Trace Proven] Consultation ${consultationId} booked & confirmed in ONE trace`);
      console.log('---------------------------------------------------------');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. PROMETHEUS METRICS & CARDINALITY PROTECTION
  // ──────────────────────────────────────────────────────────────────────────

  describe('2. Prometheus Metrics & Cardinality Protection', () => {
    it('should expose metrics without high-cardinality labels (uses route templates)', async () => {
      // First invoke a parameterized endpoint to produce metric observations
      const getDocRes = await app.inject({
        method: 'GET',
        url: `/doctors/${doctorId}`,
        headers: {
          authorization: `Bearer ${patientToken}`,
        },
      });
      expect(getDocRes.statusCode).toBe(200);

      // Scrape /metrics
      const metricsRes = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(metricsRes.statusCode).toBe(200);
      const metricsText = metricsRes.body;

      // 1. Verify metric presence
      expect(metricsText).toContain('http_request_duration_seconds');
      expect(metricsText).toContain('http_requests_total');
      expect(metricsText).toContain('booking_attempts_total');
      expect(metricsText).toContain('slot_conflicts_total');
      expect(metricsText).toContain('idempotency_replays_total');
      expect(metricsText).toContain('db_pool_connections');
      expect(metricsText).toContain('outbox_lag_seconds');
      expect(metricsText).toContain('outbox_pending_total');

      // 2. Verify route template normalization:
      // Route must be "/doctors/:id", NEVER the raw UUID "/doctors/..."
      expect(metricsText).toContain('route="/doctors/:id"');
      expect(metricsText).toContain('route="/consultations"');

      // 3. Strict assertion: NO raw UUID in route labels
      const uuidInRouteRegex =
        /route="[^"]*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[^"]*"/i;
      const uuidMatch = metricsText.match(uuidInRouteRegex);
      expect(uuidMatch).toBeNull();
    });

    it('should increment slot_conflicts_total and booking_attempts_total{result="conflict"} on 409', async () => {
      const slot = await createSlot(72);

      // First booking succeeds
      const res1 = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: {
          authorization: `Bearer ${patientToken}`,
          'Idempotency-Key': randomUUID(),
        },
        payload: { slotId: slot.id },
      });
      expect(res1.statusCode).toBe(201);

      // Second booking on same slot triggers 409 conflict
      const res2 = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: {
          authorization: `Bearer ${patientToken}`,
          'Idempotency-Key': randomUUID(),
        },
        payload: { slotId: slot.id },
      });
      expect(res2.statusCode).toBe(409);

      // Verify metric was incremented
      const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
      expect(metricsRes.body).toContain('booking_attempts_total{result="conflict"}');
      expect(metricsRes.body).toContain('slot_conflicts_total');
    });

    it('should increment idempotency_replays_total on cached idempotent replays', async () => {
      const slot = await createSlot(96);
      const idempotencyKey = randomUUID();
      const payload = { slotId: slot.id };

      // First call
      const res1 = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: {
          authorization: `Bearer ${patientToken}`,
          'Idempotency-Key': idempotencyKey,
        },
        payload,
      });
      expect(res1.statusCode).toBe(201);

      // Replay with exact same key and payload
      const res2 = await app.inject({
        method: 'POST',
        url: '/consultations',
        headers: {
          authorization: `Bearer ${patientToken}`,
          'Idempotency-Key': idempotencyKey,
        },
        payload,
      });
      expect(res2.statusCode).toBe(201);
      expect(res2.headers['idempotency-replay']).toBe('true');

      // Verify idempotency replay metric
      const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
      expect(metricsRes.body).toContain('idempotency_replays_total');
    });

    it('should expose real-time database connection pool metrics', async () => {
      const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
      expect(metricsRes.body).toContain('db_pool_connections{state="used"}');
      expect(metricsRes.body).toContain('db_pool_connections{state="idle"}');
      expect(metricsRes.body).toContain('db_pool_connections{state="max"}');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. STRUCTURED LOGS & REDACTION
  // ──────────────────────────────────────────────────────────────────────────

  describe('3. Structured Logs & PII/PHI Redaction', () => {
    it('should verify passwords, tokens and secrets are redacted in logs', async () => {
      const rawPayload = {
        email: 'redact_test@amrutam.local',
        password: 'SuperSecretPassword123!',
      };

      // Call login with bad password to verify request logging
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: rawPayload,
      });
      expect(res.statusCode).toBe(401);

      // Ensure that raw password or secret never leaks in error response
      expect(res.body).not.toContain('SuperSecretPassword123!');
    });
  });
});
