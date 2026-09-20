import { Controller, Get, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';
import { DataSource } from 'typeorm';
import { Public } from '../decorators/public.decorator';

@ApiTags('Observability')
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metricsService: MetricsService,
    private readonly dataSource: DataSource,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Prometheus metrics scrape endpoint' })
  @ApiResponse({ status: 200, description: 'Prometheus plain text exposition format' })
  async getMetrics(@Res() res: FastifyReply): Promise<void> {
    // 1. Scrape live DB pool usage
    try {
      const driver = this.dataSource.driver as any;
      const master = driver?.master;
      if (master) {
        const total = master.totalCount || 0;
        const idle = master.idleCount || 0;
        const used = Math.max(0, total - idle);
        const waiting = master.waitingCount || 0;
        const max = master.options?.max || 10;
        this.metricsService.updateDbPoolMetrics(used, idle, max, waiting);
      }
    } catch {
      // Ignore if pool driver cannot be inspected
    }

    // 2. Scrape live outbox stats
    try {
      const stats = await this.dataSource.query(`
        SELECT
          count(*) FILTER (WHERE status IN ('PENDING', 'PROCESSING'))::int AS pending_count,
          count(*) FILTER (WHERE status = 'DLQ')::int AS dlq_count,
          coalesce(extract(epoch from (now() - min(created_at))) FILTER (WHERE status = 'PENDING'), 0)::float AS lag_seconds
        FROM outbox_events;
      `);
      if (stats.length > 0) {
        const row = stats[0];
        this.metricsService.updateOutboxMetrics(
          row.pending_count || 0,
          row.lag_seconds || 0,
          row.dlq_count || 0,
        );
      }
    } catch {
      // Ignore if outbox table not yet initialized
    }

    const metrics = await this.metricsService.getMetrics();
    res.header('Content-Type', this.metricsService.getContentType());
    res.send(metrics);
  }
}
