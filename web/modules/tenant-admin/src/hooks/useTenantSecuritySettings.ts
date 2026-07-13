/**
 * Tenant security policy + localization preferences — read + update (ADR-045).
 *
 * Uses the useTenantQuery / useTenantMutation SSoT (tenant-scoped keys +
 * invalidation are handled for you — web/ CLAUDE.md cross-tenant cache rule).
 * Backed by the auth-service subgraph (TENANT_ADMIN-guarded); each update
 * invalidates its read so the persisted policy reflects immediately.
 */
import { useTenantQuery, useTenantMutation } from '@aquaculture/shared-ui';
import {
  getTenantSecurityPolicy,
  updateTenantSecurityPolicy,
  getTenantLocalizationPreferences,
  updateTenantLocalizationPreferences,
  type TenantSecurityPolicy,
  type UpdateTenantSecurityPolicyInput,
  type TenantLocalizationPreferences,
  type UpdateTenantLocalizationPreferencesInput,
} from '../lib/api';

export type {
  TenantSecurityPolicy,
  UpdateTenantSecurityPolicyInput,
  TenantLocalizationPreferences,
  UpdateTenantLocalizationPreferencesInput,
  TenantDateFormat,
} from '../lib/api';

// Domain key segments — the tenant prefix + epoch are added by useTenantQuery.
const SECURITY_POLICY_SEGMENTS = ['tenantSecurityPolicy'] as const;
const LOCALIZATION_SEGMENTS = ['tenantLocalizationPreferences'] as const;

export function useTenantSecurityPolicy() {
  return useTenantQuery<TenantSecurityPolicy>(
    SECURITY_POLICY_SEGMENTS,
    getTenantSecurityPolicy,
  );
}

export function useUpdateTenantSecurityPolicy() {
  return useTenantMutation<TenantSecurityPolicy, Error, UpdateTenantSecurityPolicyInput>(
    updateTenantSecurityPolicy,
    { invalidate: [SECURITY_POLICY_SEGMENTS] },
  );
}

export function useTenantLocalizationPreferences() {
  return useTenantQuery<TenantLocalizationPreferences>(
    LOCALIZATION_SEGMENTS,
    getTenantLocalizationPreferences,
  );
}

export function useUpdateTenantLocalizationPreferences() {
  return useTenantMutation<
    TenantLocalizationPreferences,
    Error,
    UpdateTenantLocalizationPreferencesInput
  >(updateTenantLocalizationPreferences, { invalidate: [LOCALIZATION_SEGMENTS] });
}
