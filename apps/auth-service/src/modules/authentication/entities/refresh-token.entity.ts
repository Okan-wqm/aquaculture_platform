import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { User } from './user.entity';

@Entity('refresh_tokens')
@Index('IDX_refresh_tokens_user_revoked', ['userId', 'isRevoked'])
@Index('IDX_refresh_tokens_token', ['token'], { unique: true })
@Index('IDX_refresh_tokens_expires', ['expiresAt'])
@Index('IDX_refresh_tokens_tenant', ['tenantId'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  token: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid', nullable: true })
  tenantId: string | null;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({ type: 'boolean', default: false })
  isRevoked: boolean;

  @Column({ type: 'timestamp', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  revokedReason: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  ipAddress: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  deviceId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  isExpired(): boolean {
    return this.expiresAt < new Date();
  }

  isValid(): boolean {
    return !this.isRevoked && !this.isExpired();
  }
}
