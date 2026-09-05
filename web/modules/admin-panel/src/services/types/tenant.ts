/**
 * Tenant domain types
 */

import type { ApiSchema } from '../contract';

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

// A tenant's *sellable* tier as the admin-panel shows it — which CAN be
// `custom`. This mirrors the canonical `BillingPlanTier` SSoT
// (libs/event-contracts/src/billing/billing-plan-tier.ts), NOT the entitlement
// `TenantPlan` (that one has `trial` and no `custom`). Web modules cannot import
// a backend `@platform/*` library, so this literal is PINNED member-for-member
// to the SSoT by `tests/invariants/tier-enum-ssot.spec.ts` (Faz D, D8).
export enum TenantTier {
  FREE = 'free',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
  CUSTOM = 'custom',
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
  tier: TenantTier;
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
  byTier?: Record<TenantTier, number>;
  byPlan?: Record<string, number>;
  newTenantsLast30Days: number;
  churnedTenantsLast30Days: number;
}

export interface TenantActivity {
  id: string;
  tenantId: string;
  activityType: string;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  performedBy?: string;
  performedByEmail?: string;
  createdAt: string;
}

export interface TenantNote {
  id: string;
  tenantId: string;
  content: string;
  category: string;
  isPinned: boolean;
  createdBy: string;
  createdByEmail?: string;
  createdAt: string;
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
    currentPlan: string;
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

/** Generated from the backend contract (CONTRACT-CRITICAL-003). */
export type CreateTenantDto = ApiSchema<'CreateTenantDto'>;

/**
 * Generated from the backend contract (CONTRACT-CRITICAL-003). A TypeScript
 * `enum` was nominal: its members were not assignable to the states the API
 * actually returns, so the mismatch stayed invisible until the contract landed.
 */
export type TenantProvisioningState = ApiSchema<'CreateTenantAcceptedResponse'>['status'];
export const TenantProvisioningState = {
  QUEUED: 'QUEUED',
  RESERVING: 'RESERVING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const satisfies Record<string, TenantProvisioningState>;

export interface TenantProvisioningStep {
  name: string;
  state: TenantProvisioningState;
  attempts: number;
  lastError?: string;
  startedAt?: string;
  completedAt?: string;
}

/** Generated from the backend contract (CONTRACT-CRITICAL-003). */
export type CreateTenantAcceptedResponse = ApiSchema<'CreateTenantAcceptedResponse'>;

/** Generated from the backend contract (CONTRACT-CRITICAL-003). */
export type UpdateTenantDto = ApiSchema<'UpdateTenantDto'>;

/**
 * The tiers a tenant can be MOVED to through the admin API
 * (CONTRACT-CRITICAL-003). A tenant record's own tier can be `custom` — a
 * negotiated plan built in the custom-plan builder — but `PUT /tenants/:id`
 * does not accept it, so a form that offered it could only ever produce a 400.
 */
export type EditableTenantTier = NonNullable<UpdateTenantDto['tier']>;

export const EDITABLE_TENANT_TIERS: readonly EditableTenantTier[] = [
  'free',
  'trial',
  'starter',
  'professional',
  'enterprise',
];

export function isEditableTenantTier(value: string | undefined): value is EditableTenantTier {
  return value !== undefined && (EDITABLE_TENANT_TIERS as readonly string[]).includes(value);
}
