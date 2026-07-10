import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Per-user AI consent. Users must explicitly opt-in to AI message analysis.
 * GDPR-compliant: no AI processing unless both tenant enabled AND user consented.
 */
@Entity('user_ai_consents')
@Index('uq_user_ai_consent_tenant_user', ['tenantId', 'userId'], { unique: true })
export class UserAiConsent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'boolean', default: false })
  consented!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  consentedAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
