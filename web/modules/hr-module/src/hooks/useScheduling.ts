/**
 * Scheduling Hooks
 * TanStack Query hooks for weekly workforce planning
 */

import {
  useQueries,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useFeedbackMutation } from '@aquaculture/shared-ui';
import { useGraphQLClient, graphqlRequest } from './useGraphQL';
import {
  GET_WEEKLY_PLANS,
  GET_WEEKLY_PLAN,
  GET_TEAM_WEEKLY_OVERVIEW,
  GET_SCHEDULING_SETTINGS,
  GET_OVERTIME_SUMMARY,
  CREATE_WEEKLY_PLAN,
  UPDATE_PLAN_ENTRY,
  BULK_ASSIGN_SHIFTS,
  COPY_WEEKLY_PLAN,
  PUBLISH_WEEKLY_PLAN,
  DELETE_WEEKLY_PLAN,
  UPDATE_SCHEDULING_SETTINGS,
} from '../graphql/scheduling.operations';
import type {
  WeeklyPlan,
  WeeklyPlanEntry,
  WeeklyPlanConnection,
  TeamWeeklyOverview,
  SchedulingSettings,
  OvertimeSummary,
  BulkAssignResult,
  CreateWeeklyPlanInput,
  UpdatePlanEntryInput,
  BulkAssignShiftsInput,
  ShiftAssignmentInput,
  UpdateSchedulingSettingsInput,
  WeeklyPlanFilter,
  WeeklyPlanStatus,
  WeekDay,
} from '../types/scheduling.types';

// Query Keys
export const schedulingKeys = {
  all: ['scheduling'] as const,
  weeklyPlans: () => [...schedulingKeys.all, 'weeklyPlans'] as const,
  weeklyPlanList: (filter?: WeeklyPlanFilter, limit?: number, page?: number) =>
    [...schedulingKeys.weeklyPlans(), { filter, limit, page }] as const,
  weeklyPlan: (id: string) => [...schedulingKeys.weeklyPlans(), id] as const,
  /** Every overview of one week, whatever its department / site filter — the invalidation prefix. */
  teamOverviewWeek: (weekStartDate: string) =>
    [...schedulingKeys.all, 'teamOverview', weekStartDate] as const,
  teamOverview: (weekStartDate: string, departmentId?: string, siteId?: string) =>
    [...schedulingKeys.teamOverviewWeek(weekStartDate), departmentId, siteId] as const,
  settings: () => [...schedulingKeys.all, 'settings'] as const,
  overtimeSummary: (month: number, year: number, employeeId?: string, departmentId?: string) =>
    [...schedulingKeys.all, 'overtime', month, year, employeeId, departmentId] as const,
};

// =====================
// Weekly Plan Queries
// =====================

export function useWeeklyPlans(filter?: WeeklyPlanFilter, limit = 20, page = 1) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: schedulingKeys.weeklyPlanList(filter, limit, page),
    queryFn: () =>
      graphqlRequest<{ weeklyPlans: WeeklyPlanConnection }, unknown>(client, GET_WEEKLY_PLANS, {
        employeeId: filter?.employeeId,
        departmentId: filter?.departmentId,
        siteId: filter?.siteId,
        weekStartDate: filter?.weekStartDate,
        status: filter?.status,
        limit,
        page,
      }),
    select: (data) => data.weeklyPlans,
  });
}

export function useWeeklyPlan(id: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: schedulingKeys.weeklyPlan(id),
    queryFn: () =>
      graphqlRequest<{ weeklyPlan: WeeklyPlan }, unknown>(client, GET_WEEKLY_PLAN, { id }),
    select: (data) => data.weeklyPlan,
    enabled: !!id,
  });
}

export function useTeamWeeklyOverview(
  weekStartDate: string,
  departmentId?: string,
  siteId?: string,
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: schedulingKeys.teamOverview(weekStartDate, departmentId, siteId),
    queryFn: () =>
      graphqlRequest<{ teamWeeklyOverview: TeamWeeklyOverview }, unknown>(
        client,
        GET_TEAM_WEEKLY_OVERVIEW,
        { weekStartDate, departmentId, siteId },
      ),
    select: (data) => data.teamWeeklyOverview,
    enabled: !!weekStartDate,
  });
}

/**
 * One overview per visible week, under the same keys `useTeamWeeklyOverview`
 * uses: the roster's month view spans up to six weeks, and a cell saved from
 * either view repaints in the other from the shared cache.
 */
export function useTeamWeeklyOverviews(
  weekStartDates: readonly string[],
  departmentId?: string,
  siteId?: string,
): UseQueryResult<TeamWeeklyOverview>[] {
  const client = useGraphQLClient();

  return useQueries({
    queries: weekStartDates.map((weekStartDate) => ({
      queryKey: schedulingKeys.teamOverview(weekStartDate, departmentId, siteId),
      queryFn: () =>
        graphqlRequest<{ teamWeeklyOverview: TeamWeeklyOverview }, unknown>(
          client,
          GET_TEAM_WEEKLY_OVERVIEW,
          { weekStartDate, departmentId, siteId },
        ),
      select: (data: { teamWeeklyOverview: TeamWeeklyOverview }) => data.teamWeeklyOverview,
    })),
  });
}

