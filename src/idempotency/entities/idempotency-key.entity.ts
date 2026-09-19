import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('idempotency_keys')
@Index('idx_idemp_user_key', ['userId', 'idempotencyKey'], { unique: true })
@Index('idx_idemp_expires', ['expiresAt'])
export class IdempotencyKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 255, name: 'idempotency_key' })
  idempotencyKey!: string;

  @Column({ type: 'varchar', length: 64, name: 'request_hash' })
  requestHash!: string;

  @Column({ type: 'smallint', name: 'response_status' })
  responseStatus!: number;

  @Column({ type: 'jsonb', name: 'response_body' })
  responseBody!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;
}
