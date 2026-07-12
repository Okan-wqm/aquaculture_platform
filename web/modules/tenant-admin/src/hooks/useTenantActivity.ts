/**
 * useTenantActivity Hook
 *
 * Fetches user activity data for the current tenant:
 * - Recent logins
 * - Active sessions count
 * - Per-user activity summaries
 * - Daily active user trend data
 *
 * Uses TanStack Query for data fetching and caching.
 */

import { useTenantQuery } from '@aquaculture/shared-ui';
import { useState, useCallback } from 'react';
import { getTenantActivity } from '../lib/api';
import { logError } from '../utils/error-handling';

// ============================================================================
// Types
// ============================================================================

export interface RecentLogin {
  id: string;
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  loginAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  deviceType: string | null;
  success: boolean;
}

export interface UserActivitySummary {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  totalActions: number;
  lastActiveAt: string | null;
  loginCount: number;
}

export interface DailyActiveUsers {
  date: string;
  count: number;
}

export interface TenantActivityData {
  recentLogins: RecentLogin[];
  activeSessions: number;
  userActivitySummaries: UserActivitySummary[];
  dailyActiveUsers: DailyActiveUsers[];
}

export type ActivityPeriod = '7d' | '30d';

// ============================================================================
// Query Keys
// ============================================================================

// ============================================================================
// Hook
// ============================================================================

export function useTenantActivity() {
  const [period, setPeriod] = useState<ActivityPeriod>('7d');

  // Tenant-scoped key via the useTenantQuery SSoT (cross-tenant cache rule).
  const query = useTenantQuery<TenantActivityData>(
    ['activity', 'summary', period],
    async () => {
      try {
        return await getTenantActivity(period);
      } catch (err) {
        logError('useTenantActivity', err);
        throw err;
      }
    },
    {
      staleTime: 60 * 1000,
      refetchInterval: 2 * 60 * 1000,
    },
  );

  const changePeriod = useCallback((p: ActivityPeriod) => {
    setPeriod(p);
  }, []);

  return {
    recentLogins: query.data?.recentLogins ?? [],
    activeSessions: query.data?.activeSessions ?? 0,
    userSummaries: query.data?.userActivitySummaries ?? [],
    dailyActiveUsers: query.data?.dailyActiveUsers ?? [],
    period,
    changePeriod,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
