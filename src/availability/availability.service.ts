import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID, createHash } from 'crypto';
import { CreateSlotDto } from './dto/create-slot.dto';
import { BulkCreateSlotsDto } from './dto/bulk-create-slots.dto';
import { QuerySlotsDto } from './dto/query-slots.dto';
import { SlotStatus } from './entities/availability-slot.entity';
import { CacheService } from '../common/cache/cache.service';

@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly cacheService: CacheService,
  ) {}

  /**
   * Convert string to 32-bit integer for pg_advisory_xact_lock.
   */
  private hashToInt(str: string): number {
    const h = createHash('md5').update(str).digest();
    return h.readInt32BE(0);
  }

  /**
   * Derive the YYYY-MM-01 partition month string from a Date.
   */
  private getPartitionMonth(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}-01`;
  }

  /**
   * Create a single availability slot for a doctor.
   * Enforces no-overlap check under a per-doctor advisory transaction lock.
   */
  async createSlot(doctorId: string, dto: CreateSlotDto) {
    const startTime = new Date(dto.startTime);
    const durationMs = (dto.durationMinutes || 30) * 60 * 1000;
    const endTime = new Date(startTime.getTime() + durationMs);

    if (isNaN(startTime.getTime())) {
      throw new BadRequestException('Invalid start time');
    }

    const partitionMonth = this.getPartitionMonth(startTime);

    return this.dataSource.transaction(async (manager) => {
      // Per-doctor advisory transaction lock
      await manager.query('SELECT pg_advisory_xact_lock($1)', [this.hashToInt(doctorId)]);

      // Service-level overlap check (exclusion constraints are not supported on partitioned tables in PG)
      const overlaps = await manager.query(
        `SELECT id FROM availability_slots
         WHERE doctor_id = $1
           AND status != 'CANCELLED'
           AND start_time < $3
           AND end_time > $2
         LIMIT 1`,
        [doctorId, startTime, endTime],
      );

      if (overlaps.length > 0) {
        throw new ConflictException('Slot overlaps with an existing slot for this doctor');
      }

      const id = randomUUID();
      const rows = await manager.query(
        `INSERT INTO availability_slots
          (id, partition_month, doctor_id, start_time, end_time, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'AVAILABLE', now(), now())
         RETURNING id, partition_month, doctor_id, start_time, end_time, status, created_at`,
        [id, partitionMonth, doctorId, startTime, endTime],
      );

      this.logger.log({ msg: 'Slot created', slotId: id, doctorId, startTime, endTime });
      await this.cacheService.invalidateNamespace('search:doctors');
      return {
        id: rows[0].id,
        partitionMonth: rows[0].partition_month,
        doctorId: rows[0].doctor_id,
        doctor_id: rows[0].doctor_id,
        startTime: rows[0].start_time,
        endTime: rows[0].end_time,
        status: rows[0].status,
        createdAt: rows[0].created_at,
      };
    });
  }

  /**
   * Bulk generate slots from a weekly schedule within a date range.
   */
  async bulkCreateSlots(doctorId: string, dto: BulkCreateSlotsDto) {
    // 1. Get doctor profile timezone if not provided
    let timezone = dto.timezone;
    if (!timezone) {
      const profile = await this.dataSource.query(
        `SELECT p.timezone FROM profiles p
         JOIN doctors d ON d.user_id = p.user_id
         WHERE d.id = $1 OR d.user_id = $1`,
        [doctorId],
      );
      timezone = profile.length > 0 && profile[0].timezone ? profile[0].timezone : 'UTC';
    }

    const start = new Date(dto.startDate + 'T00:00:00Z');
    const end = new Date(dto.endDate + 'T23:59:59Z');

    if (start > end) {
      throw new BadRequestException('startDate must be before or equal to endDate');
    }

    // Generate candidate slots
    const candidateSlots: Array<{ startTime: Date; endTime: Date; partitionMonth: string }> = [];
    const current = new Date(start);

    while (current <= end) {
      const dayOfWeek = current.getUTCDay();
      const scheduleItems = dto.schedule.filter((s) => s.dayOfWeek === dayOfWeek);

      for (const item of scheduleItems) {
        let slotStart = new Date(current);
        slotStart.setUTCHours(item.startHour, item.startMinute, 0, 0);

        const windowEnd = new Date(current);
        windowEnd.setUTCHours(item.endHour, item.endMinute, 0, 0);

        const durationMs = item.slotDurationMinutes * 60 * 1000;

        while (slotStart.getTime() + durationMs <= windowEnd.getTime()) {
          const slotEnd = new Date(slotStart.getTime() + durationMs);
          candidateSlots.push({
            startTime: new Date(slotStart),
            endTime: slotEnd,
            partitionMonth: this.getPartitionMonth(slotStart),
          });
          slotStart = slotEnd;
        }
      }

      current.setUTCDate(current.getUTCDate() + 1);
    }

    if (candidateSlots.length === 0) {
      return { count: 0, slots: [] };
    }

    return this.dataSource.transaction(async (manager) => {
      // Per-doctor advisory transaction lock
      await manager.query('SELECT pg_advisory_xact_lock($1)', [this.hashToInt(doctorId)]);

      const createdSlots = [];

      for (const slot of candidateSlots) {
        // Overlap check per candidate
        const overlaps = await manager.query(
          `SELECT id FROM availability_slots
           WHERE doctor_id = $1
             AND status != 'CANCELLED'
             AND start_time < $3
             AND end_time > $2
           LIMIT 1`,
          [doctorId, slot.startTime, slot.endTime],
        );

        if (overlaps.length === 0) {
          const id = randomUUID();
          const rows = await manager.query(
            `INSERT INTO availability_slots
              (id, partition_month, doctor_id, start_time, end_time, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'AVAILABLE', now(), now())
             RETURNING id, partition_month, doctor_id, start_time, end_time, status, created_at`,
            [id, slot.partitionMonth, doctorId, slot.startTime, slot.endTime],
          );
          createdSlots.push(rows[0]);
        }
      }

      this.logger.log({ msg: 'Bulk slots created', doctorId, count: createdSlots.length });
      await this.cacheService.invalidateNamespace('search:doctors');
      return { count: createdSlots.length, slots: createdSlots };
    });
  }

  /**
   * Cancel an unbooked slot. Doctors can only cancel their own AVAILABLE slots.
   */
  async cancelSlot(doctorId: string, slotId: string) {
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query(
        `SELECT id, status, doctor_id, partition_month FROM availability_slots
         WHERE id = $1`,
        [slotId],
      );

      if (rows.length === 0) {
        throw new NotFoundException('Slot not found');
      }

      const slot = rows[0];

      if (slot.doctor_id !== doctorId) {
        throw new NotFoundException('Slot not found or belongs to another doctor');
      }

      if (slot.status !== SlotStatus.AVAILABLE) {
        throw new BadRequestException(
          `Cannot cancel slot with status ${slot.status}. Only AVAILABLE slots can be cancelled.`,
        );
      }

      await manager.query(
        `UPDATE availability_slots
         SET status = 'CANCELLED', updated_at = now()
         WHERE id = $1 AND partition_month = $2`,
        [slot.id, slot.partition_month],
      );

      this.logger.log({ msg: 'Slot cancelled', slotId, doctorId });
      await this.cacheService.invalidateNamespace('search:doctors');
      return { message: 'Slot cancelled successfully' };
    });
  }

  /**
   * Query slots for a doctor with date range and status filters.
   */
  async getDoctorSlots(doctorId: string, query: QuerySlotsDto) {
    const params: unknown[] = [doctorId];
    let sql = `SELECT id, partition_month, doctor_id, start_time, end_time, status, held_until, hold_expires_at, created_at
               FROM availability_slots
               WHERE doctor_id = $1`;

    if (query.status) {
      params.push(query.status);
      sql += ` AND status = $${params.length}`;
    }

    if (query.startDate) {
      params.push(new Date(query.startDate));
      sql += ` AND start_time >= $${params.length}`;
    }

    if (query.endDate) {
      params.push(new Date(query.endDate));
      sql += ` AND start_time <= $${params.length}`;
    }

    sql += ` ORDER BY start_time ASC`;

    return this.dataSource.query(sql, params);
  }

  /**
   * Release expired holds and cancel associated pending consultations (worker/cron background job).
   */
  async releaseExpiredHolds(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const updateResult = await manager.query(
        `UPDATE availability_slots
         SET status = 'AVAILABLE', held_by = NULL, held_until = NULL, hold_expires_at = NULL, updated_at = now()
         WHERE status = 'HELD'
           AND (hold_expires_at < now() OR held_until < now())
         RETURNING id, partition_month, held_by`,
      );

      const expiredSlots = Array.isArray(updateResult[0]) ? updateResult[0] : updateResult;

      if (expiredSlots.length === 0) {
        return 0;
      }

      const slotIds = expiredSlots.map((s: { id: string }) => s.id);
      await manager.query(
        `UPDATE consultations
         SET status = 'CANCELLED', cancellation_reason = 'HOLD_EXPIRED', updated_at = now()
         WHERE slot_id = ANY($1) AND status = 'PENDING_PAYMENT'`,
        [slotIds],
      );

      this.logger.log({
        msg: 'Expired holds released and consultations cancelled',
        count: expiredSlots.length,
      });
      await this.cacheService.invalidateNamespace('search:doctors');
      return expiredSlots.length;
    });
  }
}
