import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { ConsentType } from '../../interfaces';

/**
 * User Consent Entity
 *
 * Stores user consent records for GDPR/CCPA compliance.
 * Each consent is versioned to track changes over time.
 */
@Entity('user_consents')
@Index('IDX_consent_user', ['userId'])
@Index('IDX_consent_tenant', ['tenantId'])
@Index('IDX_consent_type', ['consentType'])
@Index('IDX_consent_user_type', ['userId', 'consentType'])
export class UserConsent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'uuid', nullable: true })
  tenantId?: string | null;

  @Column({
    type: 'varchar',
    length: 50,
  })
  consentType!: ConsentType;

  @Column({ type: 'boolean' })
  granted!: boolean;

  @Column({ type: 'varchar', length: 50 })
  version!: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  ipAddress?: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent?: string | null;

  @Column({ type: 'timestamp', nullable: true })
  expiresAt?: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  withdrawalReason?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  isActive(): boolean {
    if (!this.granted) return false;
    if (this.expiresAt && this.expiresAt < new Date()) return false;
    return true;
  }
}
