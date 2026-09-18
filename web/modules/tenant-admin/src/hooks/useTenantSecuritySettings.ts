/**
 * Tenant auth-security policy — read + update (ADR-046).
 *
 * Goes through the useTenantQuery / useTenantMutation SSoT, so the cache key
 * carries the tenant prefix + session epoch and the token gating for free
 * (web/CLAUDE.md cross-tenant cache rule, FE-CRITICAL-014/015/016). Backed by
 * the TENANT_ADMIN-guarded auth-service subgraph; the update invalidates its
 * own read so a saved policy reflects immediately.
 */
import { useTenantQuery, useTenantMutation } from '@aquaculture/shared-ui';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

import {
  getTenantSecurityPolicy,
  updateTenantSecurityPolicy,
  type TenantSecurityPolicy,
  type UpdateTenantSecurityPolicyInput,
} from '../lib/api';

export type { TenantSecurityPolicy, UpdateTenantSecurityPolicyInput } from '../lib/api';

// Domain key segments — the tenant prefix and the session epoch are added by
// useTenantQuery; never write a bare key here.
const SECURITY_POLICY_SEGMENTS = ['tenantSecurityPolicy'] as const;

export function useTenantSecurityPolicy(): UseQueryResult<TenantSecurityPolicy, Error> {
  return useTenantQuery<TenantSecurityPolicy>(SECURITY_POLICY_SEGMENTS, getTenantSecurityPolicy);
}

export function useUpdateTenantSecurityPolicy(): UseMutationResult<
  TenantSecurityPolicy,
  Error,
  UpdateTenantSecurityPolicyInput
> {
  return useTenantMutation<TenantSecurityPolicy, Error, UpdateTenantSecurityPolicyInput>(
    updateTenantSecurityPolicy,
    { invalidate: [SECURITY_POLICY_SEGMENTS] },
  );
}
