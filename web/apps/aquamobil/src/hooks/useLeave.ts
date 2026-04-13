import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { LeaveRequest, LeaveBalance, LeaveType } from '@/types';
import {
  GET_MY_LEAVE_REQUESTS,
  GET_MY_LEAVE_BALANCES,
  GET_LEAVE_TYPES,
  SUBMIT_LEAVE_REQUEST,
  CANCEL_LEAVE_REQUEST,
} from '@/graphql/operations';

// ---------------------------------------------------------------------------
// IndexedDB cache TTLs — longer than React Query staleTime because these
// serve as offline fallback, not the primary freshness mechanism.
// ---------------------------------------------------------------------------
const CACHE_TTL_LEAVE_BALANCES = 1000 * 60 * 60 * 8; // 8 hours
const CACHE_TTL_LEAVE_REQUESTS = 1000 * 60 * 60; // 1 hour
const CACHE_TTL_LEAVE_TYPES = 1000 * 60 * 60 * 24; // 24 hours

// ---------------------------------------------------------------------------
// Fetch helpers — thin wrappers that unwrap the GraphQL envelope.
// ---------------------------------------------------------------------------

async function fetchLeaveBalances(year: number): Promise<LeaveBalance[]> {
  const result = await graphqlRequest<{ myLeaveBalances: LeaveBalance[] }>(
    GET_MY_LEAVE_BALANCES,
    { year },
  );
  return result.myLeaveBalances;
}

async function fetchLeaveRequests(
  status: string | undefined,
  limit: number,
): Promise<LeaveRequest[]> {
  const result = await graphqlRequest<{ myLeaveRequests: LeaveRequest[] }>(
    GET_MY_LEAVE_REQUESTS,
    { status, limit },
  );
  return result.myLeaveRequests;
}

async function fetchLeaveTypes(): Promise<LeaveType[]> {
  const result = await graphqlRequest<{ leaveTypes: LeaveType[] }>(
    GET_LEAVE_TYPES,
  );
  return result.leaveTypes;
}

// ---------------------------------------------------------------------------
// READ hooks — migrated to React Query with IndexedDB offline fallback.
// Pattern follows useTanks.ts: network-first, fall back to IndexedDB on error.
// ---------------------------------------------------------------------------

/** Caller-supplied overrides for the leave balances query. */
interface LeaveQueryOptions {
  /** Force a network fetch every time the component mounts, even if
   *  cached data is still within staleTime. Use 'always' on pages that
   *  follow a mutation (e.g. MyLeavesPage after submit). */
  refetchOnMount?: boolean | 'always';
}

/**
 * Fetches leave balances for a given year.
 *
 * @param year - Calendar year for balance lookup.
 * @param options - Optional React Query overrides (e.g. refetchOnMount).
 *
 * WHY year is a parameter instead of internal state: React Query re-fetches
 * automatically when the queryKey changes, so passing year as an argument
 * lets callers control which year to display without imperative `fetch()`.
 */
export function useMyLeaveBalances(
  year: number = new Date().getFullYear(),
  options?: LeaveQueryOptions,
) {
  const { accessToken, tenantId, isAuthenticated } = useAuth();

  // WHY tenantId + year in queryKey: prevents cross-tenant cache collision
  // and ensures year changes trigger a refetch automatically.
  const cacheKey = `leaveBalances-${tenantId}-${year}`;

  return useQuery<LeaveBalance[]>({
    queryKey: ['leaveBalances', tenantId, year],
    queryFn: async () => {
      if (!accessToken || !tenantId) {
        throw new Error('Not authenticated');
      }

      try {
        const balances = await fetchLeaveBalances(year);
        // Write to IndexedDB as offline fallback only — React Query's own
        // gcTime handles in-memory caching for the online path.
        // SECURITY (FE-CRITICAL-002): tenantId required for tenant-isolated caching
        await cacheData(tenantId!, cacheKey, balances, CACHE_TTL_LEAVE_BALANCES);
        return balances;
      } catch (error) {
        // Network failed — return IndexedDB cached data if available
        const cached = await getCachedData<LeaveBalance[]>(tenantId!, cacheKey);
        if (cached) {
          return cached;
        }
        throw error;
      }
    },
    enabled: isAuthenticated && !!tenantId,
    // WHY 5 min staleTime: balances change infrequently (only when requests
    // are approved/cancelled), so aggressive refetching is wasteful.
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 60, // 1 hour in-memory retention
    // WHY: callers like MyLeavesPage set refetchOnMount: 'always' so that
    // navigating back from LeaveRequestPage triggers a fresh fetch even when
    // in-memory data is within staleTime.
    refetchOnMount: options?.refetchOnMount,
  });
}

/**
 * Fetches leave requests with optional status filter and limit.
 *
 * @param status - Optional status filter (e.g. 'PENDING', 'APPROVED').
 * @param limit - Maximum number of records to return.
 * @param options - Optional React Query overrides (e.g. refetchOnMount).
 *
 * WHY status and limit are parameters: React Query will refetch when the
 * queryKey (which includes these values) changes, giving callers declarative
 * control over the request without imperative `fetch()` calls.
 */
