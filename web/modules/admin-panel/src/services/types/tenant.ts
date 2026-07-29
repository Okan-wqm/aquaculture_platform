/**
 * Tenant domain types.
 *
 * The read shapes are GENERATED from the backend's tenant DTOs
 * (`tools/codegen/admin-contracts/manifest.ts`). `Tenant` is an alias of
 * `TenantListItemDto` — the paginated list is the panel's tenant read surface —
 * and `TenantDetail` an alias of `TenantDetailDto`. The hand-written versions
 * that used to live here declared roughly a dozen fields the wire has never
 * carried (`limits`, `settings`, `primaryContact`, `billingContact`,
 * `suspendedAt`, `version`, `maxStorage`, `isTrialActive` …), because they were
 * modelled on the ENTITY rather than on any response.
 */

// GENERATED backend contracts — tools/codegen/admin-contracts/manifest.ts.
import type {
  TenantActivity,
  TenantNote,
  TenantSummaryDto,
  TenantListItemDto,
  TenantDetailDto,
  TenantAvailableAction,
} from './generated/admin-contracts';

export type {
  TenantActivity,
  TenantNote,
  TenantSummaryDto,
  TenantListItemDto,
  TenantDetailDto,
  TenantAvailableAction,
};

// A tenant's plan is the ENTITLEMENT vocabulary `TenantPlan` (free | trial |
// starter | professional | enterprise): that is what `auth.tenants.plan` stores,
// what `Tenant.tier` reads back, and what `@IsEnum(TenantPlan)` on the
// create/update/query DTOs validates.
//
// A hand-copied `TenantTier` enum used to sit below, pinned member-for-member to
// the SELLABLE `BillingPlanTier` set instead — so the panel's types claimed it
// could send `custom` (the endpoint 400s it) and that `trial` was impossible
// (the endpoint takes it). `billing.ts` owns the sellable tier; importing rather
// than re-exporting keeps the `export *` barrel unambiguous.
import { TenantPlan, TenantStatus } from './generated/admin-contracts';

export { TenantPlan };

// The lifecycle vocabulary, generated too. The hand-written copy omitted
// CANCELLED and PURGED — both allowed by auth.tenants' CHECK constraint — so a
// tenant in either state had no matching option in any status filter.
export { TenantStatus };

/**
 * A tenant as the panel reads it: the paginated list item.
 *
 * Aliased rather than re-declared so the name every page already imports keeps
 * working while the shape has exactly one author.
 */
export type Tenant = TenantListItemDto;

/** A tenant's full detail surface (`GET /admin/tenants/:id/detail`). */
export type TenantDetail = TenantDetailDto;

// ============================================================================
// Tenant Interfaces
// ============================================================================

/**
 * `GET /admin/tenants/stats`.
 *
 * Still hand-declared: the backend's `TenantStatsDto` is a class with no
 * mapper and a phantom `byTier` nobody produced, so generating it would emit a
 * field that has never been on the wire. Narrowing it is its own slice.
 */
export interface TenantStats {
  totalTenants: number;
  activeTenants: number;
  suspendedTenants: number;
  pendingTenants: number;
  byPlan?: Record<string, number>;
  newTenantsLast30Days: number;
  churnedTenantsLast30Days: number;
}

/** Contact block on the create/update write contracts. */
export interface TenantContact {
  name: string;
  email: string;
  phone?: string;
  role: string;
}

/** Per-tenant limits accepted on the create/update write contracts. */
export interface TenantLimits {
  maxUsers: number;
  maxFarms: number;
  maxPonds: number;
  maxSensors: number;
  maxAlertRules: number;
  dataRetentionDays: number;
  apiRateLimit: number;
  storageGb: number;
}

/** Per-tenant settings accepted on the create/update write contracts. */
export interface TenantSettings {
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
}

/**
 * Module quantity configuration for pricing calculation
 */
export interface ModuleQuantityConfig {
  moduleId: string;
  users?: number;
  farms?: number;
  ponds?: number;
  sensors?: number;
  employees?: number;
  devices?: number;
  storageGb?: number;
  apiCalls?: number;
  alerts?: number;
  reports?: number;
  integrations?: number;
}

export interface CreateTenantDto {
  name: string;
  slug?: string;
  tier?: TenantPlan;
  description?: string;
  domain?: string;
  primaryContact?: TenantContact;
  billingContact?: TenantContact;
  billingEmail?: string;
  country?: string;
  region?: string;
  trialDays?: number;
  maxUsers?: number;
  maxStorage?: number;
  limits?: Partial<TenantLimits>;
  settings?: Partial<TenantSettings>;
  /**
   * Module IDs to assign to the tenant during creation
   * Super Admin selects which modules the tenant will have access to
   */
  moduleIds?: string[];
  /**
   * Optional quantity configuration per module for pricing calculation
   */
  moduleQuantities?: ModuleQuantityConfig[];
  /**
   * Billing cycle preference: monthly, quarterly, semi_annual, annual
   */
  billingCycle?: 'monthly' | 'quarterly' | 'semi_annual' | 'annual';
  catalogVersionId?: string;
  quoteId?: string;
  customPlanId?: string;
}

export enum TenantProvisioningState {
  QUEUED = 'QUEUED',
  RESERVING = 'RESERVING',
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

export interface TenantProvisioningStep {
  name: string;
  state: TenantProvisioningState;
  attempts: number;
  lastError?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CreateTenantAcceptedResponse {
  status: TenantProvisioningState;
  tenantStatus?: TenantStatus;
  statusUrl: string;
  retryAfterMs: number;
  availableActions: Array<'retryProvisioning'>;
}

export interface UpdateTenantDto {
  name?: string;
  description?: string;
  domain?: string;
  tier?: TenantPlan;
  primaryContact?: TenantContact;
  billingContact?: TenantContact;
  billingEmail?: string;
  country?: string;
  region?: string;
  limits?: Partial<TenantLimits>;
  settings?: Partial<TenantSettings>;
}
