import { useQuery } from '@tanstack/react-query';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';
import { useAuth } from './useAuth';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';

export interface ShiftInfo {
  id: string;
  name: string;
  code: string;
  startTime: string;
  endTime: string;
  totalMinutes: number;
  breakMinutes: number;
  colorCode: string | null;
}

export interface WeeklyPlanEntry {
  id: string;
  date: string;
  dayOfWeek: number;
  entryType: 'work' | 'off' | 'leave' | 'holiday' | 'training';
  shiftId: string | null;
  shift: ShiftInfo | null;
  plannedStartTime: string | null;
  plannedEndTime: string | null;
  plannedMinutes: number;
  isOffDay: boolean;
  isLeaveDay: boolean;
}

export interface WeeklyPlan {
  id: string;
  employeeId: string;
  weekStartDate: string;
  weekEndDate: string;
  status: 'draft' | 'published';
  plannedTotalMinutes: number;
  standardWeeklyMinutes: number;
  plannedOvertimeMinutes: number;
  plannedWorkDays: number;
  plannedOffDays: number;
  entries: WeeklyPlanEntry[];
}

const MY_WEEKLY_PLAN_QUERY = `
  query GetMyWeeklyPlan($weekStartDate: String) {
    mySchedule(weekStartDate: $weekStartDate, limit: 1) {
      items {
        id
        employeeId
        weekStartDate
        weekEndDate
        status
        plannedTotalMinutes
        standardWeeklyMinutes
        plannedOvertimeMinutes
        plannedWorkDays
        plannedOffDays
        entries {
          id
          date
          dayOfWeek
          entryType
          shiftId
          shift {
            id
            name
            code
            startTime
            endTime
            totalMinutes
            breakMinutes
            colorCode
          }
          plannedStartTime
          plannedEndTime
          plannedMinutes
          isOffDay
          isLeaveDay
        }
      }
      total
    }
  }
`;

function getWeekMonday(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

async function fetchMySchedule(
  weekStartDate: string,
): Promise<WeeklyPlan | null> {
  const result = await graphqlRequest<{ mySchedule: { items: WeeklyPlan[]; total: number } }>(
    MY_WEEKLY_PLAN_QUERY,
    { weekStartDate },
  );

  const items = result.mySchedule?.items;
  return items && items.length > 0 ? items[0] : null;
}

export function useMySchedule(weekOffset = 0) {
  const { accessToken, tenantId, user, isAuthenticated } = useAuth();

  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + weekOffset * 7);
  const weekStartDate = getWeekMonday(targetDate);

  const cacheKey = `schedule_${weekStartDate}`;

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'mySchedule', user?.id, weekStartDate),
    queryFn: async () => {
      if (!accessToken || !tenantId || !user?.id) {
        throw new Error('Not authenticated');
      }

      try {
        const plan = await fetchMySchedule(weekStartDate);
        if (plan) {
          // SECURITY (FE-CRITICAL-002): tenantId required for tenant-isolated caching
          await cacheData(tenantId, cacheKey, plan, 1000 * 60 * 30); // 30 min TTL
        }
        return plan;
      } catch (error) {
        // SECURITY (FE-CRITICAL-002): tenantId required for tenant-isolated cache reads
        const cached = await getCachedData<WeeklyPlan>(tenantId, cacheKey);
        if (cached) return cached;
        throw error;
      }
    },
    enabled: isAuthenticated && !!tenantId && !!user?.id,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
  });
}

export function formatMinutesAsHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
