import { IsArray, IsUUID, ArrayMaxSize, IsString, IsOptional, IsBoolean, MaxLength, IsEnum } from 'class-validator';

import { TenantActivity, TenantNote } from '../entities/tenant-activity.entity';
import { Tenant } from '../entities/tenant.entity';

import { TenantLimitsDto } from './tenant.dto';

export type TenantAvailableAction =
  | 'activate'
  | 'suspend'
  | 'deactivate'
  | 'archive'
  | 'retryProvisioning';

// User Statistics by Role
export class UserStatsByRole {
  total!: number;
  active!: number;
  inactive!: number;
  byRole!: {
    admin: number;
    manager: number;
    supervisor: number;
    operator: number;
    viewer: number;
  };
  recentlyActive!: number; // last 7 days
  newUsersLast30Days!: number;
}

// Module Usage Statistics
export class ModuleUsageStats {
  moduleId!: string;
  moduleCode!: string;
  moduleName!: string;
  isActive!: boolean;
  assignedAt!: Date;
  usageCount?: number;
  lastUsedAt?: Date;
}

// Storage & API Usage
export class ResourceUsage {
  storage!: {
    usedGb: number;
    limitGb: number;
    percentage: number;
  };
  users!: {
    count: number;
    limit: number;
    percentage: number;
  };
  farms!: {
    count: number;
    limit: number;
    percentage: number;
  };
  sensors!: {
    count: number;
    limit: number;
    percentage: number;
  };
  apiCalls!: {
    last24h: number;
    last7d: number;
    limit: number;
  };
}

// Billing Summary
/**
 * What billing knows about this tenant.
 *
 * Every field is read from billing's own tables — `billing.subscriptions` for
 * the subscription state (rule D14 makes it the SSoT) and `billing.invoices`
 * for what was actually charged and paid. The former source,
 * `admin.tenant_billing_info`, was a second billing store with no writer, so
 * this block was blank on every tenant (DB-ADMIN-MEDIUM-005).
 *
 * There is deliberately no `monthlyAmount`. The only per-cycle figure billing
 * holds outside an invoice is `subscriptions.pricing.basePrice`, a float inside
 * a jsonb blob that also excludes the per-farm / per-sensor / per-user
 * components — so it is neither exact nor complete, and "monthly" is wrong
 * outright for an annual cycle. The last invoice's total is the amount this
 * tenant was actually billed, in a `numeric` column, and it says which period
 * it covers.
 */
export class BillingSummary {
  /** `billing.subscriptions.plan_name` — the plan billing charges for. */
  currentPlan!: string;
  /** `billing.subscriptions.plan_tier`. */
  planTier!: string;
  /** monthly | quarterly | semi_annual | annual. */
  billingCycle!: string;
  /** trial | active | past_due | cancelled | suspended | expired. */
  subscriptionStatus!: string;
  /** End of the current period — when the next invoice is due. */
  nextBillingDate!: Date | null;
  /** Total of the most recent invoice; null until one has been issued. */
  lastInvoiceAmount!: number | null;
  lastInvoiceIssuedAt!: Date | null;
  /** Period the most recent invoice covers. Null with no invoice. */
  lastInvoicePeriodStart!: Date | null;
  lastInvoicePeriodEnd!: Date | null;
  /** Currency of the most recent invoice. Null with no invoice — not 'USD'. */
  currency!: string | null;
  /** Most recent invoice that was actually paid. */
  lastPaymentDate!: Date | null;
  lastPaymentAmount!: number | null;
}

// Full Tenant Detail Response
export class TenantDetailDto {
  // Basic Info
  id!: string;
  name!: string;
  slug!: string;
  description?: string;
  domain?: string;

  // Status & Tier
  status!: string;
  tier!: string;
  plan?: string;
  trialEndsAt?: Date;
  // Suspension audit (DB-ADMIN-HIGH-003): real auth.tenants columns written
  // only by auth-service; NULL when the tenant is not suspended.
  suspendedAt?: Date | null;
  suspendedReason?: string | null;
  availableActions!: TenantAvailableAction[];

