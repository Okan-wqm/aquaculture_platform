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

export type TenantLimits = ApiSchema<'TenantLimitsDto'>;

export type TenantSettings = ApiSchema<'TenantSettingsDto'>;

export type TenantContact = ApiSchema<'TenantContactDto'>;

/**
 * One row of `GET /admin/tenants`, as `TenantListItemDto` describes it.
 *
 * Hand-declared until now, and it drifted the way ADMIN-HIGH-110 drifted: it
 * carried `lastActivityAt`, which the backend REMOVED under DB-ADMIN-HIGH-003
 * because no `auth.tenants` column ever backed it, so the value was always
 * `undefined`. The tenant list and detail page both rendered it.
 *
 * The DTO could not be sourced from the contract before because it was declared
 * as an `interface`, and the `@nestjs/swagger` plugin emits schemas for CLASSES
 * ONLY — the exact root cause found in ADMIN-HIGH-110. It is a class now, so
 * this is an alias and a backend rename is a compile error here.
 */
export type Tenant = ApiSchema<'TenantListItemDto'>;

export type TenantStats = ApiSchema<'TenantStatsDto'>;

/**
 * One `admin.tenant_activities` row. The hand-written copy typed
 * `activityType` as a bare `string`; the contract carries the seventeen-member
 * enum and a `legalHold` flag the copy omitted entirely.
 */
export type TenantActivity = ApiSchema<'TenantActivity'>;

export type TenantNote = ApiSchema<'TenantNote'>;

/**
 * `GET /admin/tenants/:id/detail`, as `TenantDetailDto` describes it.
 *
 * NOT `Tenant & extras`: the detail response is a different projection, not a
 * superset of the list row, and writing it as an extension of the list type is
 * what let both carry `lastActivityAt` from one hand-written declaration.
 */
export type TenantDetail = ApiSchema<'TenantDetailDto'>;

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

export type TenantProvisioningStep = ApiSchema<'TenantProvisioningStepDto'>;

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
