import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('refresh_tokens')
@Index('idx_rt_user', ['userId'])
@Index('idx_rt_family', ['familyId'])
@Index('idx_rt_expires', ['expiresAt'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'varchar', length: 255, unique: true, name: 'token_hash' })
  @Index('idx_rt_token_hash', { unique: true })
  tokenHash!: string;

  @Column({ type: 'varchar', length: 64, name: 'family_id' })
  familyId!: string;

  @Column({ type: 'boolean', default: false, name: 'is_revoked' })
  isRevoked!: boolean;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
