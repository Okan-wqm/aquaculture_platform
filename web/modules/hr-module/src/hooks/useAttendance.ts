/**
 * Attendance Management Hooks
 * TanStack Query hooks for attendance operations
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  useAuth,
  createTenantQueryKey,
  createTenantInvalidationKey,
  useFeedbackMutation,
  useTenantQuery,
} from '@aquaculture/shared-ui';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';
import { useGraphQLClient, graphqlRequest } from './useGraphQL';
import { useModuleScope } from './useModuleScope';
import {
  GET_SHIFTS,
  GET_SHIFT,
  GET_ATTENDANCE_RECORDS,
  GET_MY_ATTENDANCE_RECORDS,
  GET_ATTENDANCE_SUMMARY,
  GET_DAILY_ATTENDANCE_OVERVIEW,
  GET_TODAYS_ATTENDANCE,
  CLOCK_IN,
  CLOCK_OUT,
  CREATE_MANUAL_ATTENDANCE,
  APPROVE_ATTENDANCE,
  CREATE_SHIFT,
  UPDATE_SHIFT,
} from '../graphql';
import type {
  Shift,
  AttendanceRecord,
  AttendanceSummary,
  DailyAttendanceOverview,
  AttendanceFilterInput,
  ClockInInput,
  ClockOutInput,
  CreateShiftInput,
  PaginationInput,
  PaginatedResponse,
} from '../types';

// Query Keys — domain segments; every read gets its tenant prefix from useTenantQuery, and every
// invalidation (createTenantInvalidationKey) and cache seed (createTenantQueryKey) wraps them
// the same way, so no entry outlives a tenant switch and the workforce invalidation in
// useEmployees reaches `attendanceKeys.all`.
// WHY: every module-scoped read carries `{ moduleCode }` — the very value it sends — in its
// key (see useModuleScope), so two workspaces can never share a cache entry.
export const attendanceKeys = {
  all: ['attendance'] as const,
  shifts: () => [...attendanceKeys.all, 'shifts'] as const,
  shiftList: (filter?: Record<string, unknown>) =>
    [...attendanceKeys.shifts(), { filter }] as const,
  shiftDetail: (id: string) => [...attendanceKeys.shifts(), id] as const,
  records: () => [...attendanceKeys.all, 'records'] as const,
  recordList: (
    filter: AttendanceFilterInput | undefined,
    pagination: PaginationInput | undefined,
    moduleCode: HrModuleCode | undefined,
  ) => [...attendanceKeys.records(), { filter, pagination, moduleCode }] as const,
  recordDetail: (id: string) => [...attendanceKeys.records(), id] as const,
  myRecords: (filter?: AttendanceFilterInput, pagination?: PaginationInput) =>
    [...attendanceKeys.all, 'myRecords', { filter, pagination }] as const,
  summary: (employeeId: string, month: number, year: number) =>
    [...attendanceKeys.all, 'summary', employeeId, month, year] as const,
  dailyOverview: (date: string, moduleCode: HrModuleCode | undefined) =>
    [...attendanceKeys.all, 'dailyOverview', date, { moduleCode }] as const,
  /** Every "today" read — what a clock-in or clock-out invalidates. */
  today: () => [...attendanceKeys.all, 'today'] as const,
  /** One employee's own records of today (the clock widget); never module-scoped. */
  todayOf: (employeeId?: string) => [...attendanceKeys.today(), 'employee', employeeId] as const,
  /** The workspace's records of today (the Today page). */
  todayTeam: (moduleCode: HrModuleCode | undefined) =>
    [...attendanceKeys.today(), 'team', { moduleCode }] as const,
};

/**
 * Refetches the tenant's mounted reads under each attendance key prefix.
 *
 * WHY the epoch-less prefix: a read is stored as `['tenant', tenantId, ...key, { epoch }]`, and
 * only createTenantInvalidationKey left-prefix-matches every such entry whatever its trailing
 * filter or epoch generation.
 */
function invalidateAttendanceReads(
  queryClient: QueryClient,
  tenantId: string | null | undefined,
  ...prefixes: ReadonlyArray<readonly unknown[]>
): void {
  for (const prefix of prefixes) {
    void queryClient.invalidateQueries({
      queryKey: createTenantInvalidationKey(tenantId, ...prefix),
    });
  }
}

// =====================
// Shift Queries
// =====================

