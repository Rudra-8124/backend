import { Entity, Column, CreateDateColumn, PrimaryColumn, Index } from 'typeorm';

/**
 * Audit logs — range-partitioned by partition_month.
 * Append-only: app DB role has INSERT only (no UPDATE/DELETE).
 * Hash chain is per-partition (see ADR-005).
 */
@Entity('audit_logs')
@Index('idx_audit_actor', ['actorId', 'partitionMonth'])
@Index('idx_audit_resource', ['resourceType', 'resourceId', 'partitionMonth'])
@Index('idx_audit_action', ['action', 'partitionMonth'])
@Index('idx_audit_created', ['createdAt', 'partitionMonth'])
export class AuditLog {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @PrimaryColumn({ type: 'date', name: 'partition_month' })
  partitionMonth!: string;

  @Column({ type: 'uuid', nullable: true, name: 'actor_id' })
  actorId!: string | null;

  @Column({ type: 'varchar', length: 100 })
  action!: string;

  @Column({ type: 'varchar', length: 100, name: 'resource_type' })
  resourceType!: string;

  @Column({ type: 'uuid', nullable: true, name: 'resource_id' })
  resourceId!: string | null;

  @Column({ type: 'inet', nullable: true, name: 'ip_address' })
  ipAddress!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'request_id' })
  requestId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 128, name: 'previous_hash' })
  previousHash!: string;

  @Column({ type: 'varchar', length: 128 })
  hash!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
