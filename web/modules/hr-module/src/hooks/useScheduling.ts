/**
 * Scheduling Hooks
 * TanStack Query hooks for weekly workforce planning
 */

import {
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  createTenantInvalidationKey,
  useAuth,
  useFeedbackMutation,
  useTenantQueries,
  useTenantQuery,
} from '@aquaculture/shared-ui';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';
import { useGraphQLClient, graphqlRequest } from './useGraphQL';
import { useModuleScope } from './useModuleScope';
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

// Query Keys — domain segments; useTenantQuery (reads) and createTenantInvalidationKey
// (invalidations) wrap them with the tenant prefix, so no entry outlives a tenant switch.
// WHY: every module-scoped read carries `{ moduleCode }` — the very value it sends — in its
// key (see useModuleScope), so two workspaces can never share a cache entry.
export const schedulingKeys = {
  all: ['scheduling'] as const,
  weeklyPlans: () => [...schedulingKeys.all, 'weeklyPlans'] as const,
  weeklyPlanList: (
    filter: WeeklyPlanFilter | undefined,
    limit: number,
    page: number,
    moduleCode: HrModuleCode | undefined,
  ) => [...schedulingKeys.weeklyPlans(), { filter, limit, page, moduleCode }] as const,
  weeklyPlan: (id: string) => [...schedulingKeys.weeklyPlans(), id] as const,
  /** Every overview of one week, whatever its department / site / module filter — the invalidation prefix. */
  teamOverviewWeek: (weekStartDate: string) =>
    [...schedulingKeys.all, 'teamOverview', weekStartDate] as const,
  teamOverview: (
    weekStartDate: string,
    departmentId: string | undefined,
    siteId: string | undefined,
    moduleCode: HrModuleCode | undefined,
  ) =>
    [
      ...schedulingKeys.teamOverviewWeek(weekStartDate),
      departmentId,
      siteId,
      { moduleCode },
    ] as const,
  settings: () => [...schedulingKeys.all, 'settings'] as const,
  overtimeSummary: (
    month: number,
    year: number,
    employeeId: string | undefined,
    departmentId: string | undefined,
    moduleCode: HrModuleCode | undefined,
  ) =>
    [
      ...schedulingKeys.all,
      'overtime',
      month,
      year,
      employeeId,
      departmentId,
      { moduleCode },
    ] as const,
};

// =====================
// Weekly Plan Queries
// =====================

// WHY keepPreviousData: false on the module-scoped reads below: switching workspace changes
// only the `{ moduleCode }` segment of the key, which is the same tenant session, so the
// useTenantQuery default would keep rendering the previous workspace's people while the new
// ones load.

export function useWeeklyPlans(filter?: WeeklyPlanFilter, limit = 20, page = 1) {
  const client = useGraphQLClient();
  const moduleCode = useModuleScope();

  return useTenantQuery(
    schedulingKeys.weeklyPlanList(filter, limit, page, moduleCode),
    () =>
      graphqlRequest<{ weeklyPlans: WeeklyPlanConnection }, unknown>(client, GET_WEEKLY_PLANS, {
        employeeId: filter?.employeeId,
        departmentId: filter?.departmentId,
        siteId: filter?.siteId,
        weekStartDate: filter?.weekStartDate,
        status: filter?.status,
        limit,
        page,
        moduleCode,
      }),
    {
      select: (data) => data.weeklyPlans,
      keepPreviousData: false,
    },
  );
}

export function useWeeklyPlan(id: string) {
  const client = useGraphQLClient();

  return useTenantQuery(
    schedulingKeys.weeklyPlan(id),
    () => graphqlRequest<{ weeklyPlan: WeeklyPlan }, unknown>(client, GET_WEEKLY_PLAN, { id }),
    {
      select: (data) => data.weeklyPlan,
      enabled: !!id,
      // WHY: one record's or employee's data must never stand in for another's while it loads.
      keepPreviousData: false,
    },
  );
}

/**
 * One week's team overview read — the single definition behind `useTeamWeeklyOverview` and
 * `useTeamWeeklyOverviews`, so both read and write the same cache entries.
 */
