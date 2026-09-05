import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';


import { useTodaysAttendance } from './useAttendance';
import { useAuth } from './useAuth';

import type { FeedingDayPlansQuery, GetTodaysDailyOpsCountsQuery } from '@/generated/graphql';
import { GET_FEEDING_DAY_PLANS, GET_TASK_STATS, GET_TODAYS_DAILY_OPS_COUNTS } from '@/graphql/operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { DailyOpsStats, TaskStats } from '@/types';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

// MOB-HIGH-019: the day-plan slice is the generated result of the SAME document
// RecordFeedingPage reads (Faz 6 öğün cutover'ı — sayım aggregate ile aynı
// semantik: fed|skipped / iptal-dışı). Meal status is the generated
// FeedingMealStatus enum, so the comparisons below are checked against the
// wire vocabulary instead of a `string`.
type FeedingDayPlanSlice = FeedingDayPlansQuery['feedingDayPlans'][number];
type DailyOpsCountsResponse = GetTodaysDailyOpsCountsQuery['todaysDailyOpsCounts'];

/**
 * Aggregates clock-in (HR), feeding (farm), mortality/WQ (farm), and task
 * stats into one DailyOpsStats for the Daily Operations hub KPI cards.
 *
 * WHY aggregation hook: normalizes 4 data sources into one shape with a
 * single isLoading flag, avoiding 4+ loading states in the page component.
 */
export function useDailyOpsStats(): { stats: DailyOpsStats; isLoading: boolean } {
  const { tenantId, isAuthenticated } = useAuth();

  // Source 1: Clock-in status (React Query, already migrated)
  const { data: todaysAttendance, isLoading: attendanceLoading } = useTodaysAttendance();

  // Source 2: Feeding plan progress
  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);

  const { data: dayPlans, isLoading: feedingLoading } = useQuery<FeedingDayPlanSlice[]>({
    queryKey: createTenantQueryKey(tenantId, 'feedingDayPlans', tenantId, todayStr),
    queryFn: async () => {
      const result = await graphqlRequest(
        GET_FEEDING_DAY_PLANS, { planDate: todayStr },
      );
      return result.feedingDayPlans;
    },
    enabled: isAuthenticated && !!tenantId,
    staleTime: 1000 * 60 * 5, // WHY 5min: feeding plan changes infrequently
    gcTime: 1000 * 60 * 30,
  });

  // Source 3: Task stats (totalToday, completedToday)
  const { data: taskStats, isLoading: taskStatsLoading } = useQuery<TaskStats>({
    queryKey: createTenantQueryKey(tenantId, 'taskStats', tenantId),
    queryFn: async () => {
      const result = await graphqlRequest(GET_TASK_STATS);
      return result.taskStats;
    },
    enabled: isAuthenticated && !!tenantId,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 30,
  });

  // Source 4: Mortality + WQ counts from the farm mobile aggregate resolver.
  const { data: opsCounts, isLoading: opsCountsLoading } = useQuery<DailyOpsCountsResponse>({
    queryKey: createTenantQueryKey(tenantId, 'dailyOpsCounts', tenantId),
    queryFn: async () => {
      const result = await graphqlRequest(
        GET_TODAYS_DAILY_OPS_COUNTS,
      );
      return result.todaysDailyOpsCounts;
    },
    enabled: isAuthenticated && !!tenantId,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
  });

  // Combine all sources
  const stats = useMemo<DailyOpsStats>(() => {
    // WHY: a record with clockIn but no clockOut means the user is on shift.
    const activeRecord = todaysAttendance?.find((r) => r.clockIn && !r.clockOut);

    // WHY: prefer aggregate query counts because they include all units. While
    // the aggregate request is loading, the local day-plan query provides the
    // SAME meal semantics (fed|skipped / cancelled-dışı) as the backend count.
    const meals = (dayPlans ?? []).flatMap((plan) => plan.meals ?? []);
    const feedCompleted = opsCounts?.feedingTotalCount
      ? opsCounts.feedingCompletedCount
      : meals.filter((m) => m.status === 'FED' || m.status === 'SKIPPED').length;
    const feedTotal = opsCounts?.feedingTotalCount
      ? opsCounts.feedingTotalCount
      : meals.filter((m) => m.status !== 'CANCELLED').length;

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
  }, [todaysAttendance, dayPlans, taskStats, opsCounts]);

  return {
    stats,
    isLoading: attendanceLoading || feedingLoading || taskStatsLoading || opsCountsLoading,
  };
}
