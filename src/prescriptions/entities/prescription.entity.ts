import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Prescriptions — not partitioned (accessed via consultation_id).
 * All clinical fields are AES-256-GCM encrypted.
 */
@Entity('prescriptions')
@Index('idx_rx_consultation', ['consultationId', 'consultationPartitionMonth'])
@Index('idx_rx_patient', ['patientId'])
export class Prescription {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'consultation_id' })
  consultationId!: string;

  @Column({ type: 'date', name: 'consultation_partition_month' })
  consultationPartitionMonth!: string;

  @Column({ type: 'uuid', name: 'doctor_id' })
  doctorId!: string;

  @Column({ type: 'uuid', name: 'patient_id' })
  patientId!: string;

  @Column({ type: 'text', name: 'medications_encrypted' })
  medicationsEncrypted!: string;

  @Column({ type: 'text', name: 'diagnosis_encrypted' })
  diagnosisEncrypted!: string;

  @Column({ type: 'text', nullable: true, name: 'notes_encrypted' })
  notesEncrypted!: string | null;

  @Column({ type: 'varchar', length: 20, name: 'encryption_key_id' })
  encryptionKeyId!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
