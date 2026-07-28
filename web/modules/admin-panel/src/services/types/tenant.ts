/**
 * Tenant domain types
 */

// GENERATED backend contracts — tools/codegen/admin-contracts/manifest.ts.
// Imported so shapes below can reference them; re-exported so import sites
// are unchanged.
import type {
  TenantActivity,
  TenantNote,
} from './generated/admin-contracts';

export type {
  TenantActivity,
  TenantNote,
};

// A tenant's plan is the ENTITLEMENT vocabulary `TenantPlan` (free | trial |
// starter | professional | enterprise): that is what `auth.tenants.plan` stores,
// what `Tenant.tier` reads back (the field is a getter over `plan`), and what
// `@IsEnum(TenantPlan)` on the create/update/query DTOs validates.
//
// A hand-copied `TenantTier` enum used to sit below, pinned member-for-member to
// the SELLABLE `BillingPlanTier` set instead — so the panel's types claimed it
// could send `custom` (the endpoint 400s it) and that `trial` was impossible
// (the endpoint takes it). `billing.ts` owns the sellable tier; importing rather
// than re-exporting keeps the `export *` barrel unambiguous.
import { TenantPlan } from './generated/admin-contracts';

export { TenantPlan };

// ============================================================================
// Tenant Enums (Backend uyumlu)
// ============================================================================

export enum TenantStatus {
  PENDING = 'PENDING',
  PROVISIONING = 'PROVISIONING',
  PROVISIONING_FAILED = 'PROVISIONING_FAILED',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  DEACTIVATED = 'DEACTIVATED',
  ARCHIVED = 'ARCHIVED',
}


// ============================================================================
// Tenant Interfaces
// ============================================================================

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

export interface TenantContact {
  name: string;
  email: string;
  phone?: string;
  role: string;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  description?: string;
  domain?: string;
  tier: TenantPlan;
  status: TenantStatus;
  userCount: number;
  farmCount: number;
  sensorCount: number;
  limits?: TenantLimits;
  settings?: TenantSettings;
  primaryContact?: TenantContact;
  billingContact?: TenantContact;
  billingEmail?: string;
  country?: string;
  region?: string;
  trialEndsAt?: string;
  suspendedAt?: string;
  suspendedReason?: string;
  suspendedBy?: string;
  lastActivityAt?: string;
  createdBy?: string;
  maxStorage?: number;
  isTrialActive?: boolean;
  createdAt: string;
  updatedAt: string;
  version?: number;
  availableActions?: Array<'activate' | 'suspend' | 'deactivate' | 'archive' | 'retryProvisioning'>;
}

export interface TenantStats {
  totalTenants: number;
  activeTenants: number;
  suspendedTenants: number;
  pendingTenants: number;
  byPlan?: Record<string, number>;
  newTenantsLast30Days: number;
  churnedTenantsLast30Days: number;
}

export interface TenantDetail extends Tenant {
  userStats?: {
    total: number;
    active: number;
    inactive: number;
    byRole: Record<string, number>;
    recentlyActive: number;
    newUsersLast30Days: number;
  };
  resourceUsage?: {
    storage: { usedGb: number; limitGb: number; percentage: number };
    users: { count: number; limit: number; percentage: number };
    farms: { count: number; limit: number; percentage: number };
    sensors: { count: number; limit: number; percentage: number };
    apiCalls: { last24h: number; last7d: number; limit: number };
  };
  modules?: Array<{
    moduleId: string;
    moduleCode: string;
    moduleName: string;
    isActive: boolean;
    assignedAt: string;
  }>;
  recentActivities?: TenantActivity[];
  notes?: TenantNote[];
  billing?: {
    currentPlan: TenantPlan;
    monthlyAmount: number;
    currency: string;
    billingCycle: string;
    paymentStatus: string;
    nextBillingDate: string | null;
    lastPaymentDate: string | null;
    lastPaymentAmount: number | null;
  };
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
