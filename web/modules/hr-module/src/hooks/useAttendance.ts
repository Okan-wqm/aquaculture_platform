/**
 * Attendance Management Hooks
 * TanStack Query hooks for attendance operations
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { PaginationResultV1 } from '@platform/pagination-contracts';
import { useGraphQLClient, graphqlRequest } from './useGraphQL';
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
  dailyOverview: (date: string) =>
    [...attendanceKeys.all, 'dailyOverview', date] as const,
  today: (employeeId?: string) =>
    [...attendanceKeys.all, 'today', employeeId] as const,
};

// =====================
// Shift Queries
// =====================

export function useShifts(filter?: { isActive?: boolean; shiftType?: string }) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: attendanceKeys.shiftList(filter),
    queryFn: () =>
      graphqlRequest<{ shifts: PaginationResultV1<Shift> }, unknown>(
        client,
        GET_SHIFTS,
        { isActive: filter?.isActive, shiftType: filter?.shiftType, page: 1, limit: 100 }
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
      graphqlRequest<{ attendanceRecords: PaginationResultV1<AttendanceRecord> }, unknown>(
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

export function useDailyAttendanceOverview(date: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: attendanceKeys.dailyOverview(date),
    queryFn: () =>
      graphqlRequest<{ dailyAttendanceOverview: DailyAttendanceOverview }, unknown>(
        client,
        GET_DAILY_ATTENDANCE_OVERVIEW,
        { date }
      ),
    select: (data) => data.dailyAttendanceOverview,
    enabled: !!date,
  });
}

export function useTodaysAttendance(employeeId?: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: attendanceKeys.today(employeeId),
    queryFn: () =>
      graphqlRequest<{ todaysAttendance: AttendanceRecord[] }, unknown>(
        client,
        GET_TODAYS_ATTENDANCE,
        { employeeId }
      ),
    select: (data) => data.todaysAttendance,
    refetchInterval: 60000, // Refresh every minute
    refetchIntervalInBackground: false, // PERF-003: don't poll when tab is hidden
    enabled: true,
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

/**
 * Create a manual attendance record.
 * Maps to backend: createManualAttendance(input: ManualAttendanceInput!)
 */
export function useCreateManualAttendance() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
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
      queryClient.invalidateQueries({ queryKey: attendanceKeys.records() });
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

  return useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) =>
      graphqlRequest<{ approveAttendance: AttendanceRecord }, unknown>(
        client,
        APPROVE_ATTENDANCE,
        { id, notes }
      ),
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
