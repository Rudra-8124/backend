import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConsultationsAnalyticsDto, DoctorsAnalyticsDto } from './dto/analytics-query.dto';

export interface DailyConsultationMetric {
  day: string;
  total: number;
  completed: number;
  cancelled: number;
  no_show: number;
  pending_payment: number;
  confirmed: number;
  revenue_cents: string | number;
}

export interface ConsultationsAnalyticsResponse {
  summary: {
    totalConsultations: number;
    completedConsultations: number;
    cancelledConsultations: number;
    noShowConsultations: number;
    cancellationRate: number;
    noShowRate: number;
    revenueCents: number;
  };
  timeSeries: DailyConsultationMetric[];
}

export interface DoctorAnalyticsRow {
  doctorId: string;
  doctorName: string;
  specializations: string[];
  totalConsultations: number;
  completedConsultations: number;
  cancelledConsultations: number;
  revenueCents: number;
  totalSlots: number;
  utilizationRate: number;
}

export interface DoctorsAnalyticsResponse {
  doctors: DoctorAnalyticsRow[];
  next_cursor: string | null;
}

@Injectable()
export class AdminAnalyticsService {
  private readonly logger = new Logger(AdminAnalyticsService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Validate that the date range does not exceed maxDays (default: 90 days).
   */
  private validateDateRange(
    fromStr: string,
    toStr: string,
    maxDays = 90,
  ): { fromDate: string; toDate: string } {
    const from = new Date(fromStr);
    const to = new Date(toStr);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new BadRequestException('Invalid date format. Expected YYYY-MM-DD');
    }

    if (from > to) {
      throw new BadRequestException('date_from cannot be after date_to');
    }

    const diffDays = Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays > maxDays) {
      throw new BadRequestException(
        `Date range exceeds maximum allowed limit of ${maxDays} days (requested: ${diffDays} days)`,
      );
    }

