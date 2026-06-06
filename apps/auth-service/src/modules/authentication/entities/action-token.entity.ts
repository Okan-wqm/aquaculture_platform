import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum ActionTokenPurpose {
  INVITATION = 'INVITATION',
  PASSWORD_RESET = 'PASSWORD_RESET',
}

export enum ActionTokenStatus {
  ACTIVE = 'ACTIVE',
  CONSUMED = 'CONSUMED',
  REVOKED = 'REVOKED',
  EXPIRED = 'EXPIRED',
}

@Entity('action_tokens', { schema: 'auth' })
@Index('IDX_action_tokens_tenant_purpose', ['tenantId', 'purpose'])
@Index('IDX_action_tokens_user_purpose', ['userId', 'purpose'])
@Index('IDX_action_tokens_token_hash', ['tokenHash'])
export class ActionToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  purpose!: ActionTokenPurpose;

  @Column({ type: 'uuid', nullable: true })
  tenantId?: string | null;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 128 })
  tokenHash!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  deliveryIdempotencyKey?: string | null;

  @Column({ type: 'varchar', length: 32, default: ActionTokenStatus.ACTIVE })
  status!: ActionTokenStatus;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  consumedAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt?: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  auditMetadata?: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  isActive(now: Date = new Date()): boolean {
    return this.status === ActionTokenStatus.ACTIVE && this.expiresAt > now;
  }
}
