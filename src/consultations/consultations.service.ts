import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { BookConsultationDto } from './dto/book-consultation.dto';
import { CompleteConsultationDto } from './dto/complete-consultation.dto';
import { ConsultationStatus } from './entities/consultation.entity';
import { OutboxStatus } from '../idempotency/entities/outbox-event.entity';
import { ConsultationStateMachine } from './consultation-state-machine';
import { EncryptionService } from '../common/crypto/encryption.service';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class ConsultationsService {
  private readonly logger = new Logger(ConsultationsService.name);
  private readonly HOLD_DURATION_MINUTES = 5;

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryptionService: EncryptionService,
    @Inject(forwardRef(() => PaymentsService))
    private readonly paymentsService: PaymentsService,
  ) {}

  /**
   * Book a consultation for a patient.
   * Atomic single-transaction operation:
   * 1. Check patient does not have an overlapping active consultation or hold.
   * 2. Conditional UPDATE on slot (prevents double booking).
   * 3. Zero rows returned -> 409 Conflict.
   * 4. Insert consultation (PENDING_PAYMENT) and transactional outbox event.
   */
  async bookConsultation(patientId: string, dto: BookConsultationDto) {
    const { slotId, reason } = dto;

    return this.dataSource.transaction(async (manager) => {
      // 1. Verify slot exists
      const slotMeta = await manager.query(
        `SELECT id, doctor_id, start_time, end_time, status, partition_month, hold_expires_at
         FROM availability_slots
         WHERE id = $1`,
        [slotId],
      );

      if (slotMeta.length === 0) {
        throw new NotFoundException('Availability slot not found');
      }

      const slot = slotMeta[0];

      // Patient cannot hold/book two overlapping slots
      const overlappingConsultations = await manager.query(
        `SELECT id FROM consultations
         WHERE patient_id = $1
           AND status IN ('PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS')
           AND scheduled_start < $3
           AND scheduled_end > $2
         LIMIT 1`,
        [patientId, slot.start_time, slot.end_time],
      );

      if (overlappingConsultations.length > 0) {
        throw new ConflictException(
          'Patient already has an active consultation or hold overlapping this time window',
        );
      }

      // Check if patient currently holds another slot overlapping this one
      const overlappingHolds = await manager.query(
        `SELECT id FROM availability_slots
         WHERE held_by = $1
           AND status = 'HELD'
           AND id != $4
           AND (hold_expires_at > now() OR held_until > now())
           AND start_time < $3
           AND end_time > $2
         LIMIT 1`,
        [patientId, slot.start_time, slot.end_time, slotId],
      );

      if (overlappingHolds.length > 0) {
        throw new ConflictException(
          'Patient already holds another slot overlapping this time window',
        );
      }

      // 2. Atomic Conditional UPDATE — exact SQL that prevents double booking
      const holdInterval = `${this.HOLD_DURATION_MINUTES} minutes`;
      const updateResult = await manager.query(
        `UPDATE availability_slots
         SET status = 'HELD',
             held_by = $1,
             held_until = now() + interval '${holdInterval}',
             hold_expires_at = now() + interval '${holdInterval}',
             updated_at = now()
         WHERE id = $2
           AND (
             status = 'AVAILABLE'
             OR (status = 'HELD' AND (hold_expires_at < now() OR held_until < now()))
           )
         RETURNING id, partition_month, doctor_id, start_time, end_time, status, held_by, hold_expires_at`,
        [patientId, slotId],
      );

      const rows = Array.isArray(updateResult[0]) ? updateResult[0] : updateResult;

      // 3. Exactly zero rows returned -> 409 Conflict
      if (rows.length === 0) {
        throw new ConflictException({
          type: 'https://httpstatuses.io/409',
          title: 'Conflict',
          status: 409,
          detail: 'Slot is no longer available or is currently held by another user',
        });
      }

      const heldSlot = rows[0];

      // 4. Insert Consultation PENDING_PAYMENT
      const consultationId = randomUUID();
      const partitionMonth = heldSlot.partition_month;

      await manager.query(
        `INSERT INTO consultations
          (id, partition_month, patient_id, doctor_id, slot_id, slot_partition_month,
           status, version, scheduled_start, scheduled_end, reason, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, now(), now())`,
        [
          consultationId,
          partitionMonth,
          patientId,
          heldSlot.doctor_id,
          heldSlot.id,
          heldSlot.partition_month,
          ConsultationStatus.PENDING_PAYMENT,
          heldSlot.start_time,
          heldSlot.end_time,
          reason || null,
        ],
      );

      // 5. Insert Transactional Outbox event in the same transaction
      const outboxPayload = {
        consultationId,
        patientId,
        doctorId: heldSlot.doctor_id,
        slotId: heldSlot.id,
        scheduledStart: heldSlot.start_time,
        scheduledEnd: heldSlot.end_time,
        holdExpiresAt: heldSlot.hold_expires_at,
        status: ConsultationStatus.PENDING_PAYMENT,
      };

      await manager.query(
        `INSERT INTO outbox_events
          (event_type, aggregate_id, aggregate_type, payload, status, retry_count, attempts, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 0, 0, now(), now())`,
        [
          'consultation.created',
          consultationId,
          'consultation',
          JSON.stringify(outboxPayload),
          OutboxStatus.PENDING,
        ],
      );

      this.logger.log({
        msg: 'Consultation created with slot held',
        consultationId,
        patientId,
        slotId,
        holdExpiresAt: heldSlot.hold_expires_at,
      });

      return {
        id: consultationId,
        partitionMonth,
        patientId,
        doctorId: heldSlot.doctor_id,
        slotId: heldSlot.id,
        status: ConsultationStatus.PENDING_PAYMENT,
        version: 1,
        scheduledStart: heldSlot.start_time,
        scheduledEnd: heldSlot.end_time,
        reason: reason || null,
        holdExpiresAt: heldSlot.hold_expires_at,
        message:
          'Slot held successfully. Please complete payment within 5 minutes to confirm booking.',
      };
    });
  }

  private async resolveDoctorId(userId: string): Promise<string> {
    const rows = await this.dataSource.query('SELECT id FROM doctors WHERE user_id = $1', [userId]);
    if (rows.length === 0) {
      throw new ForbiddenException('Only registered doctors can perform this action');
    }
    return rows[0].id;
  }

  /**
   * Start a consultation (CONFIRMED -> IN_PROGRESS).
   * Doctor only, must be assigned doctor.
   */
  async startConsultation(userId: string, consultationId: string) {
    const doctorId = await this.resolveDoctorId(userId);

    const consult = await this.getConsultationRaw(consultationId);
    if (consult.doctor_id !== doctorId) {
      throw new ForbiddenException('You are not the assigned doctor for this consultation');
    }

    return this.dataSource.transaction(async (manager) => {
      return ConsultationStateMachine.transition(manager, consultationId, {
        targetStatus: ConsultationStatus.IN_PROGRESS,
        actorId: userId,
      });
    });
  }

  /**
   * Complete a consultation (IN_PROGRESS -> COMPLETED).
   * Doctor only, must be assigned doctor.
   * Notes are field-encrypted using AES-256-GCM.
   */
  async completeConsultation(
    userId: string,
    consultationId: string,
    dto?: CompleteConsultationDto,
  ) {
    const doctorId = await this.resolveDoctorId(userId);

    const consult = await this.getConsultationRaw(consultationId);
    if (consult.doctor_id !== doctorId) {
      throw new ForbiddenException('You are not the assigned doctor for this consultation');
    }

    let notesEncrypted: string | undefined;
    if (dto?.notes) {
      notesEncrypted = await this.encryptionService.encrypt(dto.notes);
    }

    return this.dataSource.transaction(async (manager) => {
      return ConsultationStateMachine.transition(manager, consultationId, {
        targetStatus: ConsultationStatus.COMPLETED,
        notesEncrypted,
        actorId: userId,
      });
    });
  }

  /**
   * Cancel a consultation (from PENDING_PAYMENT or CONFIRMED).
   * Allowed for: Patient owner, Assigned doctor, or Admin.
   * If CONFIRMED, triggers refund via payment provider.
   */
  async cancelConsultation(
    userId: string,
    userRole: string,
    consultationId: string,
    reason: string,
  ) {
    const consult = await this.getConsultationRaw(consultationId);

    // Ownership check
    if (userRole === 'admin') {
      // Allowed
    } else if (userRole === 'patient') {
      if (consult.patient_id !== userId) {
        throw new ForbiddenException('You do not have access to cancel this consultation');
      }
    } else if (userRole === 'doctor') {
      const doctorId = await this.resolveDoctorId(userId);
      if (consult.doctor_id !== doctorId) {
        throw new ForbiddenException('You are not the assigned doctor for this consultation');
      }
    } else {
      throw new ForbiddenException('Unauthorized role');
    }

    // If already confirmed, trigger refund
    if (consult.status === ConsultationStatus.CONFIRMED) {
      try {
        await this.paymentsService.refundConsultation(consultationId, reason);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Refund failed during consultation cancellation: ${errorMsg}`);
        // Still proceed with consultation cancellation
      }
    }

    return this.dataSource.transaction(async (manager) => {
      return ConsultationStateMachine.transition(manager, consultationId, {
        targetStatus: ConsultationStatus.CANCELLED,
        cancellationReason: reason,
        actorId: userId,
      });
    });
  }

  /**
   * Mark consultation as NO_SHOW (from CONFIRMED).
   * Doctor assigned or Admin.
   */
  async markNoShow(userId: string, userRole: string, consultationId: string) {
    const consult = await this.getConsultationRaw(consultationId);

    if (userRole === 'admin') {
      // Allowed
    } else if (userRole === 'doctor') {
      const doctorId = await this.resolveDoctorId(userId);
      if (consult.doctor_id !== doctorId) {
        throw new ForbiddenException('You are not the assigned doctor for this consultation');
      }
    } else {
      throw new ForbiddenException('Only assigned doctor or admin can mark no-show');
    }

    return this.dataSource.transaction(async (manager) => {
      return ConsultationStateMachine.transition(manager, consultationId, {
        targetStatus: ConsultationStatus.NO_SHOW,
        actorId: userId,
      });
    });
  }

  /**
   * Payment timeout compensation: cancels pending consultation and releases slot.
   */
  async handlePaymentTimeout(consultationId: string) {
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query('SELECT id, status FROM consultations WHERE id = $1', [
        consultationId,
      ]);
      if (rows.length > 0 && rows[0].status === ConsultationStatus.PENDING_PAYMENT) {
        return ConsultationStateMachine.transition(manager, consultationId, {
          targetStatus: ConsultationStatus.CANCELLED,
          cancellationReason: 'PAYMENT_TIMEOUT',
        });
      }
      return null;
    });
  }

  private async getConsultationRaw(consultationId: string) {
    const rows = await this.dataSource.query('SELECT * FROM consultations WHERE id = $1', [
      consultationId,
    ]);
    if (rows.length === 0) {
      throw new NotFoundException('Consultation not found');
    }
    return rows[0];
  }

  /**
   * Get consultation by ID with RBAC and ownership check.
   */
  async getConsultationById(userId: string, userRole: string, consultationId: string) {
    const rows = await this.dataSource.query(
      `SELECT c.*, p.first_name AS patient_first_name, p.last_name AS patient_last_name
       FROM consultations c
       LEFT JOIN profiles p ON p.user_id = c.patient_id
       WHERE c.id = $1`,
      [consultationId],
    );

    if (rows.length === 0) {
      throw new NotFoundException('Consultation not found');
    }

    const consultation = rows[0];

    // Ownership check (no IDOR)
    if (userRole === 'admin') {
      return consultation;
    }

    if (userRole === 'patient' && consultation.patient_id === userId) {
      return consultation;
    }

    if (userRole === 'doctor') {
      const doc = await this.dataSource.query('SELECT id FROM doctors WHERE user_id = $1', [
        userId,
      ]);
      if (doc.length > 0 && doc[0].id === consultation.doctor_id) {
        return consultation;
      }
    }

    throw new ForbiddenException('You do not have access to this consultation');
  }

  /**
   * List consultations for the current patient.
   */
  async listPatientConsultations(patientId: string) {
    return this.dataSource.query(
      `SELECT c.*, d.license_number, dp.first_name AS doctor_first_name, dp.last_name AS doctor_last_name
       FROM consultations c
       JOIN doctors d ON d.id = c.doctor_id
       JOIN profiles dp ON dp.user_id = d.user_id
       WHERE c.patient_id = $1
       ORDER BY c.scheduled_start DESC`,
      [patientId],
    );
  }
}
