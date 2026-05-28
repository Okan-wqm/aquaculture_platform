import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum TenantPrincipalKind {
  USER = 'USER',
  ANONYMOUS = 'ANONYMOUS',
  SYSTEM_AI = 'SYSTEM_AI',
}

export enum TenantPrincipalSource {
  AUTH = 'AUTH',
  SYSTEM = 'SYSTEM',
  REMEDIATION = 'REMEDIATION',
}

export const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';
export const SYSTEM_AI_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Tenant-local principal projection.
 *
 * Auth-service remains the source of truth. This table exists to let
 * messaging enforce local FK constraints and represent tenant-scoped system
 * principals such as ANONYMOUS and SYSTEM_AI.
 */
@Entity('tenant_principals')
@Index('idx_tenant_principals_kind_active', ['tenantId', 'kind', 'isActive'])
export class TenantPrincipal {
  @PrimaryColumn({ type: 'uuid' })
  tenantId!: string;

  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 20 })
  kind!: TenantPrincipalKind;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'varchar', length: 20 })
  source!: TenantPrincipalSource;

  @Column({ type: 'timestamptz', nullable: true })
  lastValidatedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deactivatedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
