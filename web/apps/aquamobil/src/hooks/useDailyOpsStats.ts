import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';
import { useAuth } from './useAuth';
import { useTodaysAttendance } from './useAttendance';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { GET_TODAYS_FEEDING_PLAN, GET_TASK_STATS, GET_TODAYS_DAILY_OPS_COUNTS } from '@/graphql/operations';
import type { DailyOpsStats, TaskStats } from '@/types';

// WHY inline type: mirrors GraphQL response shape used only here.
interface FeedingExecutionSlice { status: string }

// WHY explicit shape: backend aggregate returns flat counts, not entity lists.
interface DailyOpsCountsResponse {
  mortalityCount: number;
  wqReadingsCount: number;
  feedingCompletedCount: number;
  feedingTotalCount: number;
}

/**
 * Aggregates clock-in (HR), feeding (farm), mortality/WQ (farm), and task
 * stats into one DailyOpsStats for the Daily Operations hub KPI cards.
 *
 * WHY aggregation hook: normalizes 4 data sources into one shape with a
 * single isLoading flag, avoiding 4+ loading states in the page component.
 */
export function useDailyOpsStats(): { stats: DailyOpsStats; isLoading: boolean } {
  const { tenantId, isAuthenticated, user } = useAuth();
  // WHY employeeId fallback: BUG-11 — employeeId and user.id can diverge.
  const employeeId = user?.employeeId ?? user?.id;

  // Source 1: Clock-in status (React Query, already migrated)
  const { data: todaysAttendance, isLoading: attendanceLoading } = useTodaysAttendance(employeeId);

  // Source 2: Feeding plan progress
  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);

  const { data: feedingExecutions, isLoading: feedingLoading } = useQuery<FeedingExecutionSlice[]>({
    queryKey: createTenantQueryKey(tenantId, 'feedingPlan', tenantId, todayStr),
    queryFn: async () => {
      const result = await graphqlRequest<{ dailyFeedingExecutions: FeedingExecutionSlice[] }>(
        GET_TODAYS_FEEDING_PLAN, { date: todayStr },
      );
      return result.dailyFeedingExecutions ?? [];
    },
    enabled: isAuthenticated && !!tenantId,
    staleTime: 1000 * 60 * 5, // WHY 5min: feeding plan changes infrequently
    gcTime: 1000 * 60 * 30,
  });

  // Source 3: Task stats (totalToday, completedToday)
  const { data: taskStats, isLoading: taskStatsLoading } = useQuery<TaskStats>({
    queryKey: createTenantQueryKey(tenantId, 'taskStats', tenantId),
    queryFn: async () => {
      const result = await graphqlRequest<{ taskStats: TaskStats }>(GET_TASK_STATS);
      return result.taskStats;
    },
    enabled: isAuthenticated && !!tenantId,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 30,
  });

  // Source 4: Mortality + WQ counts (new aggregate query)
  // WHY graceful fallback: backend resolver may not be deployed yet.
  const { data: opsCounts, isLoading: opsCountsLoading } = useQuery<DailyOpsCountsResponse>({
    queryKey: createTenantQueryKey(tenantId, 'dailyOpsCounts', tenantId),
    queryFn: async () => {
      try {
        const result = await graphqlRequest<{ todaysDailyOpsCounts: DailyOpsCountsResponse }>(
          GET_TODAYS_DAILY_OPS_COUNTS,
        );
        return result.todaysDailyOpsCounts;
      } catch {
        // WHY swallow: resolver may not exist yet — return zeros so hub renders.
        return { mortalityCount: 0, wqReadingsCount: 0, feedingCompletedCount: 0, feedingTotalCount: 0 };
      }
    },
    enabled: isAuthenticated && !!tenantId,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
    retry: false, // WHY: if resolver doesn't exist, retrying wastes time
  });

  // Combine all sources
  const stats = useMemo<DailyOpsStats>(() => {
    // WHY: a record with clockIn but no clockOut means the user is on shift.
    const activeRecord = todaysAttendance?.find((r) => r.clockIn && !r.clockOut);

    // WHY fallback: prefer aggregate query counts (include all tanks); fall
    // back to counting execution statuses from the feeding plan query.
    const feedCompleted = opsCounts?.feedingTotalCount
      ? opsCounts.feedingCompletedCount
      : (feedingExecutions?.filter((e) => e.status === 'COMPLETED').length ?? 0);
    const feedTotal = opsCounts?.feedingTotalCount
      ? opsCounts.feedingTotalCount
      : (feedingExecutions?.length ?? 0);

    return {
      isClockedIn: !!activeRecord,
      clockedInSince: activeRecord?.clockIn ?? null,
      tanksFedToday: feedCompleted,
      totalTanksToFeed: feedTotal,
      mortalityCountToday: opsCounts?.mortalityCount ?? 0,
      wqReadingsToday: opsCounts?.wqReadingsCount ?? 0,
      todaysTasksCompleted: taskStats?.completedToday ?? 0,
      todaysTasksTotal: taskStats?.totalToday ?? 0,
    };
  }, [todaysAttendance, feedingExecutions, taskStats, opsCounts]);

  return {
    stats,
    isLoading: attendanceLoading || feedingLoading || taskStatsLoading || opsCountsLoading,
  };
}
