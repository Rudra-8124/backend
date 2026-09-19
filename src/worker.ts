import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AvailabilityService } from './availability/availability.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();

  const availabilityService = app.get(AvailabilityService);
  logger.log('Worker process started — running background jobs');

  // Periodic hold-expiry cleaner (every 10 seconds)
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
}

bootstrap();
