/**
 * useTenantBilling Hook
 *
 * Fetches subscription, invoices, payment history, and usage data
 * for the current tenant. Read-only -- no mutations.
 *
 * Uses TanStack Query for data fetching and caching.
 */

import { useQuery } from '@tanstack/react-query';
import { graphqlRequest } from '../services/tenant-api.service';
import { TENANT_BILLING_QUERY } from '../graphql';
import { logError } from '../utils/error-handling';

// ============================================================================
// Types
// ============================================================================

export interface TenantSubscription {
  id: string;
  plan: string;
  status: 'ACTIVE' | 'TRIAL' | 'PAST_DUE' | 'CANCELLED' | 'SUSPENDED';
  billingPeriod: 'MONTHLY' | 'YEARLY';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndDate: string | null;
  /** @deprecated Float — use `monthlyPriceDecimal` (exact decimal string, ADR-0004). */
  monthlyPrice: number;
  /** Exact-decimal monthly price as a string (Decimal scalar). Parse with `parseMoney`. */
  monthlyPriceDecimal: string;
  currency: string;
}

export interface TenantInvoice {
  id: string;
  invoiceNumber: string;
  /** @deprecated Float — use `amountDecimal` (exact decimal string, ADR-0004). */
  amount: number;
  /** Exact-decimal amount as a string (Decimal scalar). Parse with `parseMoney`. */
  amountDecimal: string;
  currency: string;
  status: 'PAID' | 'PENDING' | 'OVERDUE' | 'DRAFT' | 'VOID';
  issuedAt: string;
  dueDate: string;
  paidAt: string | null;
  description: string;
}

export interface PlanLimits {
  maxFarms: number;
  maxSensors: number;
  maxUsers: number;
  maxStorage: number; // in GB
  currentFarms: number;
  currentSensors: number;
  currentUsers: number;
  currentStorage: number; // in GB
}

export interface UsageMetrics {
  apiCallsThisMonth: number;
  apiCallsLimit: number;
  storageUsedGb: number;
  storageLimit: number;
  sensorReadingsThisMonth: number;
  sensorReadingsLimit: number;
}

export interface TenantBillingData {
  subscription: TenantSubscription | null;
  invoices: TenantInvoice[];
  planLimits: PlanLimits | null;
  usageMetrics: UsageMetrics | null;
}

// ============================================================================
// Query Keys
// ============================================================================

export const billingKeys = {
  all: ['tenant-billing'] as const,
  details: () => [...billingKeys.all, 'details'] as const,
};

// ============================================================================
// Hook
// ============================================================================

export function useTenantBilling() {
  const query = useQuery({
    queryKey: billingKeys.details(),
    queryFn: async (): Promise<TenantBillingData> => {
      try {
        const data = await graphqlRequest<{ tenantBilling: TenantBillingData }>(
          TENANT_BILLING_QUERY,
        );
        return data.tenantBilling;
      } catch (err) {
        logError('useTenantBilling', err);
        throw err;
      }
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

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
