import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum IdempotencyStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

@Entity('idempotency_keys')
@Index('idx_idemp_user_endpoint_key', ['userId', 'endpoint', 'idempotencyKey'], { unique: true })
@Index('idx_idemp_status', ['status'])
@Index('idx_idemp_expires', ['expiresAt'])
export class IdempotencyKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  endpoint!: string;

  @Column({ type: 'varchar', length: 255, name: 'idempotency_key' })
  idempotencyKey!: string;

  @Column({ type: 'varchar', length: 64, name: 'request_hash' })
  requestHash!: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: IdempotencyStatus.IN_PROGRESS,
  })
  status!: IdempotencyStatus;

  @Column({ type: 'smallint', nullable: true, name: 'response_status' })
  responseStatus!: number | null;

  @Column({ type: 'jsonb', nullable: true, name: 'response_body' })
  responseBody!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;
}
