/**
 * Attendance Management Hooks
 * TanStack Query hooks for attendance operations
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGraphQLClient, graphqlRequest } from './useGraphQL';
import {
  GET_SHIFTS,
  GET_SHIFT,
  GET_ATTENDANCE_RECORDS,
  GET_MY_ATTENDANCE_RECORDS,
  GET_ATTENDANCE_SUMMARY,
  GET_DAILY_ATTENDANCE_OVERVIEW,
  GET_TODAYS_ATTENDANCE,
  GET_EMPLOYEE_SCHEDULE,
  GET_SCHEDULES,
  CLOCK_IN,
  CLOCK_OUT,
  CREATE_ATTENDANCE_RECORD,
  UPDATE_ATTENDANCE_RECORD,
  APPROVE_ATTENDANCE_RECORDS,
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
  CreateAttendanceRecordInput,
  UpdateAttendanceRecordInput,
  CreateShiftInput,
  PaginationInput,
  PaginatedResponse,
} from '../types';

// Query Keys
export const attendanceKeys = {
  all: ['attendance'] as const,
  shifts: () => [...attendanceKeys.all, 'shifts'] as const,
  shiftList: (filter?: Record<string, unknown>) =>
    [...attendanceKeys.shifts(), { filter }] as const,
  shiftDetail: (id: string) => [...attendanceKeys.shifts(), id] as const,
  records: () => [...attendanceKeys.all, 'records'] as const,
  recordList: (filter?: AttendanceFilterInput, pagination?: PaginationInput) =>
    [...attendanceKeys.records(), { filter, pagination }] as const,
  recordDetail: (id: string) => [...attendanceKeys.records(), id] as const,
  myRecords: (filter?: AttendanceFilterInput, pagination?: PaginationInput) =>
    [...attendanceKeys.all, 'myRecords', { filter, pagination }] as const,
  summary: (employeeId: string, month: number, year: number) =>
    [...attendanceKeys.all, 'summary', employeeId, month, year] as const,
  dailyOverview: (date: string, departmentId?: string) =>
    [...attendanceKeys.all, 'dailyOverview', date, departmentId] as const,
  today: (departmentId?: string) =>
    [...attendanceKeys.all, 'today', departmentId] as const,
  schedule: (employeeId: string, startDate: string, endDate: string) =>
    [...attendanceKeys.all, 'schedule', employeeId, startDate, endDate] as const,
  schedules: (filter?: Record<string, unknown>) =>
    [...attendanceKeys.all, 'schedules', { filter }] as const,
};

// =====================
// Shift Queries
// =====================

export function useShifts(filter?: { isActive?: boolean; shiftType?: string }) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: attendanceKeys.shiftList(filter),
    queryFn: () =>
      graphqlRequest<{ shifts: { items: Shift[]; total: number } }, unknown>(
        client,
        GET_SHIFTS,
        { isActive: filter?.isActive, shiftType: filter?.shiftType, limit: 100, offset: 0 }
      ),
    select: (data) => data.shifts.items,
  });
}

export function useShift(id: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: attendanceKeys.shiftDetail(id),
    queryFn: () =>
      graphqlRequest<{ shift: Shift }, unknown>(
        client,
        GET_SHIFT,
        { id }
      ),
    select: (data) => data.shift,
    enabled: !!id,
  });
}

// =====================
// Attendance Record Queries
// =====================

export function useAttendanceRecords(
  filter?: AttendanceFilterInput,
  pagination?: PaginationInput
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: attendanceKeys.recordList(filter, pagination),
    queryFn: () =>
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
          offset: pagination?.offset ?? 0,
        }
      ),
    select: (data) => data.attendanceRecords,
  });
}

export function useMyAttendanceRecords(
  filter?: AttendanceFilterInput,
  pagination?: PaginationInput
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: attendanceKeys.myRecords(filter, pagination),
    queryFn: () =>
      graphqlRequest<{ myAttendanceRecords: AttendanceRecord[] }, unknown>(
        client,
        GET_MY_ATTENDANCE_RECORDS,
        {
          startDate: filter?.startDate,
          endDate: filter?.endDate,
          limit: pagination?.limit ?? 30,
        }
      ),
    select: (data) => data.myAttendanceRecords,
  });
}

export function useAttendanceSummary(employeeId: string, month: number, year: number) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: attendanceKeys.summary(employeeId, month, year),
    queryFn: () =>
      graphqlRequest<{ attendanceSummary: AttendanceSummary }, unknown>(
        client,
        GET_ATTENDANCE_SUMMARY,
        { employeeId, month, year }
      ),
    select: (data) => data.attendanceSummary,
    enabled: !!employeeId && !!month && !!year,
  });
}

export function useDailyAttendanceOverview(date: string, departmentId?: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: attendanceKeys.dailyOverview(date, departmentId),
    queryFn: () =>
      graphqlRequest<{ dailyAttendanceOverview: DailyAttendanceOverview }, unknown>(
        client,
        GET_DAILY_ATTENDANCE_OVERVIEW,
        { date, departmentId }
      ),
    select: (data) => data.dailyAttendanceOverview,
    enabled: false, // Backend resolver not yet implemented
  });
}

export function useTodaysAttendance(departmentId?: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: attendanceKeys.today(departmentId),
    queryFn: () =>
      graphqlRequest<{ todaysAttendance: AttendanceRecord[] }, unknown>(
        client,
        GET_TODAYS_ATTENDANCE,
        { departmentId }
      ),
    select: (data) => data.todaysAttendance,
    refetchInterval: 60000, // Refresh every minute
    refetchIntervalInBackground: false, // PERF-003: don't poll when tab is hidden
    enabled: false, // Backend resolver not yet implemented
  });
}

export function useEmployeeSchedule(
  employeeId: string,
  startDate: string,
  endDate: string
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: attendanceKeys.schedule(employeeId, startDate, endDate),
    queryFn: () =>
      graphqlRequest<{
        employeeSchedule: {
          date: string;
          shiftId: string;
          shiftName: string;
          startTime: string;
          endTime: string;
          isOffshore: boolean;
          workAreaId?: string;
          workAreaName?: string;
        }[];
      }, unknown>(client, GET_EMPLOYEE_SCHEDULE, {
        employeeId,
        startDate,
        endDate,
      }),
    select: (data) => data.employeeSchedule,
    enabled: false, // Backend resolver not yet implemented
  });
}

export function useSchedules(filter?: { status?: string }) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: attendanceKeys.schedules(filter),
    queryFn: () =>
      graphqlRequest<{
        schedules: {
          id: string;
          code: string;
          name: string;
          description?: string;
          defaultShiftId: string;
          defaultShift?: Shift;
          status: string;
          effectiveFrom: string;
          effectiveTo?: string;
          isDefault: boolean;
        }[];
      }, unknown>(client, GET_SCHEDULES, { filter }),
    select: (data) => data.schedules,
    enabled: false, // Backend resolver not yet implemented
  });
}

// =====================
// Clock In/Out Mutations
// =====================

export function useClockIn() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ClockInInput) =>
      graphqlRequest<{ clockIn: AttendanceRecord }, unknown>(
        client,
        CLOCK_IN,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: attendanceKeys.records() });
      queryClient.invalidateQueries({ queryKey: attendanceKeys.myRecords() });
      queryClient.invalidateQueries({ queryKey: attendanceKeys.today() });
    },
  });
}

export function useClockOut() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ClockOutInput) =>
      graphqlRequest<{ clockOut: AttendanceRecord }, unknown>(
        client,
        CLOCK_OUT,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: attendanceKeys.records() });
      queryClient.invalidateQueries({ queryKey: attendanceKeys.myRecords() });
      queryClient.invalidateQueries({ queryKey: attendanceKeys.today() });
    },
  });
}

// =====================
// Attendance Record Mutations
// =====================

export function useCreateAttendanceRecord() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateAttendanceRecordInput) =>
      graphqlRequest<{ createAttendanceRecord: AttendanceRecord }, unknown>(
        client,
        CREATE_ATTENDANCE_RECORD,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: attendanceKeys.records() });
    },
  });
}

export function useUpdateAttendanceRecord() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateAttendanceRecordInput) =>
      graphqlRequest<{ updateAttendanceRecord: AttendanceRecord }, unknown>(
        client,
        UPDATE_ATTENDANCE_RECORD,
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: attendanceKeys.records() });
      queryClient.setQueryData(
        attendanceKeys.recordDetail(data.updateAttendanceRecord.id),
        data.updateAttendanceRecord
      );
    },
  });
}

export function useApproveAttendanceRecords() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ids: string[]) =>
      graphqlRequest<{
        approveAttendanceRecords: { approved: number; failed: number; errors: string[] };
      }, unknown>(client, APPROVE_ATTENDANCE_RECORDS, { ids }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: attendanceKeys.records() });
    },
  });
}

// =====================
// Shift Mutations
// =====================

export function useCreateShift() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateShiftInput) =>
      graphqlRequest<{ createShift: Shift }, unknown>(
        client,
        CREATE_SHIFT,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: attendanceKeys.shifts() });
    },
  });
}

export function useUpdateShift() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string } & Partial<CreateShiftInput>) =>
      graphqlRequest<{ updateShift: Shift }, unknown>(
        client,
        UPDATE_SHIFT,
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: attendanceKeys.shifts() });
      queryClient.setQueryData(
        attendanceKeys.shiftDetail(data.updateShift.id),
        data.updateShift
      );
    },
  });
}