export function useSchedulingSettings() {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: schedulingKeys.settings(),
    queryFn: () =>
      graphqlRequest<{ schedulingSettings: SchedulingSettings }, unknown>(
        client,
        GET_SCHEDULING_SETTINGS,
        {},
      ),
    select: (data) => data.schedulingSettings,
  });
}

export function useOvertimeSummary(
  month: number,
  year: number,
  employeeId?: string,
  departmentId?: string,
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: schedulingKeys.overtimeSummary(month, year, employeeId, departmentId),
    queryFn: () =>
      graphqlRequest<{ overtimeSummary: OvertimeSummary }, unknown>(client, GET_OVERTIME_SUMMARY, {
        month,
        year,
        employeeId,
        departmentId,
      }),
    select: (data) => data.overtimeSummary,
    // BUG-013: !!year is falsy for year=0 which won't happen in practice, but use
    // explicit null checks so month=0 (January) is correctly handled
    enabled: month != null && year != null && year > 0,
  });
}

// =====================
// Weekly Plan Mutations
// =====================

export function useCreateWeeklyPlan() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useFeedbackMutation({
    feedback: { success: 'Weekly plan created' },
    mutationFn: (input: CreateWeeklyPlanInput) =>
      graphqlRequest<{ createWeeklyPlan: WeeklyPlan }, unknown>(client, CREATE_WEEKLY_PLAN, {
        input,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: schedulingKeys.weeklyPlans() });
      queryClient.invalidateQueries({ queryKey: schedulingKeys.all });
    },
  });
}

export function useUpdatePlanEntry() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useFeedbackMutation({
    feedback: { success: 'Plan entry updated' },
    mutationFn: (input: UpdatePlanEntryInput) =>
      graphqlRequest<{ updatePlanEntry: WeeklyPlanEntry }, unknown>(client, UPDATE_PLAN_ENTRY, {
        input,
      }),
    onSuccess: (_data, variables) => {
      // Invalidate the specific weekly plan and list
      queryClient.invalidateQueries({ queryKey: schedulingKeys.weeklyPlans() });
      queryClient.invalidateQueries({ queryKey: schedulingKeys.all });
    },
  });
}

export function useBulkAssignShifts() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useFeedbackMutation({
    feedback: { success: 'Shifts assigned' },
    mutationFn: (input: BulkAssignShiftsInput) =>
      graphqlRequest<{ bulkAssignShifts: BulkAssignResult }, unknown>(client, BULK_ASSIGN_SHIFTS, {
        input,
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: schedulingKeys.weeklyPlan(variables.weeklyPlanId),
      });
      queryClient.invalidateQueries({ queryKey: schedulingKeys.weeklyPlans() });
    },
  });
}

export function useCopyWeeklyPlan() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useFeedbackMutation({
    feedback: { success: 'Weekly plan copied' },
    mutationFn: ({
      sourceId,
      targetWeekStartDate,
    }: {
      sourceId: string;
      targetWeekStartDate: string;
    }) =>
      graphqlRequest<{ copyWeeklyPlan: WeeklyPlan }, unknown>(client, COPY_WEEKLY_PLAN, {
        sourceId,
        targetWeekStartDate,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: schedulingKeys.weeklyPlans() });
    },
  });
}

export function usePublishWeeklyPlan() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useFeedbackMutation({
    feedback: { success: 'Weekly plan published' },
    mutationFn: (id: string) =>
      graphqlRequest<{ publishWeeklyPlan: WeeklyPlan }, unknown>(client, PUBLISH_WEEKLY_PLAN, {
        id,
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: schedulingKeys.weeklyPlan(data.publishWeeklyPlan.id),
      });
      queryClient.invalidateQueries({ queryKey: schedulingKeys.weeklyPlans() });
    },
  });
}

// =====================
// Roster cell mutations (WeeklySchedulePage)
// =====================

/** One roster cell's new value: a shift, or `null` for an off day. */
export interface ScheduleCellAssignment {
  employeeId: string;
  /** ISO Monday of the cell's week. */
  weekStartDate: string;
  /** The employee's plan for that week; `undefined` when the week has none yet, so one is created first. */
  weeklyPlanId: string | undefined;
  /** ISO date of the cell. */
  date: string;
  shiftId: string | null;
}

/**
 * Saves one roster cell through the scheduling API: creates the employee's
 * weekly plan when the week has none, then assigns the day. The refetched
 * overview repaints the cell, so success is silent; the API's per-entry
 * refusals (a leave day, an inactive shift) become the error toast.
 */
export function useAssignScheduleCell(): UseMutationResult<
  BulkAssignResult,
  Error,
  ScheduleCellAssignment
