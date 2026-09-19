import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('doctors')
export class Doctor {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', unique: true, name: 'user_id' })
  @Index('idx_doctors_user_id', { unique: true })
  userId!: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @Column({ type: 'varchar', length: 255, unique: true, name: 'license_number' })
  @Index('idx_doctors_license', { unique: true })
  licenseNumber!: string;

  @Column({ type: 'text', array: true, default: '{}' })
  specializations!: string[];

  @Column({ type: 'int', name: 'experience_years' })
  experienceYears!: number;

  @Column({ type: 'int', name: 'fee_cents' })
  feeCents!: number;

  @Column({ type: 'boolean', default: false, name: 'is_verified' })
  isVerified!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
