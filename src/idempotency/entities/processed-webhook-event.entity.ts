import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('processed_webhook_events')
@Index('idx_webhook_provider_event', ['provider', 'eventId'], { unique: true })
@Index('idx_webhook_created', ['createdAt'])
export class ProcessedWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 50 })
  provider!: string;

  @Column({ type: 'varchar', length: 255, name: 'event_id' })
  eventId!: string;

  @Column({ type: 'jsonb', name: 'response_body' })
  responseBody!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