    return {
      fromDate: fromStr.slice(0, 10),
      toDate: toStr.slice(0, 10),
    };
  }

  /**
   * Consultations per day, aggregate counts, cancellation rate, no-show rate, and revenue.
   * Queried from daily_consultation_analytics_mv.
   */
  async getConsultationsAnalytics(
    dto: ConsultationsAnalyticsDto,
  ): Promise<ConsultationsAnalyticsResponse> {
    const { fromDate, toDate } = this.validateDateRange(dto.date_from, dto.date_to, 90);

    const timeSeries: DailyConsultationMetric[] = await this.dataSource.query(
      `
      SELECT
        day::text,
        sum(total_consultations)::int AS total,
        sum(completed_count)::int AS completed,
        sum(cancelled_count)::int AS cancelled,
        sum(no_show_count)::int AS no_show,
        sum(pending_payment_count)::int AS pending_payment,
        sum(confirmed_count)::int AS confirmed,
        sum(revenue_cents)::bigint AS revenue_cents
      FROM daily_consultation_analytics_mv
      WHERE day >= $1 AND day <= $2
      GROUP BY day
      ORDER BY day ASC;
      `,
      [fromDate, toDate],
    );

    let totalConsultations = 0;
    let completedConsultations = 0;
    let cancelledConsultations = 0;
    let noShowConsultations = 0;
    let revenueCents = 0;

    for (const row of timeSeries) {
      totalConsultations += Number(row.total || 0);
      completedConsultations += Number(row.completed || 0);
      cancelledConsultations += Number(row.cancelled || 0);
      noShowConsultations += Number(row.no_show || 0);
      revenueCents += Number(row.revenue_cents || 0);
    }

    const cancellationRate =
      totalConsultations > 0
        ? Number(((cancelledConsultations / totalConsultations) * 100).toFixed(2))
        : 0;
    const noShowRate =
      totalConsultations > 0
        ? Number(((noShowConsultations / totalConsultations) * 100).toFixed(2))
        : 0;

    return {
      summary: {
        totalConsultations,
        completedConsultations,
        cancelledConsultations,
        noShowConsultations,
        cancellationRate,
        noShowRate,
        revenueCents,
      },
      timeSeries,
    };
  }

  /**
   * Doctor utilization and productivity metrics with keyset pagination.
   */
  async getDoctorsAnalytics(dto: DoctorsAnalyticsDto): Promise<DoctorsAnalyticsResponse> {
    const { fromDate, toDate } = this.validateDateRange(dto.date_from, dto.date_to, 90);
    const limit = Math.min(Math.max(dto.limit || 20, 1), 100);

    const params: any[] = [fromDate, toDate];
    let cursorClause = '';

    if (dto.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(dto.cursor, 'base64').toString('utf-8'));
        if (decoded.completed !== undefined && decoded.id) {
          params.push(decoded.completed, decoded.id);
          cursorClause = `HAVING (sum(mv.completed_count) < $${params.length - 1} OR (sum(mv.completed_count) = $${params.length - 1} AND d.id > $${params.length}))`;
        }
      } catch {
        // Ignore invalid cursor
      }
    }

    params.push(limit + 1);
    const limitIdx = params.length;

    const sql = `
      SELECT
        d.id AS "doctorId",
        (p.first_name || ' ' || p.last_name) AS "doctorName",
        d.specializations,
        sum(mv.total_consultations)::int AS "totalConsultations",
        sum(mv.completed_count)::int AS "completedConsultations",
        sum(mv.cancelled_count)::int AS "cancelledConsultations",
        sum(mv.revenue_cents)::bigint AS "revenueCents",
        count(distinct s.id)::int AS "totalSlots",
        round(
          case when count(distinct s.id) > 0
               then (sum(mv.completed_count)::numeric / count(distinct s.id)::numeric) * 100
               else 0 end, 2
        )::float AS "utilizationRate"
      FROM daily_consultation_analytics_mv mv
      JOIN doctors d ON d.id = mv.doctor_id
      JOIN profiles p ON p.user_id = d.user_id
      LEFT JOIN availability_slots s ON s.doctor_id = d.id AND s.start_time >= $1::date AND s.start_time <= ($2::date + interval '1 day')
      WHERE mv.day >= $1 AND mv.day <= $2
      GROUP BY d.id, p.first_name, p.last_name, d.specializations
      ${cursorClause}
      ORDER BY sum(mv.completed_count) DESC, d.id ASC
      LIMIT $${limitIdx};
    `;

    const rows = await this.dataSource.query(sql, params);

    const hasNext = rows.length > limit;
    const doctors = hasNext ? rows.slice(0, limit) : rows;

    let next_cursor: string | null = null;
    if (hasNext) {
      const last = doctors[doctors.length - 1];
      const payload = { id: last.doctorId, completed: last.completedConsultations };
      next_cursor = Buffer.from(JSON.stringify(payload)).toString('base64');
    }

    return {
      doctors: doctors.map((r: any) => ({
        doctorId: r.doctorId,
        doctorName: r.doctorName,
        specializations: r.specializations || [],
        totalConsultations: Number(r.totalConsultations || 0),
        completedConsultations: Number(r.completedConsultations || 0),
        cancelledConsultations: Number(r.cancelledConsultations || 0),
        revenueCents: Number(r.revenueCents || 0),
        totalSlots: Number(r.totalSlots || 0),
        utilizationRate: Number(r.utilizationRate || 0),
      })),
      next_cursor,
    };
  }

  /**
   * Trigger concurrent refresh of the daily consultation analytics materialized view.
   */
  async refreshMaterializedView(): Promise<{ status: string; refreshedAt: string }> {
    this.logger.log('Refreshing daily_consultation_analytics_mv concurrently...');
    await this.dataSource.query(
      'REFRESH MATERIALIZED VIEW CONCURRENTLY daily_consultation_analytics_mv;',
    );
    this.logger.log('daily_consultation_analytics_mv refresh complete.');
    return {
      status: 'success',
      refreshedAt: new Date().toISOString(),
    };
  }
}
