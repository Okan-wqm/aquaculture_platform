import {
  TenantPlan,
  TenantStatus,
  toTenantPlan,
  resolvePlanLimits,
} from '@platform/event-contracts';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
} from 'typeorm';

// Re-export the canonical SSoT enums so this module's public surface stays the
// same for downstream consumers that import { TenantPlan, TenantTier,
// TenantStatus } from this entity.
//
// WHY canonical (not a local copy):
// - TenantPlan (DBR-HIGH-003): the canonical includes FREE.
// - TenantStatus (MT-HIGH-003): pre-fix this read-replica entity owned a
//   private 8-value copy with no PURGED terminal and no transition authority.
//   The canonical lives beside the lifecycle machine in event-contracts.
export { TenantPlan, TenantTier, TenantStatus } from '@platform/event-contracts';

export interface TenantSettings {
  timezone?: string;
  locale?: string;
  currency?: string;
  dateFormat?: string;
  measurementSystem?: 'metric' | 'imperial';
  country?: string;
  region?: string;
  billingEmail?: string;
  primaryContact?: { name: string; email: string; phone?: string; role: string };
  billingContact?: { name: string; email: string; phone?: string; role: string };
  notificationPreferences?: {
    email: boolean;
    sms: boolean;
    push: boolean;
    slack: boolean;
  };
  features?: string[];
}

