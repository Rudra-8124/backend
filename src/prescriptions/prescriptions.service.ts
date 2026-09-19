import {
  Injectable,
  ForbiddenException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { CreatePrescriptionDto } from './dto/create-prescription.dto';
import { EncryptionService } from '../common/crypto/encryption.service';
import { AuditService } from '../audit/audit.service';
import { ConsultationStatus } from '../consultations/entities/consultation.entity';

export interface AuditReqInfo {
  ip?: string | null;
  requestId?: string | null;
}

@Injectable()
export class PrescriptionsService {
  private readonly logger = new Logger(PrescriptionsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryptionService: EncryptionService,
    private readonly auditService: AuditService,
  ) {}

  private async resolveDoctorId(userId: string): Promise<string> {
    const rows = await this.dataSource.query('SELECT id FROM doctors WHERE user_id = $1', [userId]);
    if (rows.length === 0) {
      throw new ForbiddenException('Only registered doctors can prescribe medications');
    }
    return rows[0].id;
  }

  /**
   * Create a prescription:
   * - Only the assigned doctor
   * - Only for IN_PROGRESS or COMPLETED consultations (409 if not)
   * - Content encrypted with EncryptionService (AES-256-GCM)
   * - Audit log recorded for PHI write
   */
  async createPrescription(
    userId: string,
    consultationId: string,
    dto: CreatePrescriptionDto,
    reqInfo?: AuditReqInfo,
  ) {
    const doctorId = await this.resolveDoctorId(userId);

    // 1. Fetch consultation
    const consultRows = await this.dataSource.query(
      `SELECT id, partition_month, doctor_id, patient_id, status
       FROM consultations
       WHERE id = $1`,
      [consultationId],
    );

    if (consultRows.length === 0) {
      throw new NotFoundException(`Consultation ${consultationId} not found`);
    }

    const consult = consultRows[0];

    // 2. Verify doctor assignment
    if (consult.doctor_id !== doctorId) {
      throw new ForbiddenException(
        'Only the assigned doctor for this consultation can issue a prescription',
      );
    }

    // 3. Verify consultation state (only IN_PROGRESS or COMPLETED)
    if (
      consult.status !== ConsultationStatus.IN_PROGRESS &&
      consult.status !== ConsultationStatus.COMPLETED
    ) {
      throw new ConflictException(
        `Prescription can only be issued for IN_PROGRESS or COMPLETED consultations (current status: ${consult.status})`,
      );
    }

    // 4. Encrypt clinical fields (PHI)
    const medicationsEncrypted = await this.encryptionService.encrypt(
      JSON.stringify(dto.medications),
    );
    const diagnosisEncrypted = await this.encryptionService.encrypt(dto.diagnosis);
    const notesEncrypted = dto.notes ? await this.encryptionService.encrypt(dto.notes) : null;
    const keyId = this.encryptionService.getCurrentKeyId();

    const prescriptionId = randomUUID();

    // 5. Insert encrypted prescription into DB
    await this.dataSource.query(
      `INSERT INTO prescriptions
       (id, consultation_id, consultation_partition_month, doctor_id, patient_id,
        medications_encrypted, diagnosis_encrypted, notes_encrypted, encryption_key_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [
        prescriptionId,
        consult.id,
        consult.partition_month,
        doctorId,
        consult.patient_id,
        medicationsEncrypted,
        diagnosisEncrypted,
        notesEncrypted,
        keyId,
      ],
    );

    // 6. Record PHI write in audit log
    await this.auditService.log({
      actorId: userId,
      action: 'PRESCRIPTION_CREATED',
      resourceType: 'prescription',
      resourceId: prescriptionId,
      ipAddress: reqInfo?.ip,
      requestId: reqInfo?.requestId,
      metadata: {
        consultationId,
        patientId: consult.patient_id,
        doctorId,
      },
    });

    this.logger.log({
      msg: 'Prescription created and encrypted',
      prescriptionId,
      consultationId,
    });

    return {
      id: prescriptionId,
      consultationId,
      doctorId,
      patientId: consult.patient_id,
      medications: dto.medications,
      diagnosis: dto.diagnosis,
      notes: dto.notes || null,
      createdAt: new Date(),
    };
  }

  /**
   * Get prescription by ID (decrypted):
   * - Only assigned doctor, patient owner, or admin
   * - Decrypted in-memory using EncryptionService
   * - Audit log recorded for PHI read
   */
  async getPrescriptionById(
    userId: string,
    userRole: string,
    prescriptionId: string,
    reqInfo?: AuditReqInfo,
  ) {
    const rows = await this.dataSource.query(`SELECT * FROM prescriptions WHERE id = $1`, [
      prescriptionId,
    ]);

    if (rows.length === 0) {
      throw new NotFoundException(`Prescription ${prescriptionId} not found`);
    }

    const rx = rows[0];
    await this.verifyAccess(userId, userRole, rx.patient_id, rx.doctor_id);

    // Decrypt fields
    const decrypted = await this.decryptPrescription(rx);

    // Record PHI read in audit log
    await this.auditService.log({
      actorId: userId,
      action: 'PRESCRIPTION_READ',
      resourceType: 'prescription',
      resourceId: prescriptionId,
      ipAddress: reqInfo?.ip,
      requestId: reqInfo?.requestId,
      metadata: { consultationId: rx.consultation_id },
    });

    return decrypted;
  }

  /**
   * List decrypted prescriptions for a consultation:
   * - Only assigned doctor, patient owner, or admin
   * - Audit log recorded for PHI read
   */
  async getConsultationPrescriptions(
    userId: string,
    userRole: string,
    consultationId: string,
    reqInfo?: AuditReqInfo,
  ) {
    const consultRows = await this.dataSource.query(
      `SELECT id, patient_id, doctor_id FROM consultations WHERE id = $1`,
      [consultationId],
    );

    if (consultRows.length === 0) {
      throw new NotFoundException(`Consultation ${consultationId} not found`);
    }

    const consult = consultRows[0];
    await this.verifyAccess(userId, userRole, consult.patient_id, consult.doctor_id);

    const rxRows = await this.dataSource.query(
      `SELECT * FROM prescriptions WHERE consultation_id = $1 ORDER BY created_at ASC`,
      [consultationId],
    );

    const results = [];
    for (const rx of rxRows) {
      const decrypted = await this.decryptPrescription(rx);
      results.push(decrypted);

      // Record PHI read
      await this.auditService.log({
        actorId: userId,
        action: 'PRESCRIPTION_READ',
        resourceType: 'prescription',
        resourceId: rx.id,
        ipAddress: reqInfo?.ip,
        requestId: reqInfo?.requestId,
        metadata: { consultationId },
      });
    }

    return results;
  }

  private async verifyAccess(
    userId: string,
    userRole: string,
    patientId: string,
    doctorId: string,
  ): Promise<void> {
    if (userRole === 'admin') {
      return;
    }

    if (userRole === 'patient' && patientId === userId) {
      return;
    }

    if (userRole === 'doctor') {
      const docRows = await this.dataSource.query('SELECT id FROM doctors WHERE user_id = $1', [
        userId,
      ]);
      if (docRows.length > 0 && docRows[0].id === doctorId) {
        return;
      }
    }

    throw new ForbiddenException('You do not have permission to access this prescription');
  }

  private async decryptPrescription(rx: any) {
    let medications: unknown[] = [];
    try {
      const medsStr = await this.encryptionService.decrypt(rx.medications_encrypted);
      medications = JSON.parse(medsStr);
    } catch (err) {
      this.logger.error(`Failed to decrypt medications for prescription ${rx.id}: ${err}`);
    }

    let diagnosis = '';
    try {
      diagnosis = await this.encryptionService.decrypt(rx.diagnosis_encrypted);
    } catch (err) {
      this.logger.error(`Failed to decrypt diagnosis for prescription ${rx.id}: ${err}`);
    }

    let notes: string | null = null;
    if (rx.notes_encrypted) {
      try {
        notes = await this.encryptionService.decrypt(rx.notes_encrypted);
      } catch (err) {
        this.logger.error(`Failed to decrypt notes for prescription ${rx.id}: ${err}`);
      }
    }

    return {
      id: rx.id,
      consultationId: rx.consultation_id,
      doctorId: rx.doctor_id,
      patientId: rx.patient_id,
      medications,
      diagnosis,
      notes,
      createdAt: rx.created_at,
    };
  }
}
