import { Entity, Column, CreateDateColumn, UpdateDateColumn, PrimaryColumn, Index } from 'typeorm';

export enum SlotStatus {
  AVAILABLE = 'AVAILABLE',
  HELD = 'HELD',
  RESERVED = 'RESERVED',
  BOOKED = 'BOOKED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  BLOCKED = 'BLOCKED',
}

/**
 * Availability slots — range-partitioned by partition_month.
 * PK is (id, partition_month) per Postgres partitioning constraints.
 * TypeORM entity maps to the parent table; partitions created by migration.
 */
@Entity('availability_slots')
@Index('idx_slots_doctor_status', ['doctorId', 'status', 'partitionMonth'])
@Index('idx_slots_start_time', ['startTime', 'partitionMonth'])
export class AvailabilitySlot {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @PrimaryColumn({ type: 'date', name: 'partition_month' })
  partitionMonth!: string;

  @Column({ type: 'uuid', name: 'doctor_id' })
  doctorId!: string;

  @Column({ type: 'timestamptz', name: 'start_time' })
  startTime!: Date;

  @Column({ type: 'timestamptz', name: 'end_time' })
  endTime!: Date;

  @Column({ type: 'enum', enum: SlotStatus, default: SlotStatus.AVAILABLE })
  status!: SlotStatus;

  @Column({ type: 'uuid', nullable: true, name: 'held_by' })
  heldBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'held_until' })
  heldUntil!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
