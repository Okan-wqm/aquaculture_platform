import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { TenantPlan, TenantStatus } from '@platform/event-contracts';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  Check,
} from 'typeorm';

// Re-export the canonical SSoT enums so downstream consumers that import
// TenantPlan / TenantStatus from this entity module keep working unchanged.
//
// WHY both enums are canonical in event-contracts (not here):
// - TenantPlan (DBR-HIGH-003): pre-fix this service's private copy lacked
//   FREE; the canonical is a strict superset.
// - TenantStatus (MT-HIGH-003): pre-fix this service owned a private 8-value
//   copy that lacked the PURGED terminal and had no transition-legality
//   authority. The canonical lives beside the TenantStatusChanged event and
//   the lifecycle machine that now gates every status change + login.
export { TenantPlan, TenantStatus } from '@platform/event-contracts';

registerEnumType(TenantPlan, {
  name: 'TenantPlan',
  description: 'Tenant subscription plans',
});

registerEnumType(TenantStatus, {
  name: 'TenantStatus',
  description: 'Tenant account status',
});

/**
 * Canonical tenant date-format vocabulary (ADR-042). A closed union (not a free
 * string) so an unknown format is a compile-time error at every producer.
 */
export const TENANT_DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const;
export type TenantDateFormat = (typeof TENANT_DATE_FORMATS)[number];

/**
 * Tenant Entity
 *
 * Represents a tenant (company/organization) in the multi-tenant system.
 * Each tenant has:
 * - Their own users (TENANT_ADMIN, MODULE_MANAGER, MODULE_USER)
 * - Assigned modules (via TenantModule)
 * - Isolated data in all microservices
 */
@ObjectType()
@Entity('tenants', { schema: 'auth' })
@Check(`"status" IN ('PENDING', 'PROVISIONING', 'PROVISIONING_FAILED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'CANCELLED', 'ARCHIVED', 'PURGED')`)
@Check(`"plan" IN ('free', 'trial', 'starter', 'professional', 'enterprise')`)
@Index('IDX_tenants_slug', ['slug'], { unique: true })
@Index('IDX_tenants_status', ['status'])
// DBR-MEDIUM-001 cure: enterprise custom-domain rows MUST be unique
// across tenants — two tenants both claiming `acme.aquaculture.com` is
// a routing-ambiguity vector that maps a single inbound host to two
// different tenant rows. Partial unique (WHERE customDomain IS NOT NULL)
// allows the typical case (most tenants have NULL custom domain) without
// the bare-NULL collision the full unique would otherwise cause.
@Index('UQ_tenants_customDomain', ['customDomain'], {
  unique: true,
  where: '"customDomain" IS NOT NULL',
})
export class Tenant {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Company/Organization name
   */
  @Field()
  @Column({ type: 'varchar', length: 255 })
  name!: string;

  /**
   * URL-friendly unique identifier (e.g., 'acme-corp')
   * Used in subdomains or URL paths
   */
  @Field()
  @Column({ type: 'varchar', unique: true, length: 100 })
  slug!: string;

  /**
   * Company description
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string | null;

  /**
   * Company logo URL
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 500, nullable: true })
  logoUrl?: string | null;

  /**
   * Primary contact email
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 255, nullable: true })
  contactEmail?: string | null;

  /**
   * Primary contact phone
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 50, nullable: true })
  contactPhone?: string | null;

  /**
   * Company address
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  address?: string | null;

  /**
   * Tax ID / Company registration number
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 100, nullable: true })
  taxId?: string | null;

  /**
   * Tenant status
   */
  @Field(() => TenantStatus)
  @Column({
    type: 'varchar',
    length: 20,
    default: TenantStatus.PENDING,
  })
  status!: TenantStatus;

  /**
   * Subscription plan
   */
  @Field(() => TenantPlan)
  @Column({
    type: 'varchar',
    length: 20,
    default: TenantPlan.STARTER,
  })
  plan!: TenantPlan;

  /**
   * Maximum number of users allowed
   */
  @Field()
  @Column({ type: 'int', default: 5 })
  maxUsers!: number;

  /**
   * Maximum storage in GB (-1 = unlimited)
   */
  @Field()
  @Column({ type: 'int', default: -1, name: 'max_storage' })
  maxStorage!: number;

