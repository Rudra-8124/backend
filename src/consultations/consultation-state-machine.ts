import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Consultation, ConsultationStatus } from './entities/consultation.entity';

export interface TransitionContext {
  targetStatus: ConsultationStatus;
  expectedVersion?: number;
  cancellationReason?: string;
  notesEncrypted?: string;
  paymentIntentId?: string;
  actorId?: string;
}

export class ConsultationStateMachine {
  /**
   * Allowed state transitions map.
   * Key: Source status
   * Value: Allowed destination statuses
   */
  private static readonly ALLOWED_TRANSITIONS: Record<ConsultationStatus, Set<ConsultationStatus>> =
    {
      [ConsultationStatus.PENDING_PAYMENT]: new Set([
        ConsultationStatus.CONFIRMED,
        ConsultationStatus.CANCELLED,
      ]),
      [ConsultationStatus.CONFIRMED]: new Set([
        ConsultationStatus.IN_PROGRESS,
        ConsultationStatus.CANCELLED,
        ConsultationStatus.NO_SHOW,
      ]),
      [ConsultationStatus.IN_PROGRESS]: new Set([
        ConsultationStatus.COMPLETED,
        ConsultationStatus.CONFIRMED,
      ]),
      [ConsultationStatus.COMPLETED]: new Set([]),
      [ConsultationStatus.CANCELLED]: new Set([]),
      [ConsultationStatus.NO_SHOW]: new Set([]),
    };

  /**
   * Check if a transition is structurally valid.
   */
  public static canTransition(from: ConsultationStatus, to: ConsultationStatus): boolean {
    const allowed = this.ALLOWED_TRANSITIONS[from];
    return allowed ? allowed.has(to) : false;
  }

  /**
   * Execute an atomic state transition with optimistic locking (version column).
   * Must be called within a database transaction.
   * Throws 409 ConflictException on illegal transition or version mismatch.
   */
  public static async transition(
    manager: EntityManager,
    consultationId: string,
    context: TransitionContext,
  ): Promise<Consultation> {
    // 1. Fetch current consultation row
    const rows = await manager.query(
      `SELECT id, partition_month, patient_id, doctor_id, slot_id, slot_partition_month,
              status, version, cancellation_reason, notes_encrypted, payment_intent_id,
              scheduled_start, scheduled_end, created_at, updated_at
       FROM consultations
       WHERE id = $1`,
      [consultationId],
    );

    if (!rows || rows.length === 0) {
      throw new ConflictException(`Consultation ${consultationId} not found`);
    }

    const current = rows[0] as Consultation;
    const currentStatus = current.status as ConsultationStatus;
    const targetStatus = context.targetStatus;

    // 2. Validate transition
    if (!this.canTransition(currentStatus, targetStatus)) {
      throw new ConflictException(
        `Illegal consultation status transition from '${currentStatus}' to '${targetStatus}'`,
      );
    }

    // 3. Check expected version if provided
    const versionToCheck = context.expectedVersion ?? current.version;

    // 4. Atomic conditional update with version increment
    const updateResult = await manager.query(
      `UPDATE consultations
       SET status = $1,
           version = version + 1,
           cancellation_reason = COALESCE($2, cancellation_reason),
           notes_encrypted = COALESCE($3, notes_encrypted),
           payment_intent_id = COALESCE($4, payment_intent_id),
           updated_at = now()
       WHERE id = $5 AND version = $6
       RETURNING id, partition_month, patient_id, doctor_id, slot_id, slot_partition_month,
                 status, version, cancellation_reason, notes_encrypted, payment_intent_id,
                 scheduled_start, scheduled_end, created_at, updated_at`,
      [
        targetStatus,
        context.cancellationReason || null,
        context.notesEncrypted || null,
        context.paymentIntentId || null,
        consultationId,
        versionToCheck,
      ],
    );

    const updatedRows = Array.isArray(updateResult[0]) ? updateResult[0] : updateResult;
    if (!updatedRows || updatedRows.length === 0) {
      throw new ConflictException(
        `Consultation ${consultationId} state transition conflict (optimistic lock mismatch or concurrent update)`,
      );
    }

    const raw = updatedRows[0] as any;
    const slotId = raw.slot_id || raw.slotId;
    const patientId = raw.patient_id || raw.patientId;
    const doctorId = raw.doctor_id || raw.doctorId;
    const slotPartitionMonth = raw.slot_partition_month || raw.slotPartitionMonth;
    const cancellationReason = raw.cancellation_reason || raw.cancellationReason;
    const notesEncrypted = raw.notes_encrypted || raw.notesEncrypted;
    const paymentIntentId = raw.payment_intent_id || raw.paymentIntentId;

    // 5. Update slot state in lockstep
    await this.syncSlotState(manager, slotId, targetStatus);

    // 6. Record outbox event in same transaction
    await manager.query(
      `INSERT INTO outbox_events
       (event_type, aggregate_id, aggregate_type, payload, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'PENDING', now(), now())`,
      [
        `consultation.${targetStatus.toLowerCase()}`,
        raw.id,
        'consultation',
        JSON.stringify({
          consultationId: raw.id,
          previousStatus: currentStatus,
          status: targetStatus,
          version: raw.version,
          patientId,
          doctorId,
          slotId,
          cancellationReason,
          actorId: context.actorId,
        }),
      ],
    );

    return {
      id: raw.id,
      partitionMonth: raw.partition_month,
      patientId,
      doctorId,
      slotId,
      slotPartitionMonth,
      status: raw.status as ConsultationStatus,
      version: raw.version,
      cancellationReason,
      notesEncrypted,
      paymentIntentId,
      scheduledStart: raw.scheduled_start,
      scheduledEnd: raw.scheduled_end,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    } as Consultation;
  }

  private static async syncSlotState(
    manager: EntityManager,
    slotId: string,
    targetStatus: ConsultationStatus,
  ): Promise<void> {
    switch (targetStatus) {
      case ConsultationStatus.CONFIRMED:
        await manager.query(
          `UPDATE availability_slots
           SET status = 'BOOKED', updated_at = now()
           WHERE id = $1`,
          [slotId],
        );
        break;

      case ConsultationStatus.CANCELLED:
        await manager.query(
          `UPDATE availability_slots
           SET status = 'AVAILABLE',
               held_by = NULL,
               held_until = NULL,
               hold_expires_at = NULL,
               updated_at = now()
           WHERE id = $1`,
          [slotId],
        );
        break;

      case ConsultationStatus.COMPLETED:
      case ConsultationStatus.NO_SHOW:
        await manager.query(
          `UPDATE availability_slots
           SET status = 'COMPLETED', updated_at = now()
           WHERE id = $1`,
          [slotId],
        );
        break;

      default:
        // PENDING_PAYMENT or IN_PROGRESS do not alter slot status
        break;
    }
  }
}