export function useShifts(filter?: { isActive?: boolean; shiftType?: string }) {
  const client = useGraphQLClient();

  return useTenantQuery(
    attendanceKeys.shiftList(filter),
    () =>
      graphqlRequest<{ shifts: { items: Shift[]; total: number } }, unknown>(
        client,
        GET_SHIFTS,
        { isActive: filter?.isActive, shiftType: filter?.shiftType, page: 1, limit: 100 }
      ),
    { select: (data) => data.shifts.items },
  );
}

export function useShift(id: string) {
  const client = useGraphQLClient();

  return useTenantQuery(
    attendanceKeys.shiftDetail(id),
    () =>
      graphqlRequest<{ shift: Shift }, unknown>(
        client,
        GET_SHIFT,
        { id }
      ),
    {
      select: (data) => data.shift, enabled: !!id,
      // WHY: one record's or employee's data must never stand in for another's while it loads.
      keepPreviousData: false,
    },
  );
}

// =====================
// Attendance Record Queries
// =====================

export function useAttendanceRecords(
  filter?: AttendanceFilterInput,
  pagination?: PaginationInput
) {
  const client = useGraphQLClient();
  const moduleCode = useModuleScope();

  return useTenantQuery(
    attendanceKeys.recordList(filter, pagination, moduleCode),
    () =>
      graphqlRequest<{ attendanceRecords: PaginatedResponse<AttendanceRecord> }, unknown>(
        client,
        GET_ATTENDANCE_RECORDS,
        {
          employeeId: filter?.employeeId,
          departmentId: filter?.departmentId,
          status: filter?.status,
          startDate: filter?.startDate,
          endDate: filter?.endDate,
          limit: pagination?.limit ?? 20,
          page: pagination?.page ?? 1,
          moduleCode,
        }
      ),
    {
      select: (data) => data.attendanceRecords,
      // WHY: another workspace's people must never stand in while this one loads.
      keepPreviousData: false,
    },
  );
}

export function useMyAttendanceRecords(
  filter?: AttendanceFilterInput,
  pagination?: PaginationInput
) {
  const client = useGraphQLClient();

  return useTenantQuery(
    attendanceKeys.myRecords(filter, pagination),
    () =>
      graphqlRequest<{ myAttendanceRecords: AttendanceRecord[] }, unknown>(
        client,
        GET_MY_ATTENDANCE_RECORDS,
        {
          startDate: filter?.startDate,
          endDate: filter?.endDate,
          limit: pagination?.limit ?? 30,
        }
      ),
    { select: (data) => data.myAttendanceRecords },
  );
}

export function useAttendanceSummary(employeeId: string, month: number, year: number) {
  const client = useGraphQLClient();

  return useTenantQuery(
    attendanceKeys.summary(employeeId, month, year),
    () =>
      graphqlRequest<{ attendanceSummary: AttendanceSummary }, unknown>(
        client,
        GET_ATTENDANCE_SUMMARY,
        { employeeId, month, year }
      ),
    {
      select: (data) => data.attendanceSummary,
      enabled: !!employeeId && !!month && !!year,
      // WHY: one record's or employee's data must never stand in for another's while it loads.
      keepPreviousData: false,
    },
  );
}

export function useDailyAttendanceOverview(date: string) {
  const client = useGraphQLClient();
  const moduleCode = useModuleScope();

  return useTenantQuery(
    attendanceKeys.dailyOverview(date, moduleCode),
    () =>
      graphqlRequest<{ dailyAttendanceOverview: DailyAttendanceOverview }, unknown>(
        client,
        GET_DAILY_ATTENDANCE_OVERVIEW,
        { date, moduleCode },
      ),
    {
      select: (data) => data.dailyAttendanceOverview,
      enabled: !!date,
      // WHY: another workspace's people must never stand in while this one loads.
      keepPreviousData: false,
    },
  );
}

/**
 * The one minute-polled `todaysAttendance` read; the two hooks below differ only in key,
 * variables and whether the previous data may stand in while a new key loads.
 */
function useTodaysAttendanceRead(
  segments: readonly unknown[],
  variables: { employeeId?: string; moduleCode?: HrModuleCode },
) {
  const client = useGraphQLClient();

  return useTenantQuery(
    segments,
    () =>
      graphqlRequest<{ todaysAttendance: AttendanceRecord[] }, unknown>(
        client,
        GET_TODAYS_ATTENDANCE,
        variables,
      ),
    {
      select: (data) => data.todaysAttendance,
      refetchInterval: 60000, // Refresh every minute
      refetchIntervalInBackground: false, // PERF-003: don't poll when tab is hidden
      // WHY: another employee's or workspace's day must never stand in while this one loads.
      keepPreviousData: false,
    },
  );
}

