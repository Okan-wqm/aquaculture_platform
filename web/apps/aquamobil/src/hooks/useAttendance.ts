import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useAuth } from './useAuth';
import { useOfflineCacheScope } from './useOfflineCacheScope';

import {
  GET_MY_ATTENDANCE_RECORDS,
  GET_MY_ATTENDANCE_SUMMARY,
  GET_TODAYS_ATTENDANCE,
} from '@/graphql/operations';
import { readThroughOfflineCache } from '@/pwa/offline-cache';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { AttendanceRecord, AttendanceSummary } from '@/types';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

// =============================================================================
// Cache TTL constants (IndexedDB offline fallback — not React Query in-memory)
// =============================================================================
// WHY: These TTLs govern how long IndexedDB retains data for offline-first
// scenarios (e.g., fish farm with spotty connectivity). React Query's own
// staleTime/gcTime handle the in-memory caching layer independently.
const CACHE_TTL_1H = 1000 * 60 * 60; // 1 hour
const CACHE_TTL_30M = 1000 * 60 * 30; // 30 minutes

// =============================================================================
// Attendance Records — date-range based list of clock-in/out events
// =============================================================================

interface AttendanceRecordsParams {
  /** ISO date string (YYYY-MM-DD). Defaults to 7 days ago when omitted. */
  startDate?: string;
  /** ISO date string (YYYY-MM-DD). Defaults to today when omitted. */
  endDate?: string;
  /** Maximum number of records to return. Defaults to 30. */
  limit?: number;
}

/**
 * Fetches the authenticated user's attendance records for a given date range.
 *
 * WHY React Query: eliminates duplicate network calls when multiple components
 * render this hook with the same parameters. staleTime=2min means the data is
 * served instantly from cache for navigating back to the page.
 *
 * WHY IndexedDB fallback: when the network is down (common on offshore farms),
 * the last successful response is returned from encrypted IndexedDB storage so
 * the operator can still see their recent attendance.
 */
export function useMyAttendanceRecords(
  params: AttendanceRecordsParams = {},
): UseQueryResult<AttendanceRecord[], Error> {
  const { tenantId, user, isAuthenticated } = useAuth();
  const cacheScope = useOfflineCacheScope();

  // WHY defaults here: the page always wants "last 7 days" on mount. Providing
  // sensible defaults means the caller doesn't need a useEffect to trigger fetch.
  const endDate = params.endDate ?? new Date().toISOString().split('T')[0];
  const startDate =
    params.startDate ?? new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const limit = params.limit ?? 30;

  return useQuery<AttendanceRecord[]>({
    // WHY include dates + limit: different date ranges must not share cached data.
    // SECURITY (MT-CRITICAL-051): myAttendanceRecords are the CURRENT user's
    // private records — user.id partitions both the React Query key and the
    // IndexedDB cache key so a shared-device second user never sees them.
    queryKey: createTenantQueryKey(tenantId, 'attendanceRecords', user?.id, startDate, endDate, limit),
    queryFn: async () => {
      if (!tenantId || !user?.id) return [];

      // WHY the offline copy: network failures are expected on fish farms, and
      // stale records beat an error screen — while the server is unreachable;
      // a refusal surfaces and purges the copy (MOB-MEDIUM-031).
      const read = await readThroughOfflineCache(
        cacheScope,
        { key: `attendance-records:${startDate}:${endDate}:${limit}`, ttlMs: CACHE_TTL_30M },
        async (): Promise<AttendanceRecord[]> => {
          const result = await graphqlRequest(GET_MY_ATTENDANCE_RECORDS, {
            startDate,
            endDate,
            limit,
          });
          return result.myAttendanceRecords;
        },
      );
      return read.data;
    },
    // WHY enabled guard: prevents firing a request before auth is ready,
    // which would always 401 and pollute the error state.
    enabled: isAuthenticated && !!tenantId && !!user?.id,
    // WHY 2min staleTime: attendance records change infrequently during a session
    // (only on clock-in/out). 2 minutes avoids redundant re-fetches when
    // navigating between pages while still picking up new data promptly.
    staleTime: 1000 * 60 * 2,
    // WHY 30min gcTime: keeps data in memory for tab-switching scenarios.
    // After 30min of being unused, React Query garbage-collects and the next
    // visit will hit the network (or IndexedDB if offline).
    gcTime: 1000 * 60 * 30,
  });
}