export function useMyLeaveRequests(
  status?: string,
  limit: number = 20,
  options?: LeaveQueryOptions,
) {
  const { accessToken, tenantId, isAuthenticated } = useAuth();

  // WHY status and limit in cache key: different filter combos produce
  // different result sets that must be cached independently.
  const cacheKey = `leaveRequests-${tenantId}-${status ?? 'all'}-${limit}`;

  return useQuery<LeaveRequest[]>({
    queryKey: ['leaveRequests', tenantId, status, limit],
    queryFn: async () => {
      if (!accessToken || !tenantId) {
        throw new Error('Not authenticated');
      }

      try {
        const requests = await fetchLeaveRequests(status, limit);
        // SECURITY (FE-CRITICAL-002): tenantId required for tenant-isolated caching
        await cacheData(tenantId!, cacheKey, requests, CACHE_TTL_LEAVE_REQUESTS);
        return requests;
      } catch (error) {
        const cached = await getCachedData<LeaveRequest[]>(tenantId!, cacheKey);
        if (cached) {
          return cached;
        }
        throw error;
      }
    },
    enabled: isAuthenticated && !!tenantId,
    // WHY 2 min staleTime: requests change more frequently than balances
    // (new submissions, status transitions), so shorter staleness window.
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 30, // 30 minutes in-memory retention
    // WHY: callers like MyLeavesPage set refetchOnMount: 'always' so that
    // navigating back from LeaveRequestPage triggers a fresh fetch even when
    // in-memory data is within staleTime.
    refetchOnMount: options?.refetchOnMount,
  });
}

/**
 * Fetches available leave types for the current tenant.
 */
export function useLeaveTypes() {
  const { accessToken, tenantId, isAuthenticated } = useAuth();

  const cacheKey = `leaveTypes-${tenantId}`;

  return useQuery<LeaveType[]>({
    queryKey: ['leaveTypes', tenantId],
    queryFn: async () => {
      if (!accessToken || !tenantId) {
        throw new Error('Not authenticated');
      }

      try {
        const types = await fetchLeaveTypes();
        // SECURITY (FE-CRITICAL-002): tenantId required for tenant-isolated caching
        await cacheData(tenantId!, cacheKey, types, CACHE_TTL_LEAVE_TYPES);
        return types;
      } catch (error) {
        const cached = await getCachedData<LeaveType[]>(tenantId!, cacheKey);
        if (cached) {
          return cached;
        }
        throw error;
      }
    },
    enabled: isAuthenticated && !!tenantId,
    // WHY 30 min staleTime: leave types are admin-configured reference data
    // that rarely changes during a user session.
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60 * 2, // 2 hours in-memory retention
  });
}

// ---------------------------------------------------------------------------
// MUTATION hooks — use React Query useMutation with cache invalidation so
// that readback (MyLeavesPage) converges immediately after mutation success.
// ---------------------------------------------------------------------------

/**
 * Submits a draft leave request for approval.
 *
 * WHY: invalidates both leaveRequests (status changes from DRAFT to PENDING)
 * and leaveBalances (pendingDays increases) so the readback page shows the
 * new state immediately without waiting for staleTime to expire.
 */
export function useSubmitLeaveRequest(): { submit: (id: string) => Promise<void>; loading: boolean } {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (id: string) => {
      await graphqlRequest(SUBMIT_LEAVE_REQUEST, { id });
    },
    onSuccess: () => {
      // WHY: prefix-only invalidation matches all variants of these queries
      // (any status filter, limit, tenantId, year combination) so every
      // mounted consumer gets fresh data after a state-changing mutation.
      void queryClient.invalidateQueries({ queryKey: ['leaveRequests'] });
      void queryClient.invalidateQueries({ queryKey: ['leaveBalances'] });
    },
  });

  const submit = useCallback(
    async (id: string): Promise<void> => {
      await mutation.mutateAsync(id);
    },
    [mutation],
  );

  return { submit, loading: mutation.isPending };
}

/**
 * Cancels a pending or draft leave request.
 *
 * WHY: invalidates leaveRequests (status changes to CANCELLED) and
 * leaveBalances (pendingDays decreases, remainingDays increases) so the
 * readback reflects the cancellation without stale cache lag.
 */
export function useCancelLeaveRequest(): { cancel: (id: string) => Promise<void>; loading: boolean } {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (id: string) => {
      await graphqlRequest(CANCEL_LEAVE_REQUEST, { id });
    },
    onSuccess: () => {
      // WHY: same prefix-only invalidation pattern as useSubmitLeaveRequest
      // to ensure all mounted leave query variants refetch.
      void queryClient.invalidateQueries({ queryKey: ['leaveRequests'] });
      void queryClient.invalidateQueries({ queryKey: ['leaveBalances'] });
    },
  });

  const cancel = useCallback(
    async (id: string): Promise<void> => {
      await mutation.mutateAsync(id);
    },
    [mutation],
  );

  return { cancel, loading: mutation.isPending };
}