/**
 * The caller's own records of today (the clock widget), or one employee's.
 *
 * WHY never module-scoped: the clock reads a single person's day, and that person must find
 * their own record in every workspace — including one whose module their department is not in.
 * The workspace's team list is `useTeamTodaysAttendance`.
 */
export function useTodaysAttendance(employeeId?: string) {
  return useTodaysAttendanceRead(attendanceKeys.todayOf(employeeId), { employeeId });
}

/**
 * Every record of today in the reader's workspace (managers; hr-service narrows other roles to
 * their own record) — only the employees whose live department is in the workspace's module,
 * everyone in Company.
 */
export function useTeamTodaysAttendance() {
  const moduleCode = useModuleScope();
  // WHY no previous data: another workspace's people must never stand in while this one loads.
  return useTodaysAttendanceRead(attendanceKeys.todayTeam(moduleCode), { moduleCode });
}

// =====================
// Clock In/Out Mutations
// =====================

export function useClockIn() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Clocked in' },
    mutationFn: (input: ClockInInput) =>
      graphqlRequest<{ clockIn: AttendanceRecord }, unknown>(
        client,
        CLOCK_IN,
        { input }
      ),
    onSuccess: () => {
      invalidateAttendanceReads(
        queryClient,
        tenantId,
        attendanceKeys.records(),
        attendanceKeys.myRecords(),
        attendanceKeys.today(),
      );
    },
  });
}

export function useClockOut() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Clocked out' },
    mutationFn: (input: ClockOutInput) =>
      graphqlRequest<{ clockOut: AttendanceRecord }, unknown>(
        client,
        CLOCK_OUT,
        { input }
      ),
    onSuccess: () => {
      invalidateAttendanceReads(
        queryClient,
        tenantId,
        attendanceKeys.records(),
        attendanceKeys.myRecords(),
        attendanceKeys.today(),
      );
    },
  });
}

// =====================
// Attendance Record Mutations
// =====================

/**
 * Create a manual attendance record.
 * Maps to backend: createManualAttendance(input: ManualAttendanceInput!)
 */
export function useCreateManualAttendance() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Attendance recorded' },
    mutationFn: (input: {
      employeeId: string;
      date: string;
      clockIn?: string;
      clockOut?: string;
      reason: string;
      shiftId?: string;
    }) =>
      graphqlRequest<{ createManualAttendance: AttendanceRecord }, unknown>(
        client,
        CREATE_MANUAL_ATTENDANCE,
        { input }
      ),
    onSuccess: () => {
      invalidateAttendanceReads(queryClient, tenantId, attendanceKeys.records());
    },
  });
}

// NOTE: useUpdateAttendanceRecord removed — updateAttendanceRecord does not exist in backend.

/**
 * Approve a single attendance record.
 * Maps to backend: approveAttendance(id: ID!, notes: String)
 */
export function useApproveAttendance() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Attendance approved' },
    mutationFn: ({ id, notes }: { id: string; notes?: string }) =>
      graphqlRequest<{ approveAttendance: AttendanceRecord }, unknown>(
        client,
        APPROVE_ATTENDANCE,
        { id, notes }
      ),
    onSuccess: () => {
      invalidateAttendanceReads(queryClient, tenantId, attendanceKeys.records());
    },
  });
}

// =====================
// Shift Mutations
// =====================

export function useCreateShift() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Shift created' },
    mutationFn: (input: CreateShiftInput) =>
      graphqlRequest<{ createShift: Shift }, unknown>(
        client,
        CREATE_SHIFT,
        { input }
      ),
    onSuccess: () => {
      invalidateAttendanceReads(queryClient, tenantId, attendanceKeys.shifts());
    },
  });
}

export function useUpdateShift() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Shift updated' },
    mutationFn: (input: { id: string } & Partial<CreateShiftInput>) =>
      graphqlRequest<{ updateShift: Shift }, unknown>(
        client,
        UPDATE_SHIFT,
        { input }
      ),
    onSuccess: (data) => {
      invalidateAttendanceReads(queryClient, tenantId, attendanceKeys.shifts());
      // WHY: the detail query's `select` unwraps `shift`, so the cache holds the response shape.
      queryClient.setQueryData(
        createTenantQueryKey(tenantId, ...attendanceKeys.shiftDetail(data.updateShift.id)),
        { shift: data.updateShift }
      );
    },
  });
}
