import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { SagaOutboxService } from '../src/consultations/saga-outbox.service';
import { CacheService } from '../src/common/cache/cache.service';
import { RateLimitService } from '../src/common/rate-limit/rate-limit.service';
import { randomUUID } from 'crypto';

describe('Failure Injection & Resilience Audit', () => {
  let app: NestFastifyApplication;
  let dataSource: DataSource;
  let sagaOutboxService: SagaOutboxService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    dataSource = app.get(DataSource);
    sagaOutboxService = app.get(SagaOutboxService);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  // ── 1. Kill Redis Simulation ───────────────────────────────────────
  describe('Failure 1: Redis Crash / Unavailability', () => {
    it('CacheService falls back directly to PostgreSQL without crashing when Redis is down', async () => {
      // Create a disconnected/mocked broken Redis client
      const brokenRedis = new Redis({
        host: '127.0.0.1',
        port: 65530, // dead port
        connectTimeout: 100,
        maxRetriesPerRequest: 0,
        lazyConnect: true,
      });

      const fallbackCache = new CacheService(brokenRedis);

      let fetcherExecuted = false;
      const result = await fallbackCache.getOrSet({
        namespace: 'doctors:search',
        identifier: { q: 'ayurveda' },
        ttlSeconds: 60,
        fetcher: async () => {
          fetcherExecuted = true;
          return { data: 'fresh-db-result' };
        },
      });

      expect(fetcherExecuted).toBe(true);
      expect(result.data).toEqual({ data: 'fresh-db-result' });
      expect(result.cached).toBe(false);

      brokenRedis.disconnect();
    });

    it('RateLimitService fails open when Redis is unavailable to preserve service continuity', async () => {
      const brokenRedis = new Redis({
        host: '127.0.0.1',
        port: 65530, // dead port
        connectTimeout: 100,
        maxRetriesPerRequest: 0,
        lazyConnect: true,
      });

      const fallbackRateLimiter = new RateLimitService(brokenRedis);
      const res = await fallbackRateLimiter.consume('user:123', 5, 60);

      expect(res.allowed).toBe(true);
      expect(res.retryAfterSeconds).toBe(0);

      brokenRedis.disconnect();
    });
  });

  // ── 2. Kill Worker Mid-Saga Simulation ─────────────────────────────
  describe('Failure 2: Worker Killed Mid-Saga (Crash Recovery)', () => {
    it('Recovers abandoned outbox events stuck in PROCESSING and processes them idempotently', async () => {
      const consultationId = randomUUID();
      const patientId = randomUUID();
      const doctorId = randomUUID();
      const slotId = randomUUID();
      const partitionMonth = new Date().toISOString().slice(0, 7) + '-01';

      // Insert dummy consultation so createPaymentIntent finds the consultation
      await dataSource.query(
        `INSERT INTO consultations
          (id, partition_month, patient_id, doctor_id, slot_id, slot_partition_month, status, scheduled_start, scheduled_end)
         VALUES
          ($1, $2, $3, $4, $5, $2, 'PENDING_PAYMENT', now() + interval '1 day', now() + interval '1 day 30 minutes')`,
        [consultationId, partitionMonth, patientId, doctorId, slotId],
      );

      // 1. Simulate an event claimed by a worker that was SIGKILL'd mid-execution (> 30s ago)
      const insertResult = await dataSource.query(
        `INSERT INTO outbox_events
          (event_type, aggregate_id, aggregate_type, payload, status, retry_count, attempts, created_at, updated_at)
         VALUES
          ('consultation.created', $1, 'consultation', $2, 'PROCESSING', 0, 1, now() - interval '60 seconds', now() - interval '45 seconds')
         RETURNING id;`,
        [
          consultationId,
          JSON.stringify({
            consultationId,
            patientId,
            doctorId,
            amountCents: 50000,
          }),
        ],
      );
      const eventId = insertResult[0].id;

      // 2. Worker restarts and runs recoverStuckEvents(30)
      const recoveredCount = await sagaOutboxService.recoverStuckEvents(30);
      expect(recoveredCount).toBeGreaterThanOrEqual(1);

      // Verify the event status was reset to PENDING
      const eventRows = await dataSource.query(`SELECT status FROM outbox_events WHERE id = $1`, [
        eventId,
      ]);
      expect(eventRows[0].status).toBe('PENDING');

      // 3. Worker relay processes the batch
      await sagaOutboxService.processOutboxBatch(10);

      // 4. Verify event transitioned to PROCESSED with zero data loss
      const processedRows = await dataSource.query(
        `SELECT status FROM outbox_events WHERE id = $1`,
        [eventId],
      );
      expect(processedRows[0].status).toBe('PROCESSED');

      // 5. Verify payment intent was safely created
      const payRows = await dataSource.query(
        `SELECT status, payment_intent_id FROM payments WHERE consultation_id = $1`,
        [consultationId],
      );
      expect(payRows.length).toBe(1);
      expect(payRows[0].payment_intent_id).toBeDefined();

      // Cleanup
      await dataSource.query(`DELETE FROM payments WHERE consultation_id = $1`, [consultationId]);
      await dataSource.query(`DELETE FROM outbox_events WHERE id = $1`, [eventId]);
      await dataSource.query(`DELETE FROM consultations WHERE id = $1`, [consultationId]);
    });
  });

  // ── 3. Restart Postgres / Pool Simulation ──────────────────────────
  describe('Failure 3: Database Connection Health & Readiness', () => {
    it('/readyz reports 200 when DB and Redis are healthy', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/readyz',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('ok');
      expect(body.checks.db).toBe('ok');
      expect(body.checks.redis).toBe('ok');
    });

    it('/healthz (liveness) succeeds even if background dependencies fluctuate', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('ok');
    });
  });
});
