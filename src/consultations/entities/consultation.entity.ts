import { Entity, Column, CreateDateColumn, UpdateDateColumn, PrimaryColumn, Index } from 'typeorm';

export enum ConsultationStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  CONFIRMED = 'CONFIRMED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  NO_SHOW = 'NO_SHOW',
}

/**
 * Consultations — range-partitioned by partition_month.
 * PK is (id, partition_month).
 */
@Entity('consultations')
@Index('idx_consult_patient', ['patientId', 'partitionMonth', 'status'])
@Index('idx_consult_doctor', ['doctorId', 'partitionMonth', 'status'])
@Index('idx_consult_status_created', ['status', 'createdAt', 'partitionMonth'])
export class Consultation {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @PrimaryColumn({ type: 'date', name: 'partition_month' })
  partitionMonth!: string;

  @Column({ type: 'uuid', name: 'patient_id' })
  patientId!: string;

  @Column({ type: 'uuid', name: 'doctor_id' })
  doctorId!: string;

  @Column({ type: 'uuid', name: 'slot_id' })
  slotId!: string;

  @Column({ type: 'date', name: 'slot_partition_month' })
  slotPartitionMonth!: string;

  @Column({ type: 'enum', enum: ConsultationStatus, default: ConsultationStatus.PENDING_PAYMENT })
  status!: ConsultationStatus;

  @Column({ type: 'timestamptz', name: 'scheduled_start' })
  scheduledStart!: Date;

  @Column({ type: 'timestamptz', name: 'scheduled_end' })
  scheduledEnd!: Date;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'text', nullable: true, name: 'notes_encrypted' })
  notesEncrypted!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true, name: 'encryption_key_id' })
  encryptionKeyId!: string | null;

  @Column({ type: 'text', nullable: true, name: 'cancellation_reason' })
  cancellationReason!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'payment_intent_id' })
  paymentIntentId!: string | null;

  @Column({ type: 'int', default: 1 })
  version!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
