/**
 * useTenantBilling Hook
 *
 * Fetches subscription, invoices, payment history, and usage data
 * for the current tenant. Read-only -- no mutations.
 *
 * Tenant-scoped via the useTenantQuery SSoT (cross-tenant cache rule);
 * data access goes through the lib/api typed layer (CRIT-04).
 */

import { useTenantQuery } from '@aquaculture/shared-ui';
import { getTenantBilling, type TenantBillingData } from '../lib/api';
import { logError } from '../utils/error-handling';

export type {
  TenantSubscription,
  TenantInvoice,
  TenantBillingData,
} from '../lib/api';

/** Domain key segments — tenant prefix + epoch are added by useTenantQuery. */
const BILLING_SEGMENTS = ['billing', 'details'] as const;

export function useTenantBilling() {
  const query = useTenantQuery<TenantBillingData>(
    BILLING_SEGMENTS,
    async () => {
      try {
        return await getTenantBilling();
      } catch (err) {
        logError('useTenantBilling', err);
        throw err;
      }
    },
    { staleTime: 5 * 60 * 1000 },
  );

  return {
    subscription: query.data?.subscription ?? null,
    invoices: query.data?.invoices ?? [],
    planLimits: query.data?.planLimits ?? null,
    usageMetrics: query.data?.usageMetrics ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