  // Contact Info
  primaryContact?: {
    name: string;
    email: string;
    phone?: string;
    role: string;
  };
  billingContact?: {
    name: string;
    email: string;
    phone?: string;
    role: string;
  };
  billingEmail?: string;

  // Location
  country?: string;
  region?: string;

  // Settings & Limits
  settings?: {
    timezone: string;
    locale: string;
    currency: string;
    dateFormat: string;
    measurementSystem: string;
    notificationPreferences: {
      email: boolean;
      sms: boolean;
      push: boolean;
      slack: boolean;
    };
    features: string[];
  };
  limits?: TenantLimitsDto;
  userCount!: number;
  farmCount!: number;
  sensorCount!: number;
  maxStorage!: number;
  isTrialActive!: boolean;

  // Statistics
  userStats?: UserStatsByRole;
  resourceUsage?: ResourceUsage;

  // Modules
  modules?: ModuleUsageStats[];

  // Activity & Notes
  recentActivities?: TenantActivity[];
  notes?: TenantNote[];

  // Billing
  billing?: BillingSummary;

  // Metadata
  createdAt!: Date;
  updatedAt!: Date;
  createdBy?: string;
  // NOTE: lastActivityAt was removed (DB-ADMIN-HIGH-003 cleanup): no
  // auth.tenants column ever backed it, so the field was always undefined.
  // Tenant activity lives in recentActivities (admin.tenant_activities).
}

// Tenant List Item (optimized for list view)
export class TenantListItemDto {
  id!: string;
  name!: string;
  slug!: string;
  domain?: string;
  status!: string;
  tier!: string;
  contactEmail?: string;
  userCount!: number;
  farmCount!: number;
  sensorCount!: number;
  activeModulesCount?: number;
  // Derived from trialEndsAt, the same rule TenantDetailService applies
  // (MT-MEDIUM-001): the is_trial_active column was dropped from auth.tenants.
  // The list renders a Trial badge from this; it read `isTrialActive` off a
  // hand-written frontend type that had it while this DTO did not, so the badge
  // has never drawn (ADMIN-MEDIUM-111). The list query already loads the full
  // entity, so this costs no additional round-trip.
  isTrialActive!: boolean;
  // NOTE: lastActivityAt was removed (DB-ADMIN-HIGH-003 cleanup): the list
  // mapper never populated it and no auth.tenants column backed it.
  createdAt!: Date;
}

// Note categories allowed for tenant notes (HIGH-003 fix)
const ALLOWED_NOTE_CATEGORIES = ['general', 'billing', 'support', 'compliance', 'technical'] as const;
type NoteCategory = typeof ALLOWED_NOTE_CATEGORIES[number];

// HIGH-003 fix: typed DTO with validation decorators to prevent oversized/malicious note content
export class CreateTenantNoteDto {
  @IsString()
  @MaxLength(5000)
  content!: string;

  @IsOptional()
  @IsEnum(ALLOWED_NOTE_CATEGORIES)
  category?: NoteCategory;

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;
}

export class UpdateTenantNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  content?: string;

  @IsOptional()
  @IsEnum(ALLOWED_NOTE_CATEGORIES)
  category?: NoteCategory;

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;
}

// Bulk Operation DTOs

// HIGH-005 fix: typed class with ArrayMaxSize and per-element UUID validation
export class BulkSuspendDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  tenantIds!: string[];

  @IsString()
  @MaxLength(500)
  reason!: string;
}

// BUG-024 fix: typed DTO with class-validator so tenantIds receives UUID format
// validation and size limits — preventing DoS from oversized arrays.
export class BulkActivateDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  tenantIds!: string[];
}

export interface BulkAssignModulesDto {
  tenantIds: string[];
  moduleIds: string[];
}

export interface BulkNotificationDto {
  tenantIds: string[];
  subject: string;
  message: string;
  notificationType: 'email' | 'in_app' | 'both';
}
