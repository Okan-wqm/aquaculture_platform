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
  monthlyPrice: number;
  currency: string;
}

export interface TenantInvoice {
  id: string;
  invoiceNumber: string;
  amount: number;
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
// GraphQL Queries
// ============================================================================

const TENANT_BILLING_QUERY = `
  query TenantBilling {
    tenantBilling {
      subscription {
        id
        plan
        status
        billingPeriod
        currentPeriodStart
        currentPeriodEnd
        trialEndDate
        monthlyPrice
        currency
      }
      invoices {
        id
        invoiceNumber
        amount
        currency
        status
        issuedAt
        dueDate
        paidAt
        description
      }
      planLimits {
        maxFarms
        maxSensors
        maxUsers
        maxStorage
        currentFarms
        currentSensors
        currentUsers
        currentStorage
      }
      usageMetrics {
        apiCallsThisMonth
        apiCallsLimit
        storageUsedGb
        storageLimit
        sensorReadingsThisMonth
        sensorReadingsLimit
      }
    }
  }
`;

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
