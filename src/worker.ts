import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AvailabilityService } from './availability/availability.service';
import { SagaOutboxService } from './consultations/saga-outbox.service';
import { AdminAnalyticsService } from './admin-analytics/admin-analytics.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();

  const availabilityService = app.get(AvailabilityService);
  const sagaOutboxService = app.get(SagaOutboxService);
  const adminAnalyticsService = app.get(AdminAnalyticsService);
  logger.log('Worker process started — running background saga & maintenance jobs');

  // 1. Initial partition maintenance on startup
  try {
    await sagaOutboxService.ensureFuturePartitions(3);
  } catch (err) {
    logger.error(`Initial partition creation failed: ${err}`);
  }

  // 2. Periodic hold-expiry cleaner (every 10 seconds)
  const HOLD_EXPIRY_INTERVAL_MS = 10_000;
  setInterval(async () => {
    try {
      const released = await availabilityService.releaseExpiredHolds();
      if (released > 0) {
        logger.log(`Hold-expiry worker released ${released} expired slot holds`);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Error in hold-expiry worker: ${errorMsg}`);
    }
  }, HOLD_EXPIRY_INTERVAL_MS);

  // 3. Outbox relay worker (every 2 seconds)
  const OUTBOX_POLL_INTERVAL_MS = 2_000;
  setInterval(async () => {
    try {
      const res = await sagaOutboxService.processOutboxBatch(10);
      if (res.processed > 0 || res.failed > 0 || res.dlq > 0) {
        logger.log(
          `Outbox relay batch completed: ${res.processed} processed, ${res.failed} failed, ${res.dlq} DLQ`,
        );
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Error in outbox relay worker: ${errorMsg}`);
    }
  }, OUTBOX_POLL_INTERVAL_MS);

  // 4. Stale outbox event crash recovery (every 30 seconds)
  const CRASH_RECOVERY_INTERVAL_MS = 30_000;
  setInterval(async () => {
    try {
      const recovered = await sagaOutboxService.recoverStuckEvents(30);
      if (recovered > 0) {
        logger.log(`Recovered ${recovered} stuck outbox events`);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Error in outbox crash recovery worker: ${errorMsg}`);
    }
  }, CRASH_RECOVERY_INTERVAL_MS);

  // 5. Payment timeout compensation (every 30 seconds)
  const PAYMENT_TIMEOUT_INTERVAL_MS = 30_000;
  setInterval(async () => {
    try {
      const timedOut = await sagaOutboxService.processPaymentTimeouts(10);
      if (timedOut > 0) {
        logger.log(
          `Processed payment timeouts: ${timedOut} consultations cancelled and slots released`,
        );
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Error in payment timeout processor: ${errorMsg}`);
    }
  }, PAYMENT_TIMEOUT_INTERVAL_MS);

  // 6. Partition maintenance (every 24 hours)
  const PARTITION_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      await sagaOutboxService.ensureFuturePartitions(3);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Error in partition maintenance worker: ${errorMsg}`);
    }
  }, PARTITION_MAINTENANCE_INTERVAL_MS);

  // 7. Materialized view refresh for admin analytics (every 5 minutes)
  const MV_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  setInterval(async () => {
    try {
      await adminAnalyticsService.refreshMaterializedView();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Error in analytics materialized view refresh worker: ${errorMsg}`);
    }
  }, MV_REFRESH_INTERVAL_MS);
}

bootstrap();