function teamOverviewRead(
  client: ReturnType<typeof useGraphQLClient>,
  weekStartDate: string,
  departmentId: string | undefined,
  siteId: string | undefined,
  moduleCode: HrModuleCode | undefined,
) {
  return {
    segments: schedulingKeys.teamOverview(weekStartDate, departmentId, siteId, moduleCode),
    queryFn: () =>
      graphqlRequest<{ teamWeeklyOverview: TeamWeeklyOverview }, unknown>(
        client,
        GET_TEAM_WEEKLY_OVERVIEW,
        { weekStartDate, departmentId, siteId, moduleCode },
      ),
    select: (data: { teamWeeklyOverview: TeamWeeklyOverview }): TeamWeeklyOverview =>
      data.teamWeeklyOverview,
  };
}

export function useTeamWeeklyOverview(
  weekStartDate: string,
  departmentId?: string,
  siteId?: string,
) {
  const client = useGraphQLClient();
  const moduleCode = useModuleScope();
  const { segments, queryFn, select } = teamOverviewRead(
    client,
    weekStartDate,
    departmentId,
    siteId,
    moduleCode,
  );

  return useTenantQuery(segments, queryFn, {
    select,
    enabled: !!weekStartDate,
    keepPreviousData: false,
  });
}

/**
 * One overview per visible week, under the same keys `useTeamWeeklyOverview`
 * uses: the roster's month view spans up to six weeks, and a cell saved from
 * either view repaints in the other from the shared cache.
 *
 * The week count varies, so this is useTenantQueries (the SSoT for a variable-length list).
 */
export function useTeamWeeklyOverviews(
  weekStartDates: readonly string[],
  departmentId?: string,
  siteId?: string,
): UseQueryResult<TeamWeeklyOverview>[] {
  const client = useGraphQLClient();
  const moduleCode = useModuleScope();

  return useTenantQueries(
    weekStartDates.map((weekStartDate) =>
      teamOverviewRead(client, weekStartDate, departmentId, siteId, moduleCode),
    ),
  );
}

export function useSchedulingSettings() {
  const client = useGraphQLClient();

  return useTenantQuery(
    schedulingKeys.settings(),
    () =>
      graphqlRequest<{ schedulingSettings: SchedulingSettings }, unknown>(
        client,
        GET_SCHEDULING_SETTINGS,
        {},
      ),
    { select: (data) => data.schedulingSettings },
  );
}

export function useOvertimeSummary(
  month: number,
  year: number,
  employeeId?: string,
  departmentId?: string,
) {
  const client = useGraphQLClient();
  const moduleCode = useModuleScope();

  return useTenantQuery(
    schedulingKeys.overtimeSummary(month, year, employeeId, departmentId, moduleCode),
    () =>
      graphqlRequest<{ overtimeSummary: OvertimeSummary }, unknown>(client, GET_OVERTIME_SUMMARY, {
        month,
        year,
        employeeId,
        departmentId,
        moduleCode,
      }),
    {
      select: (data) => data.overtimeSummary,
      keepPreviousData: false,
      // BUG-013: !!year is falsy for year=0 which won't happen in practice, but use
      // explicit null checks so month=0 (January) is correctly handled
      enabled: month != null && year != null && year > 0,
    },
  );
}

// =====================
// Cache invalidation
// =====================

/**
 * Invalidates the signed-in tenant's scheduling reads under `key` (a `schedulingKeys` factory
 * output). The epoch-less tenant prefix matches every stored entry under the key whatever its
 * trailing filter or session generation, the same prefix `useEmployees` invalidates by.
 */
function invalidateScheduling(
  queryClient: QueryClient,
  tenantId: string | null,
  key: readonly unknown[],
): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, ...key) });
}

// =====================
// Weekly Plan Mutations
// =====================

export function useCreateWeeklyPlan() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Weekly plan created' },
    mutationFn: (input: CreateWeeklyPlanInput) =>
      graphqlRequest<{ createWeeklyPlan: WeeklyPlan }, unknown>(client, CREATE_WEEKLY_PLAN, {
        input,
      }),
    onSuccess: () => {
      void invalidateScheduling(queryClient, tenantId, schedulingKeys.weeklyPlans());
      void invalidateScheduling(queryClient, tenantId, schedulingKeys.all);
    },
  });
}

