import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum PaymentStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
}

@Entity('payments')
@Index('idx_pay_consultation', ['consultationId', 'consultationPartitionMonth'])
@Index('idx_pay_status', ['status'])
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'consultation_id' })
  consultationId!: string;

  @Column({ type: 'date', name: 'consultation_partition_month' })
  consultationPartitionMonth!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, unique: true, name: 'payment_intent_id' })
  @Index('idx_pay_intent', { unique: true })
  paymentIntentId!: string | null;

  @Column({ type: 'int', name: 'amount_cents' })
  amountCents!: number;

  @Column({ type: 'varchar', length: 3, default: 'INR' })
  currency!: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  status!: PaymentStatus;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'provider_reference' })
  providerReference!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
