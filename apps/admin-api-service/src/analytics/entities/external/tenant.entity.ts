/**
 * Tenant Entity (Read-only reference)
 *
 * This is a read-only view of the tenant table owned by auth-service.
 * Used for cross-service analytics queries in the shared database.
 * DO NOT modify - source of truth is auth-service.
 */

import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index, ViewEntity } from 'typeorm';

// DBR-HIGH-003 cure: canonical TenantPlan SSoT lives in event-contracts.
// Pre-fix this analytics-side mirror used UPPERCASE values ('TRIAL',
// 'STARTER', ...) which NEVER matched the actual auth.tenants column
// (lowercase) — every analytics query against TenantPlan.TRIAL returned
// zero rows where production data existed. Switching to the canonical
// (lowercase) SSoT corrects the latent casing bug as part of the
// unification.
export { TenantPlan } from '@platform/event-contracts';
import { TenantPlan } from '@platform/event-contracts';

export enum TenantStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  PENDING = 'PENDING',
  CANCELLED = 'CANCELLED',
}

// Read from public schema (shared database) - read-only reference
@Entity('tenants', { schema: 'auth', synchronize: false })
export class TenantReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', unique: true, length: 100 })
  slug!: string;

  @Column({ type: 'varchar', length: 20, default: TenantStatus.PENDING })
  status!: TenantStatus;

  @Column({ type: 'varchar', length: 20, default: TenantPlan.TRIAL })
  plan!: TenantPlan;

  @Column({ type: 'int', default: 5 })
  maxUsers!: number;

  @Column({ type: 'timestamptz', nullable: true })
  trialEndsAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  subscriptionEndsAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