// =============================================================================
// Attendance Summary — monthly aggregates (worked hours, overtime, rate)
// =============================================================================

interface AttendanceSummaryParams {
  /** 1-12. Defaults to current month. */
  month?: number;
  /** Four-digit year. Defaults to current year. */
  year?: number;
}

/**
 * Fetches a monthly attendance summary for the authenticated user.
 *
 * WHY month+year in queryKey: each month's summary is an independent dataset.
 * When the user switches months, React Query fetches fresh data without
 * invalidating the current month's cache.
 */
export function useMyAttendanceSummary(
  params: AttendanceSummaryParams = {},
): UseQueryResult<AttendanceSummary | null, Error> {
  const { tenantId, user, isAuthenticated } = useAuth();
  const cacheScope = useOfflineCacheScope();

  const now = new Date();
  const month = params.month ?? now.getMonth() + 1;
  const year = params.year ?? now.getFullYear();

  return useQuery<AttendanceSummary | null>({
    // SECURITY (MT-CRITICAL-051): myAttendanceSummary is the CURRENT user's
    // private monthly summary — user.id partitions both keys. month + year still
    // cache each month independently.
    queryKey: createTenantQueryKey(tenantId, 'attendanceSummary', user?.id, month, year),
    queryFn: async () => {
      if (!tenantId || !user?.id) return null;

      const read = await readThroughOfflineCache(
        cacheScope,
        { key: `attendance-summary:${year}:${month}`, ttlMs: CACHE_TTL_1H },
        async (): Promise<AttendanceSummary | null> => {
          const result = await graphqlRequest(GET_MY_ATTENDANCE_SUMMARY, { month, year });
          return result.myAttendanceSummary;
        },
      );
      return read.data;
    },
    enabled: isAuthenticated && !!tenantId && !!user?.id,
    // WHY 5min staleTime: summaries only change when a new attendance record is
    // created (at most twice per day — clock in + out). 5 minutes is generous
    // enough to avoid mid-session re-fetches without hiding real changes.
    staleTime: 1000 * 60 * 5,
    // WHY 1h gcTime: the monthly summary view is visited repeatedly throughout
    // the day. Keeping it cached for 1 hour avoids unnecessary network calls.
    gcTime: CACHE_TTL_1H,
  });
}

// =============================================================================
// Today's Attendance — real-time clock-in/out status for the authenticated employee
// =============================================================================

/**
 * Fetches today's attendance records for the current employee.
 * The backend resolves auth user id -> HR employee id, so the mobile app never
 * guesses HR identifiers from token fields.
 */
export function useTodaysAttendance(): UseQueryResult<AttendanceRecord[], Error> {
  const { tenantId, user, isAuthenticated } = useAuth();
  const cacheScope = useOfflineCacheScope();

  return useQuery<AttendanceRecord[]>({
    // SECURITY (MT-CRITICAL-051): today's attendance is the CURRENT user's
    // clock-in/out state — user.id partitions both the React Query key and the
    // IndexedDB cache key so user B never inherits user A's "already clocked in".
    queryKey: createTenantQueryKey(tenantId, 'todaysAttendance', user?.id),
    queryFn: async () => {
      if (!tenantId || !user?.id) return [];

      // WHY the offline copy: today's attendance drives the clock-in/out button
      // state. Stale data (e.g., "already clocked in") beats a broken button the
      // operator can't use at all — while the server is unreachable.
      const read = await readThroughOfflineCache(
        cacheScope,
        { key: 'todays-attendance', ttlMs: CACHE_TTL_1H },
        async (): Promise<AttendanceRecord[]> => {
          const result = await graphqlRequest(GET_TODAYS_ATTENDANCE);
          return result.myTodaysAttendance;
        },
      );
      return read.data;
    },
    enabled: isAuthenticated && !!tenantId && !!user?.id,
    // WHY 30s staleTime: clock-in/out is the primary real-time action on this
    // page. 30 seconds keeps the status reasonably fresh without being aggressive.
    staleTime: 1000 * 30,
    // WHY 1h gcTime: the attendance page is the most-visited hub page. Keeping
    // today's data in memory avoids a loading spinner every time the user returns.
    gcTime: CACHE_TTL_1H,
    // WHY refetchOnWindowFocus: when the user switches back to the app (e.g.,
    // after checking a message), the clock-in status should be current.
    refetchOnWindowFocus: true,
  });
}
