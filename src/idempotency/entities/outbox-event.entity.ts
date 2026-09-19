import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum OutboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
}

@Entity('outbox_events')
@Index('idx_outbox_pending', ['status', 'createdAt'])
@Index('idx_outbox_aggregate', ['aggregateType', 'aggregateId'])
export class OutboxEvent {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string; // bigint returned as string by pg driver

  @Column({ type: 'varchar', length: 100, name: 'event_type' })
  eventType!: string;

  @Column({ type: 'uuid', name: 'aggregate_id' })
  aggregateId!: string;

  @Column({ type: 'varchar', length: 50, name: 'aggregate_type' })
  aggregateType!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 20, default: OutboxStatus.PENDING })
  status!: OutboxStatus;

  @Column({ type: 'smallint', default: 0, name: 'retry_count' })
  retryCount!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'processed_at' })
  processedAt!: Date | null;
}