  /**
   * Whether the tenant is currently within an active trial window.
   *
   * MT-MEDIUM-001: trial is a STATE derived from the single source `trialEndsAt`
   * — NOT a stored denormalization (the old `is_trial_active` column drifted from
   * trialEndsAt) and NOT the plan tier (the `plan === TRIAL` representation is
   * gone). Exposed as a computed GraphQL field so the public API shape is
   * unchanged.
   */
  @Field()
  get isTrialActive(): boolean {
    return this.isOnTrial();
  }

  /**
   * Current user count (denormalized for quick access)
   */
  @Field()
  @Column({ type: 'int', default: 0, name: 'user_count' })
  userCount!: number;

  // MT-MEDIUM-002: farm_count/sensor_count removed — they were unmaintained
  // (always 0) denormalizations. Farms and sensors are owned by the per-tenant
  // tenant_<uuid>.farms / .sensors tables; admin-api computes the real counts at
  // read time from there.

  /**
   * Trial end date (if on trial)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  trialEndsAt?: Date | null;

  /**
   * Subscription end date
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  subscriptionEndsAt?: Date | null;

  /**
   * Custom domain (if enterprise)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 255, nullable: true })
  customDomain?: string | null;

  /**
   * Tenant settings (JSON)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  settings?: Record<string, unknown> | null;

  /**
   * Created by (SUPER_ADMIN user ID)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  createdBy?: string | null;

  // ============================================
  // Tenant auth-security policy + localization preferences (ADR-042)
  //
  // NOT @Field-decorated (like `version` below): these columns never enter the
  // public GraphQL Tenant ObjectType. The TENANT_ADMIN-guarded policy surface
  // (tenantSecurityPolicy / tenantLocalizationPreferences) is the only read
  // path, so exposure is a deliberate resolver decision, not an entity default.
  // NULL means "no tenant policy set" — platform defaults apply.
  // ============================================

  /**
   * ADR-042: when true, every user of this tenant MUST have MFA enrolled to
   * receive tokens at login (AuthenticationService login gate). Enforced —
   * not advisory. NULL/false = not enforced.
   */
  @Column({ type: 'boolean', nullable: true, name: 'enforce_mfa' })
  enforceMfa?: boolean | null;

  /**
   * ADR-042: idle-session timeout in minutes (5..1440, validated at the
   * mutation DTO). Clamps the refresh-token TTL at issuance AND rotation
   * (MIN(configured TTL incl. rememberMe, this) — tenant policy wins), giving
   * sliding idle-timeout semantics. NULL = configured platform TTL applies.
   */
  @Column({ type: 'int', nullable: true, name: 'session_timeout_minutes' })
  sessionTimeoutMinutes?: number | null;

  /**
   * ADR-042: IANA timezone preference (e.g. 'Europe/Istanbul'). A
   * localization PREFERENCE column — deliberately not part of the security
   * policy container.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  timezone?: string | null;

  /**
   * ADR-042: date-format preference. Closed vocabulary (TENANT_DATE_FORMATS);
   * the mutation DTO enum-validates writes.
   */
  @Column({ type: 'varchar', length: 10, nullable: true, name: 'date_format' })
  dateFormat?: TenantDateFormat | null;

  // ============================================
  // Timestamps
  // ============================================

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @VersionColumn({ name: 'version' })
  version!: number;

  // ============================================
  // Helper Methods
  // ============================================

  isActive(): boolean {
    return this.status === TenantStatus.ACTIVE;
  }

  isSuspended(): boolean {
    return this.status === TenantStatus.SUSPENDED;
  }

  isPending(): boolean {
    return this.status === TenantStatus.PENDING;
  }

  /**
   * On trial ⟺ a trial window exists and has not elapsed. MT-MEDIUM-001: derived
   * from `trialEndsAt` alone (the SSoT). The prior `plan === TRIAL` gate returned
   * false for every real tenant — production tenants trial on a real tier (e.g.
   * starter) with `trialEndsAt` set, never on `plan = 'trial'` — so the gate was
   * a latent bug that hid every active trial.
   */
  isOnTrial(): boolean {
    if (!this.trialEndsAt) return false;
    return this.trialEndsAt > new Date();
  }

  isTrialExpired(): boolean {
    if (!this.trialEndsAt) return false;
    return this.trialEndsAt < new Date();
  }

  isSubscriptionExpired(): boolean {
    if (!this.subscriptionEndsAt) return false;
    return this.subscriptionEndsAt < new Date();
  }

  /**
   * Generate slug from company name
   */
  static generateSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