// Read from public schema - read-only reference to auth-service's tenants table
@Entity('tenants', { schema: 'auth', synchronize: false })
@Index(['status'])
@Index(['slug'])
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  slug!: string;

  // Typed as the canonical TenantStatus (not bare string) so the lifecycle
  // machine's canTransition/assertTransition type-check at every call site
  // (MT-HIGH-003). The column stays VARCHAR(20); the persisted values ARE
  // TenantStatus values.
  @Column({ type: 'varchar', length: 20, default: TenantStatus.PENDING })
  status!: TenantStatus;

  // Typed as the canonical TenantPlan (not bare string), for the same reason
  // `status` is: the column is VARCHAR(20) but the values ARE TenantPlan values,
  // and auth.tenants — the owning table this replica reads — enforces it with a
  // CHECK constraint (`plan IN ('free','trial','starter','professional',
  // 'enterprise')`). The bare `string` here was what widened `tier` and, through
  // it, TenantDetailDto/TenantListItemDto and the admin panel's tenant types,
  // all the way out to a UI that had to guess which vocabulary it was holding.
  @Column({ type: 'varchar', length: 20, default: TenantPlan.STARTER })
  plan!: TenantPlan;

  @Column({ type: 'int', default: 5 })
  maxUsers!: number;

  @Column({ type: 'int', default: -1, name: 'max_storage' })
  maxStorage!: number;

  // MT-MEDIUM-001: is_trial_active was dropped from auth.tenants (trial is
  // derived from trialEndsAt, the SSoT). This read-replica therefore declares
  // NO isTrialActive mapping — it would SELECT a non-existent column. Consumers
  // derive trial state from trialEndsAt (see TenantDetailService.getTenantDetail).

  @Column({ type: 'int', default: 0, name: 'user_count' })
  userCount!: number;

  // MT-MEDIUM-002: farm_count/sensor_count dropped from auth.tenants (unmaintained
  // denormalization). Real counts are computed at read time from the per-tenant
  // tenant_<uuid>.farms / .sensors tables in TenantDetailService.

  @Column({ type: 'timestamptz', nullable: true })
  trialEndsAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  subscriptionEndsAt?: Date;

  @Column({ type: 'jsonb', nullable: true })
  settings?: TenantSettings;

  @Column({ type: 'varchar', length: 500, nullable: true })
  logoUrl?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  contactEmail?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  contactPhone?: string;

  @Column({ type: 'text', nullable: true })
  address?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  taxId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  customDomain?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'uuid', nullable: true })
  createdBy?: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @VersionColumn({ name: 'version' })
  version!: number;

  // ============================================
  // Suspension audit (DB-ADMIN-HIGH-003) — READ-ONLY for admin-api
  // ============================================
  // WHY real columns: these were previously non-persisted compatibility props,
  // so every handler assignment was silently dropped by TypeORM and the
  // platform kept no durable suspension record. They now map the real
  // auth.tenants columns added by auth-service migration
  // 1807100000000-AddTenantSuspensionAudit. auth-service is the single writer
  // (DB-ADMIN-HIGH-004): it sets the trio on the SUSPENDED transition and
  // clears it on ACTIVE. Admin-api only READS them (tenant detail surface) —
  // no admin code may write auth.tenants, enforced by
  // tests/invariants/admin-no-auth-tenants-writes.spec.ts.
  @Column({ type: 'timestamptz', nullable: true })
  suspendedAt?: Date | null;

  @Column({ type: 'text', nullable: true })
  suspendedReason?: string | null;

  @Column({ type: 'uuid', nullable: true })
  suspendedBy?: string | null;

  // Backwards compatibility - these properties are NOT in the database
  // but exist for code compatibility with other services
  domain?: string; // Use customDomain instead
  country?: string;
  region?: string;
  // NOTE: lastActivityAt was removed (DB-ADMIN-HIGH-003 cleanup). It was a
  // non-persisted compatibility prop with USER-ACTIVITY semantics that no
  // auth.tenants column ever backed — every read was undefined and the one
  // write (activate handler) was silently dropped. Tenant activity is owned
  // by admin.tenant_activities / admin.user_sessions, not the tenant row.
  billingEmail?: string;
  primaryContact?: { name: string; email: string; phone?: string; role: string };
  billingContact?: { name: string; email: string; phone?: string; role: string };

  // Backwards compatibility getter for 'tier' -> 'plan'.
  //
  // NOTE this is a GETTER: it does not survive JSON.stringify, so a response
  // that should carry `tier` has to map it explicitly (TenantDetailDto and
  // TenantListItemDto both do).
  get tier(): TenantPlan {
    return this.plan;
  }

  set tier(value: TenantPlan) {
    this.plan = value;
  }

  hydrateCompatibilityFields(): void {
    this.domain = this.customDomain;
    this.billingEmail = this.settings?.billingEmail;
    this.country = this.settings?.country;
    this.region = this.settings?.region;
    this.primaryContact = this.settings?.primaryContact;
    this.billingContact = this.settings?.billingContact;
  }

  // Limits getter for backwards compatibility (extended for all expected properties)
  get limits(): {
    maxUsers: number;
    maxFarms: number;
    maxPonds: number;
    maxSensors: number;
    maxAlertRules: number;
    dataRetentionDays: number;
    apiRateLimit: number;
    storageGb: number;
  } {
    // Limits follow this tenant's PLAN from the canonical PLAN_CATALOG SSoT
    // instead of a hardcoded "everything unlimited" stub. maxUsers stays the
    // per-tenant provisioned value on the entity (the authoritative override);
    // maxAlertRules has no PLAN_CATALOG field, so it remains -1 (unlimited).
    // `plan` is TenantPlan-typed and the column is CHECK-constrained, so the
    // parse-and-default dance this used to do had no reachable fallback branch.
    const planLimits = resolvePlanLimits(this.plan);
    return {
      maxUsers: this.maxUsers,
      maxFarms: planLimits.maxFarms,
      maxPonds: planLimits.maxPonds,
      maxSensors: planLimits.maxSensors,
      maxAlertRules: -1,
      dataRetentionDays: planLimits.dataRetentionDays,
      apiRateLimit: planLimits.apiRateLimit,
      storageGb: planLimits.maxStorageGb,
    };
  }

  // Helper methods
  isActive(): boolean {
    // The redundant `|| this.status === 'ACTIVE'` guard is gone: status is now
    // typed TenantStatus, so the enum comparison is exhaustive (and the string
    // literal no longer overlaps the type).
    return this.status === TenantStatus.ACTIVE;
  }

  isSuspended(): boolean {
    return this.status === TenantStatus.SUSPENDED;
  }

  isTrialExpired(): boolean {
    if (!this.trialEndsAt) return false;
    return new Date() > this.trialEndsAt;
  }

  canAddUsers(count = 1): boolean {
    if (this.maxUsers === -1) return true; // unlimited
    return count <= this.maxUsers;
  }

  canAddFarms(_count = 1): boolean {
    return true; // No limit in this schema
  }

  canAddSensors(_count = 1): boolean {
    return true; // No limit in this schema
  }
}

// Tenant Invitation entity
@Entity('tenant_invitations', { schema: 'auth', synchronize: false })
@Index(['email', 'tenantId'])
@Index(['token'])
@Index(['expiresAt'])
export class TenantInvitation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  token!: string;

  @Column({ type: 'varchar', length: 50 })
  role!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  invitedBy?: string;

  @Column({ type: 'timestamp with time zone' })
  expiresAt!: Date;

  @Column({ type: 'boolean', default: false })
  accepted!: boolean;

  @Column({ type: 'timestamp with time zone', nullable: true })
  acceptedAt?: Date;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  isExpired(): boolean {
    return new Date() > this.expiresAt;
  }
}
