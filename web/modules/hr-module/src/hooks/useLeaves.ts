/**
 * Leave Management Hooks
 * TanStack Query hooks for leave operations
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { PaginationResultV1 } from '@platform/pagination-contracts';
import { useAuth, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';
import { useGraphQLClient, graphqlRequest } from './useGraphQL';
import {
  GET_LEAVE_TYPES,
  GET_LEAVE_BALANCES,
  GET_LEAVE_BALANCE_SUMMARY,
  GET_LEAVE_REQUESTS,
  GET_LEAVE_REQUEST,
  GET_MY_LEAVE_REQUESTS,
  GET_PENDING_LEAVE_APPROVALS,
  GET_TEAM_LEAVE_CALENDAR,
  CHECK_LEAVE_OVERLAP,
  CALCULATE_LEAVE_DAYS,
  CREATE_LEAVE_REQUEST,
  UPDATE_LEAVE_REQUEST,
  SUBMIT_LEAVE_REQUEST,
  APPROVE_LEAVE_REQUEST,
  REJECT_LEAVE_REQUEST,
  CANCEL_LEAVE_REQUEST,
  WITHDRAW_LEAVE_REQUEST,
  ADJUST_LEAVE_BALANCE,
} from '../graphql';
import type {
  LeaveType,
  LeaveBalance,
  LeaveRequest,
  LeaveCalendarEntry,
  LeaveRequestFilterInput,
  CreateLeaveRequestInput,
  UpdateLeaveRequestInput,
  PaginationInput,
} from '../types';

// Query Keys
export const leaveKeys = {
  all: ['leaves'] as const,
  types: () => [...leaveKeys.all, 'types'] as const,
  balances: (employeeId: string, year: number) =>
    [...leaveKeys.all, 'balances', employeeId, year] as const,
  balanceSummary: (employeeId: string, year: number) =>
    [...leaveKeys.all, 'balanceSummary', employeeId, year] as const,
  requests: () => [...leaveKeys.all, 'requests'] as const,
  requestList: (filter?: LeaveRequestFilterInput, pagination?: PaginationInput) =>
    [...leaveKeys.requests(), { filter, pagination }] as const,
  requestDetail: (id: string) => [...leaveKeys.requests(), id] as const,
  myRequests: (filter?: LeaveRequestFilterInput, pagination?: PaginationInput) =>
    [...leaveKeys.all, 'myRequests', { filter, pagination }] as const,
  pendingApprovals: (approverId: string) =>
    [...leaveKeys.all, 'pendingApprovals', approverId] as const,
  calendar: (departmentId: string | undefined, startDate: string, endDate: string) =>
    [...leaveKeys.all, 'calendar', departmentId, startDate, endDate] as const,
};

// =====================
// Leave Type Queries
// =====================

export function useLeaveTypes(filter?: { category?: string; isActive?: boolean }) {
  const client = useGraphQLClient();
  return useQuery({
    queryKey: leaveKeys.types(),
    queryFn: () =>
      graphqlRequest<{ leaveTypes: LeaveType[] }, unknown>(
        client,
        GET_LEAVE_TYPES,
        { filter }
      ),
    select: (data) => data.leaveTypes,
  });
}

// =====================
// Leave Balance Queries
// =====================

export function useLeaveBalances(employeeId: string, year: number) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: leaveKeys.balances(employeeId, year),
    queryFn: () =>
      graphqlRequest<{ leaveBalances: LeaveBalance[] }, unknown>(
        client,
        GET_LEAVE_BALANCES,
        { employeeId, year }
      ),
    select: (data) => data.leaveBalances,
    // BUG-005: year=0 is falsy but a valid-looking bad value; guard with range check
    enabled: !!employeeId && year > 2000 && year < 2100,
  });
}

export function useLeaveBalanceSummary(employeeId: string, year: number) {
  const client = useGraphQLClient();
  return useQuery({
    queryKey: leaveKeys.balanceSummary(employeeId, year),
    queryFn: () =>
      graphqlRequest<{
        leaveBalanceSummary: {
          totalEntitled: number;
          totalUsed: number;
          totalPending: number;
          totalAvailable: number;
          balances: {
            leaveTypeId: string;
            leaveTypeName: string;
            leaveTypeColor: string;
            entitled: number;
            used: number;
            pending: number;
            available: number;
          }[];
        };
      }, unknown>(client, GET_LEAVE_BALANCE_SUMMARY, {
        employeeId,
        year,
      }),
    select: (data) => data.leaveBalanceSummary,
    // BUG-005: match the same range guard used by useLeaveBalances so year=0 or
    // NaN values cannot trigger an erroneous fetch.
    enabled: !!employeeId && year > 2000 && year < 2100,
  });
}

// =====================
// Leave Request Queries
// =====================

export function useLeaveRequests(
  filter?: LeaveRequestFilterInput,
  pagination?: PaginationInput
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: leaveKeys.requestList(filter, pagination),
    queryFn: () =>
      graphqlRequest<{ leaveRequests: PaginationResultV1<LeaveRequest> }, unknown>(
        client,
        GET_LEAVE_REQUESTS,
        { filter, pagination }
      ),
    select: (data) => data.leaveRequests,
  });
}

export function useLeaveRequest(id: string) {
  const client = useGraphQLClient();

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: leaveKeys.requestDetail(id),
    queryFn: () =>
      graphqlRequest<{ leaveRequest: LeaveRequest }, unknown>(
        client,
        GET_LEAVE_REQUEST,
        { id }
      ),
    select: (data) => data.leaveRequest,
    enabled: !!id && !!tenantId,
  });
}

export function useMyLeaveRequests(
  filter?: LeaveRequestFilterInput,
  pagination?: PaginationInput
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: leaveKeys.myRequests(filter, pagination),
    queryFn: () =>
      graphqlRequest<{ myLeaveRequests: PaginationResultV1<LeaveRequest> }, unknown>(
        client,
        GET_MY_LEAVE_REQUESTS,
        { filter, pagination }
      ),
    select: (data) => data.myLeaveRequests,
  });
}

export function usePendingLeaveApprovals(approverId: string) {
  const client = useGraphQLClient();
  return useQuery({
    queryKey: leaveKeys.pendingApprovals(approverId),
    queryFn: () =>
      graphqlRequest<{ pendingLeaveApprovals: LeaveRequest[] }, unknown>(
        client,
        GET_PENDING_LEAVE_APPROVALS,
        { approverId }
      ),
    select: (data) => data.pendingLeaveApprovals,
    enabled: !!approverId,
  });
}

export function useTeamLeaveCalendar(
  departmentId: string | undefined,
  startDate: string,
  endDate: string
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: leaveKeys.calendar(departmentId, startDate, endDate),
    queryFn: () =>
      graphqlRequest<{ teamLeaveCalendar: LeaveCalendarEntry[] }, unknown>(
        client,
        GET_TEAM_LEAVE_CALENDAR,
        { departmentId, startDate, endDate }
      ),
    select: (data) => data.teamLeaveCalendar,
    enabled: !!startDate && !!endDate,
  });
}

// =====================
// Leave Validation Queries
// =====================

export function useCheckLeaveOverlap(
  employeeId: string,
  startDate: string,
  endDate: string,
  excludeRequestId?: string
) {
  const { tenantId } = useAuth();
  const client = useGraphQLClient();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'leaveOverlap', employeeId, startDate, endDate, excludeRequestId),
    queryFn: () =>
      graphqlRequest<{
        checkLeaveOverlap: {
          hasOverlap: boolean;
          overlappingRequests: { id: string; requestNumber: string; startDate: string; endDate: string; status: string }[];
        };
      }, unknown>(client, CHECK_LEAVE_OVERLAP, {
        employeeId,
        startDate,
        endDate,
        excludeRequestId,
      }),
    select: (data) => data.checkLeaveOverlap,
    enabled: !!employeeId && !!startDate && !!endDate,
  });
}

export function useCalculateLeaveDays(
  leaveTypeId: string,
  startDate: string,
  endDate: string,
  options?: { isHalfDayStart?: boolean; isHalfDayEnd?: boolean }
) {
  const client = useGraphQLClient();
  const { tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'leaveDays', leaveTypeId, startDate, endDate, options),
    queryFn: () =>
      graphqlRequest<{
        calculateLeaveDays: {
          totalDays: number;
          workingDays: number;
          weekends: number;
          holidays: number;
        };
      }, unknown>(client, CALCULATE_LEAVE_DAYS, {
        leaveTypeId,
        startDate,
        endDate,
        ...options,
      }),
    select: (data) => data.calculateLeaveDays,
    enabled: !!leaveTypeId && !!startDate && !!endDate,
  });
}

// =====================
// Leave Request Mutations
// =====================

export function useCreateLeaveRequest() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLeaveRequestInput) =>
      graphqlRequest<{ createLeaveRequest: LeaveRequest }, unknown>(
        client,
        CREATE_LEAVE_REQUEST,
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: leaveKeys.requests() });
      queryClient.invalidateQueries({ queryKey: leaveKeys.myRequests() });
      // Update balances if pending was increased
      queryClient.invalidateQueries({
        queryKey: leaveKeys.balances(data.createLeaveRequest.employeeId, new Date().getFullYear()),
      });
    },
  });
}

export function useUpdateLeaveRequest() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateLeaveRequestInput) =>
      graphqlRequest<{ updateLeaveRequest: LeaveRequest }, unknown>(
        client,
        UPDATE_LEAVE_REQUEST,
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: leaveKeys.requests() });
      queryClient.setQueryData(
        leaveKeys.requestDetail(data.updateLeaveRequest.id),
        data.updateLeaveRequest
      );
    },
  });
}

export function useSubmitLeaveRequest() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      graphqlRequest<{ submitLeaveRequest: LeaveRequest }, unknown>(
        client,
        SUBMIT_LEAVE_REQUEST,
        { id }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: leaveKeys.requests() });
      queryClient.invalidateQueries({ queryKey: leaveKeys.myRequests() });
      queryClient.setQueryData(
        leaveKeys.requestDetail(data.submitLeaveRequest.id),
        data.submitLeaveRequest
      );
    },
  });
}

export function useApproveLeaveRequest() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) =>
      graphqlRequest<{ approveLeaveRequest: LeaveRequest }, unknown>(
        client,
        APPROVE_LEAVE_REQUEST,
        { id, notes }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: leaveKeys.requests() });
      // BUG-014: use prefix invalidation so all pendingApprovals(approverId) keys are invalidated
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, ...leaveKeys.all, 'pendingApprovals'),
        exact: false,
      });
      queryClient.invalidateQueries({
        queryKey: leaveKeys.balances(data.approveLeaveRequest.employeeId, new Date().getFullYear()),
      });
      queryClient.setQueryData(
        leaveKeys.requestDetail(data.approveLeaveRequest.id),
        data.approveLeaveRequest
      );
    },
  });
}

export function useRejectLeaveRequest() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      graphqlRequest<{ rejectLeaveRequest: LeaveRequest }, unknown>(
        client,
        REJECT_LEAVE_REQUEST,
        { id, reason }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: leaveKeys.requests() });
      // BUG-014: use prefix invalidation so all pendingApprovals(approverId) keys are invalidated
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, ...leaveKeys.all, 'pendingApprovals'),
        exact: false,
      });
      queryClient.invalidateQueries({
        queryKey: leaveKeys.balances(data.rejectLeaveRequest.employeeId, new Date().getFullYear()),
      });
      queryClient.setQueryData(
        leaveKeys.requestDetail(data.rejectLeaveRequest.id),
        data.rejectLeaveRequest
      );
    },
  });
}

export function useCancelLeaveRequest() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      graphqlRequest<{ cancelLeaveRequest: LeaveRequest }, unknown>(
        client,
        CANCEL_LEAVE_REQUEST,
        { id, reason }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: leaveKeys.requests() });
      queryClient.invalidateQueries({ queryKey: leaveKeys.myRequests() });
      queryClient.invalidateQueries({
        queryKey: leaveKeys.balances(data.cancelLeaveRequest.employeeId, new Date().getFullYear()),
      });
      queryClient.setQueryData(
        leaveKeys.requestDetail(data.cancelLeaveRequest.id),
        data.cancelLeaveRequest
      );
    },
  });
}

export function useWithdrawLeaveRequest() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      graphqlRequest<{ withdrawLeaveRequest: LeaveRequest }, unknown>(
        client,
        WITHDRAW_LEAVE_REQUEST,
        { id }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: leaveKeys.requests() });
      queryClient.invalidateQueries({ queryKey: leaveKeys.myRequests() });
      queryClient.setQueryData(
        leaveKeys.requestDetail(data.withdrawLeaveRequest.id),
        data.withdrawLeaveRequest
      );
    },
  });
}

// =====================
// Leave Balance Mutations
// =====================

export function useAdjustLeaveBalance() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      employeeId,
      leaveTypeId,
      year,
      adjustment,
      reason,
    }: {
      employeeId: string;
      leaveTypeId: string;
      year: number;
      adjustment: number;
      reason: string;
    }) =>
      graphqlRequest<{ adjustLeaveBalance: LeaveBalance }, unknown>(
        client,
        ADJUST_LEAVE_BALANCE,
        { employeeId, leaveTypeId, year, adjustment, reason }
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: leaveKeys.balances(variables.employeeId, variables.year),
      });
      queryClient.invalidateQueries({
        queryKey: leaveKeys.balanceSummary(variables.employeeId, variables.year),
      });
    },
  });
}