> {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useFeedbackMutation<BulkAssignResult, Error, ScheduleCellAssignment>({
    feedback: { success: null, error: 'The shift was not assigned' },
    mutationFn: async (input) => {
      let weeklyPlanId = input.weeklyPlanId;
      if (weeklyPlanId === undefined) {
        const created = await graphqlRequest<{ createWeeklyPlan: WeeklyPlan }, unknown>(
          client,
          CREATE_WEEKLY_PLAN,
          { input: { employeeId: input.employeeId, weekStartDate: input.weekStartDate } },
        );
        weeklyPlanId = created.createWeeklyPlan.id;
      }
      const assignment: ShiftAssignmentInput =
        input.shiftId === null
          ? { date: input.date, isOffDay: true }
          : { date: input.date, shiftId: input.shiftId, isOffDay: false };
      const result = await graphqlRequest<{ bulkAssignShifts: BulkAssignResult }, unknown>(
        client,
        BULK_ASSIGN_SHIFTS,
        { input: { weeklyPlanId, assignments: [assignment] } },
      );
      if (result.bulkAssignShifts.errors.length > 0) {
        throw new Error(result.bulkAssignShifts.errors.join('\n'));
      }
      return result.bulkAssignShifts;
    },
    // A refused assignment may still have created the plan: refetch either way.
    onSettled: async (_data, _error, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: schedulingKeys.teamOverviewWeek(variables.weekStartDate),
        }),
        queryClient.invalidateQueries({ queryKey: schedulingKeys.weeklyPlans() }),
      ]);
    },
  });
}

export interface PublishWeekPlansInput {
  weekStartDate: string;
  planIds: readonly string[];
}

/** Publishes every draft plan of one week, one after another; a published plan is read-only from then on. */
export function usePublishWeekPlans(): UseMutationResult<number, Error, PublishWeekPlansInput> {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useFeedbackMutation<number, Error, PublishWeekPlansInput>({
    feedback: {
      success: (count) =>
        count === 1 ? 'Weekly plan published' : `${count} weekly plans published`,
      error: 'The week was not published',
    },
    mutationFn: async ({ planIds }) => {
      let published = 0;
      for (const id of planIds) {
        await graphqlRequest<{ publishWeeklyPlan: WeeklyPlan }, unknown>(
          client,
          PUBLISH_WEEKLY_PLAN,
          { id },
        );
        published += 1;
      }
      return published;
    },
    onSettled: async (_data, _error, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: schedulingKeys.teamOverviewWeek(variables.weekStartDate),
        }),
        queryClient.invalidateQueries({ queryKey: schedulingKeys.weeklyPlans() }),
      ]);
    },
  });
}

export function useDeleteWeeklyPlan() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useFeedbackMutation({
    feedback: { success: 'Weekly plan deleted' },
    mutationFn: (id: string) =>
      graphqlRequest<{ deleteWeeklyPlan: boolean }, unknown>(client, DELETE_WEEKLY_PLAN, { id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: schedulingKeys.weeklyPlans() });
    },
  });
}

// =====================
// Settings Mutations
// =====================

export function useUpdateSchedulingSettings() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useFeedbackMutation({
    feedback: { success: 'Scheduling settings saved' },
    mutationFn: (input: UpdateSchedulingSettingsInput) =>
      graphqlRequest<{ updateSchedulingSettings: SchedulingSettings }, unknown>(
        client,
        UPDATE_SCHEDULING_SETTINGS,
        { input },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: schedulingKeys.settings() });
    },
  });
}

// =====================
// Utility Functions
// =====================

/**
 * Format minutes as hours string (e.g., "8h 30m")
 */
export function formatMinutesAsHours(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Get Monday of the week for a given date
 * BUG-009: avoid redundant new Date() wrapper; mutate a single copy.
 */
export function getWeekMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d;
}

/**
 * Format date as ISO string (YYYY-MM-DD) using local calendar date.
 * BUG-019: toISOString() converts to UTC which shifts the date for UTC+ timezones.
 */
export function formatDateISO(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// BUG-010: re-export WeekDay from the canonical types module so callers get
// the proper union type rather than plain string.
export type { WeekDay } from '../types/scheduling.types';

/**
 * Get weekday name in Turkish
 */
export function getWeekdayNameTR(day: WeekDay): string {
  const names: Record<WeekDay, string> = {
    monday: 'Pazartesi',
    tuesday: 'Salı',
    wednesday: 'Çarşamba',
    thursday: 'Perşembe',
    friday: 'Cuma',
    saturday: 'Cumartesi',
    sunday: 'Pazar',
  };
  return names[day];
}

/**
 * Get short weekday name in Turkish
 */
export function getWeekdayShortTR(day: WeekDay): string {
  const names: Record<WeekDay, string> = {
    monday: 'Pzt',
    tuesday: 'Sal',
    wednesday: 'Çar',
    thursday: 'Per',
    friday: 'Cum',
    saturday: 'Cts',
    sunday: 'Paz',
  };
  return names[day];
}
