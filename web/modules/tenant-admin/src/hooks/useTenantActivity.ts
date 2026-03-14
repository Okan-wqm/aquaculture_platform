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

import { useQuery } from '@tanstack/react-query';
import { useState, useCallback } from 'react';
import { graphqlRequest } from '../services/tenant-api.service';
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
// GraphQL Query
// ============================================================================

const TENANT_ACTIVITY_QUERY = `
  query TenantActivity($period: String) {
    tenantActivity(period: $period) {
      recentLogins {
        id
        userId
        email
        firstName
        lastName
        loginAt
        ipAddress
        userAgent
        deviceType
        success
      }
      activeSessions
      userActivitySummaries {
        userId
        email
        firstName
        lastName
        totalActions
        lastActiveAt
        loginCount
      }
      dailyActiveUsers {
        date
        count
      }
    }
  }
`;

// ============================================================================
// Query Keys
// ============================================================================

export const activityKeys = {
  all: ['tenant-activity'] as const,
  summary: (period: ActivityPeriod) =>
    [...activityKeys.all, 'summary', period] as const,
};

// ============================================================================
// Hook
// ============================================================================

export function useTenantActivity() {
  const [period, setPeriod] = useState<ActivityPeriod>('7d');

  const query = useQuery({
    queryKey: activityKeys.summary(period),
    queryFn: async (): Promise<TenantActivityData> => {
      try {
        const data = await graphqlRequest<{ tenantActivity: TenantActivityData }>(
          TENANT_ACTIVITY_QUERY,
          { period },
        );
        return data.tenantActivity;
      } catch (err) {
        logError('useTenantActivity', err);
        throw err;
      }
    },
    staleTime: 60 * 1000, // 1 minute
    refetchInterval: 2 * 60 * 1000, // Refetch every 2 minutes
  });

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
