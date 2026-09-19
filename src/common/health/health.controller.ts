import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../decorators/public.decorator';
import { DataSource } from 'typeorm';
import { Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

@ApiTags('Health')
@Controller()
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Liveness probe — is the process alive? */
  @Public()
  @Get('healthz')
  @ApiOperation({ summary: 'Liveness probe' })
  healthz() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /** Readiness probe — can the service handle requests? */
  @Public()
  @Get('readyz')
  @ApiOperation({ summary: 'Readiness probe' })
  async readyz() {
    const checks: Record<string, string> = {};

    // Check DB
    try {
      await this.dataSource.query('SELECT 1');
      checks['db'] = 'ok';
    } catch {
      checks['db'] = 'fail';
    }

    // Check Redis
    try {
      await this.redis.ping();
      checks['redis'] = 'ok';
    } catch {
      checks['redis'] = 'fail';
    }

    const allOk = Object.values(checks).every((v) => v === 'ok');
    return {
      status: allOk ? 'ok' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    };
  }
}
