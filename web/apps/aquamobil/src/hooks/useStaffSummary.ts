import { useMemo } from 'react';

import { useTodaysAttendance } from './useAttendance';
import { useMyLeaveBalances } from './useLeave';
import { useMySchedule } from './useMySchedule';

import type { StaffSummary } from '@/types';

/**
 * Aggregates existing HR data into a single StaffSummary for the Staff hub.
 *
 * WHY no new backend queries: all data needed for the Staff hub KPIs already
 * exists in hooks that are individually cached by React Query. This hook only
 * combines their outputs via useMemo — it never fires its own network request.
 * This means the Staff hub benefits from cache hits when the user navigates
 * from attendance or leave pages where these hooks were already called.
 */
export function useStaffSummary(): {
  summary: StaffSummary;
  isLoading: boolean;
} {
  // --- Source 1: Clock-in status ---
  const { data: todaysAttendance, isLoading: attendanceLoading } = useTodaysAttendance();

  // --- Source 2: Leave balance ---
  const currentYear = new Date().getFullYear();
  const { data: leaveBalances, isLoading: leaveLoading } = useMyLeaveBalances(currentYear);

  // --- Source 3: Schedule (current week + next week for preview) ---
  const { data: currentWeekPlan, isLoading: scheduleLoading } = useMySchedule(0);

  const { data: nextWeekPlan, isLoading: nextWeekLoading } = useMySchedule(1);

  const summary = useMemo<StaffSummary>(() => {
    // WHY find active clock-in: same logic as useDailyOpsStats. A record
    // with clockIn set but no clockOut means the user is currently on shift.
    const activeRecord = todaysAttendance?.find((r) => r.clockIn && !r.clockOut);

    // WHY sum all remainingDays: the staff hub shows a single "total leave
    // remaining" number across all leave types (annual, sick, etc.).
    const totalLeaveRemaining =
      leaveBalances?.reduce((sum, balance) => sum + (balance.remainingDays ?? 0), 0) ?? 0;

    // WHY search both weeks: if today is Friday and the next work entry is
    // Monday, it lives in next week's plan. Searching only the current week
    // would show null for the "next shift" on weekends.
    const todayStr = new Date().toISOString().split('T')[0];
    const allEntries = [...(currentWeekPlan?.entries ?? []), ...(nextWeekPlan?.entries ?? [])];

    // WHY filter future work entries: off days, leave days, and past dates
    // are irrelevant for the "next shift" preview.
    const futureWorkEntries = allEntries
      .filter((e) => e.date > todayStr && e.entryType === 'work' && !e.isOffDay && !e.isLeaveDay)
      .sort((a, b) => a.date.localeCompare(b.date));

    const nextShiftDate = futureWorkEntries.length > 0 ? futureWorkEntries[0].date : null;

    // WHY schedulePreviewDays: counts how many work days are visible in the
    // two-week window. The hub page uses this to show "X work days ahead".
    const schedulePreviewDays = futureWorkEntries.length;

    return {
      isClockedIn: !!activeRecord,
      clockedInSince: activeRecord?.clockIn ?? null,
      totalLeaveRemaining,
      nextShiftDate,
      schedulePreviewDays,
    };
  }, [todaysAttendance, leaveBalances, currentWeekPlan, nextWeekPlan]);

  const isLoading = attendanceLoading || leaveLoading || scheduleLoading || nextWeekLoading;

  return { summary, isLoading };
}
