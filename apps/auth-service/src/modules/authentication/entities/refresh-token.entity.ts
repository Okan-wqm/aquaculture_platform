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
import { Tenant } from '../../tenant/entities/tenant.entity';

@Entity('refresh_tokens', { schema: 'auth' })
@Index('IDX_refresh_tokens_user_revoked', ['userId', 'isRevoked'])
@Index('IDX_refresh_tokens_token', ['token'], { unique: true })
@Index('IDX_refresh_tokens_expires', ['expiresAt'])
@Index('IDX_refresh_tokens_tenant', ['tenantId'])
@Index('IDX_refresh_tokens_family', ['familyId'])
@Index('IDX_refresh_tokens_token_id', ['tokenId'], {
  unique: true,
  where: '"tokenId" IS NOT NULL',
})
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  token!: string;

  /**
   * Non-secret lookup identity embedded into the rolling-compatible opaque
   * transport. New tokens resolve exactly one row without scanning bcrypt
   * hashes; NULL preserves bounded legacy-token compatibility during rollout.
   */
  @Column({ type: 'uuid', nullable: true })
  tokenId?: string | null;

  @Column({ type: 'uuid' })
  userId!: string;

  /**
   * SECURITY (SEC-MEDIUM-003): rotation lineage id. A fresh login starts a
   * NEW family; every rotation carries the SAME familyId forward. On
   * reuse-detection the revocation is scoped to the suspect token's family
   * (not the whole user) so a single stale-cookie replay does not nuke all
   * of a user's other devices, and the emitted SecurityEvent carries a true
   * family-id for incident correlation.
   */
  @Column({ type: 'uuid', nullable: true })
  familyId?: string | null;

  /**
   * "Remember me" persistence flag. Set at fresh login from the client's choice
   * and carried forward on every rotation (like familyId) so a remembered
   * session stays persistent across silent refreshes. The resolver reads it to
   * branch the refresh-cookie maxAge; token.service extends this row's expiresAt
   * to the remember-me TTL when true so the persistent cookie never outlives it.
   */
  @Column({ type: 'boolean', default: false })
  rememberMe!: boolean;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  // DATA-MEDIUM-002: deliberately nullable. A SUPER_ADMIN / platform actor has
  // NO tenant, so its refresh tokens legitimately carry NULL tenantId (mirrors
  // auth.users.tenantId's documented platform-actor exception). A DB constraint
  // cannot express "non-null unless the owner is SUPER_ADMIN" (cross-table), so
  // the application contract sets tenantId for every tenant-scoped session.
  @Column({ type: 'uuid', nullable: true })
  tenantId?: string | null;

  @ManyToOne(() => Tenant, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Tenant | null;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'boolean', default: false })
  isRevoked!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt?: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  revokedReason?: string | null;

  /** First-writer marker for idempotent refresh-token reuse containment. */
  @Column({ type: 'timestamptz', nullable: true })
  reuseContainedAt?: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent?: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  ipAddress?: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  deviceId?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  isExpired(): boolean {
    return this.expiresAt < new Date();
  }

  isValid(): boolean {
    return !this.isRevoked && !this.isExpired();
  }
}