export function useUpdatePlanEntry() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Plan entry updated' },
    mutationFn: (input: UpdatePlanEntryInput) =>
      graphqlRequest<{ updatePlanEntry: WeeklyPlanEntry }, unknown>(client, UPDATE_PLAN_ENTRY, {
        input,
      }),
    onSuccess: (_data, variables) => {
      // Invalidate the specific weekly plan and list
      void invalidateScheduling(queryClient, tenantId, schedulingKeys.weeklyPlans());
      void invalidateScheduling(queryClient, tenantId, schedulingKeys.all);
    },
  });
}

export function useBulkAssignShifts() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Shifts assigned' },
    mutationFn: (input: BulkAssignShiftsInput) =>
      graphqlRequest<{ bulkAssignShifts: BulkAssignResult }, unknown>(client, BULK_ASSIGN_SHIFTS, {
        input,
      }),
    onSuccess: (_data, variables) => {
      void invalidateScheduling(
        queryClient,
        tenantId,
        schedulingKeys.weeklyPlan(variables.weeklyPlanId),
      );
      void invalidateScheduling(queryClient, tenantId, schedulingKeys.weeklyPlans());
    },
  });
}

export function useCopyWeeklyPlan() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

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
      void invalidateScheduling(queryClient, tenantId, schedulingKeys.weeklyPlans());
    },
  });
}

export function usePublishWeeklyPlan() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Weekly plan published' },
    mutationFn: (id: string) =>
      graphqlRequest<{ publishWeeklyPlan: WeeklyPlan }, unknown>(client, PUBLISH_WEEKLY_PLAN, {
        id,
      }),
    onSuccess: (data) => {
      void invalidateScheduling(
        queryClient,
        tenantId,
        schedulingKeys.weeklyPlan(data.publishWeeklyPlan.id),
      );
      void invalidateScheduling(queryClient, tenantId, schedulingKeys.weeklyPlans());
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
  const { tenantId } = useAuth();

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
        invalidateScheduling(
          queryClient,
          tenantId,
          schedulingKeys.teamOverviewWeek(variables.weekStartDate),
        ),
        invalidateScheduling(queryClient, tenantId, schedulingKeys.weeklyPlans()),
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
  const { tenantId } = useAuth();

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
        invalidateScheduling(
          queryClient,
          tenantId,
          schedulingKeys.teamOverviewWeek(variables.weekStartDate),
        ),
        invalidateScheduling(queryClient, tenantId, schedulingKeys.weeklyPlans()),
      ]);
    },
  });
}

export function useDeleteWeeklyPlan() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Weekly plan deleted' },
    mutationFn: (id: string) =>
      graphqlRequest<{ deleteWeeklyPlan: boolean }, unknown>(client, DELETE_WEEKLY_PLAN, { id }),
    onSuccess: () => {
      void invalidateScheduling(queryClient, tenantId, schedulingKeys.weeklyPlans());
    },
  });
}

// =====================
// Settings Mutations
// =====================

export function useUpdateSchedulingSettings() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Scheduling settings saved' },
    mutationFn: (input: UpdateSchedulingSettingsInput) =>
      graphqlRequest<{ updateSchedulingSettings: SchedulingSettings }, unknown>(
        client,
        UPDATE_SCHEDULING_SETTINGS,
        { input },
      ),
    onSuccess: () => {
      void invalidateScheduling(queryClient, tenantId, schedulingKeys.settings());
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
    MONDAY: 'Pazartesi',
    TUESDAY: 'Salı',
    WEDNESDAY: 'Çarşamba',
    THURSDAY: 'Perşembe',
    FRIDAY: 'Cuma',
    SATURDAY: 'Cumartesi',
    SUNDAY: 'Pazar',
  };
  return names[day];
}

/**
 * Get short weekday name in Turkish
 */
export function getWeekdayShortTR(day: WeekDay): string {
  const names: Record<WeekDay, string> = {
    MONDAY: 'Pzt',
    TUESDAY: 'Sal',
    WEDNESDAY: 'Çar',
    THURSDAY: 'Per',
    FRIDAY: 'Cum',
    SATURDAY: 'Cts',
    SUNDAY: 'Paz',
  };
  return names[day];
}
