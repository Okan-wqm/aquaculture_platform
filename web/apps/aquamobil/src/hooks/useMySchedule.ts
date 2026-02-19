import { useQuery } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { cacheData, getCachedData } from '@/pwa/offline-queue';

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
  query GetMyWeeklyPlan($employeeId: ID, $weekStartDate: String) {
    weeklyPlans(employeeId: $employeeId, weekStartDate: $weekStartDate, status: published, limit: 1) {
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

interface GraphQLResponse {
  data?: { weeklyPlans: { items: WeeklyPlan[]; total: number } };
  errors?: Array<{ message: string }>;
}

async function fetchMySchedule(
  accessToken: string,
  tenantId: string,
  userId: string,
  weekStartDate: string,
): Promise<WeeklyPlan | null> {
  const response = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-Tenant-Id': tenantId,
      // SEC-06: CSRF defense header
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({
      query: MY_WEEKLY_PLAN_QUERY,
      variables: { employeeId: userId, weekStartDate },
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`);
  }

  const result = (await response.json()) as GraphQLResponse;

  if (result.errors?.length) {
    throw new Error(result.errors[0]?.message || 'Failed to fetch schedule');
  }

  const items = result.data?.weeklyPlans?.items;
  return items && items.length > 0 ? items[0] : null;
}

export function useMySchedule(weekOffset = 0) {
  const { accessToken, tenantId, user, isAuthenticated } = useAuth();

  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + weekOffset * 7);
  const weekStartDate = getWeekMonday(targetDate);

  const cacheKey = `schedule_${weekStartDate}`;

  return useQuery({
    queryKey: ['mySchedule', user?.id, weekStartDate],
    queryFn: async () => {
      if (!accessToken || !tenantId || !user?.id) {
        throw new Error('Not authenticated');
      }

      // BUG-11: Use employeeId (HR system identifier) if available, fall back to
      // auth user.id with a warning. These may differ in deployments where HR IDs
      // are managed independently from auth user IDs.
      const scheduleId = user.employeeId ?? user.id;
      if (!user.employeeId) {
        console.warn(
          'useMySchedule: user.employeeId is not set — falling back to user.id. ' +
          'Schedule lookup may return no results if HR IDs differ from auth IDs.'
        );
      }

      try {
        const plan = await fetchMySchedule(accessToken, tenantId, scheduleId, weekStartDate);
        if (plan) {
          await cacheData(cacheKey, plan, 1000 * 60 * 30); // 30 min TTL
        }
        return plan;
      } catch (error) {
        const cached = await getCachedData<WeeklyPlan>(cacheKey);
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
