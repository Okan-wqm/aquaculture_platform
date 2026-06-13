/**
 * Tenant Entity (Read-only reference)
 *
 * This is a read-only view of the tenant table owned by auth-service.
 * Used for cross-service analytics queries in the shared database.
 * DO NOT modify - source of truth is auth-service.
 */

import { TenantPlan, TenantStatus } from '@platform/event-contracts';
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

// Re-export the canonical SSoT enums. Pre-fix this analytics-side mirror had
// its OWN copies that drifted from production:
// - TenantPlan (DBR-HIGH-003): used UPPERCASE ('TRIAL', ...) that NEVER matched
//   the lowercase auth.tenants column — every query returned zero rows.
// - TenantStatus (MT-HIGH-003): a 4-value subset (missing DEACTIVATED/ARCHIVED/
//   PROVISIONING*/PURGED) — analytics that filtered by status silently dropped
//   tenants in the missing states.
// Both now point at the single event-contracts definition.
export { TenantPlan, TenantStatus } from '@platform/event-contracts';

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
