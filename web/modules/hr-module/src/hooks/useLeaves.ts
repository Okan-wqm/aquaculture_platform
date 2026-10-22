/**
 * Leave Management Hooks
 * TanStack Query hooks for leave operations
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
  LeaveRequestStatus,
  CreateLeaveRequestInput,
  UpdateLeaveRequestInput,
  PaginationInput,
  PaginatedResponse,
} from '../types';

// Query Keys — domain segments; useTenantQuery prefixes reads with ['tenant', tenantId, ...] and
// every invalidation / cache write below goes through createTenantInvalidationKey /
// createTenantQueryKey, so no entry outlives a tenant switch and a prefix reaches every read.
// WHY: every module-scoped read carries `{ moduleCode }` — the very value it sends — in its
// key (see useModuleScope), so two workspaces can never share a cache entry.
export const leaveKeys = {
  all: ['leaves'] as const,
  types: () => [...leaveKeys.all, 'types'] as const,
  balances: (employeeId: string, year: number) =>
    [...leaveKeys.all, 'balances', employeeId, year] as const,
  balanceSummary: (employeeId: string, year: number) =>
    [...leaveKeys.all, 'balanceSummary', employeeId, year] as const,
  requests: () => [...leaveKeys.all, 'requests'] as const,
  requestList: (
    filter: LeaveRequestFilterInput | undefined,
    pagination: PaginationInput | undefined,
    moduleCode: HrModuleCode | undefined,
  ) => [...leaveKeys.requests(), { filter, pagination, moduleCode }] as const,
  requestDetail: (id: string) => [...leaveKeys.requests(), id] as const,
  /** Prefix of every own-requests list, whatever status and page it shows. */
  myRequestLists: () => [...leaveKeys.all, 'myRequests'] as const,
  myRequests: (status: LeaveRequestStatus | undefined, pagination: PaginationInput | undefined) =>
    [...leaveKeys.myRequestLists(), { status, pagination }] as const,
  /** Prefix of every pending-approvals list, whatever page and module it shows. */
  pendingApprovalLists: () => [...leaveKeys.all, 'pendingApprovals'] as const,
  pendingApprovals: (pagination: PaginationInput | undefined, moduleCode: HrModuleCode | undefined) =>
    [...leaveKeys.pendingApprovalLists(), { pagination, moduleCode }] as const,
  calendar: (
    departmentId: string | undefined,
    startDate: string,
    endDate: string,
    moduleCode: HrModuleCode | undefined,
  ) => [...leaveKeys.all, 'calendar', departmentId, startDate, endDate, { moduleCode }] as const,
  overlap: (
    employeeId: string,
    startDate: string,
    endDate: string,
    excludeRequestId: string | undefined,
  ) => [...leaveKeys.all, 'overlap', employeeId, startDate, endDate, excludeRequestId] as const,
  calculatedDays: (
    leaveTypeId: string,
    startDate: string,
    endDate: string,
    options: { isHalfDayStart?: boolean; isHalfDayEnd?: boolean } | undefined,
  ) => [...leaveKeys.all, 'calculatedDays', leaveTypeId, startDate, endDate, options] as const,
};

/** The `leaveRequest` operation's response — the shape the detail entry holds in the cache. */
interface LeaveRequestResponse {
  leaveRequest: LeaveRequest;
}

/**
 * One own-requests page: `myLeaveRequests` answers a bare array (no total), so no caller can page
 * it. Ask for the most the server serves in one page (GetLeaveRequestsHandler caps `limit` at 100).
 */
const MY_LEAVE_REQUESTS_PAGE_SIZE = 100;

// =====================
// Leave Type Queries
// =====================

export function useLeaveTypes(filter?: { category?: string; isActive?: boolean }) {
  const client = useGraphQLClient();
  return useTenantQuery(
    leaveKeys.types(),
    () =>
      graphqlRequest<{ leaveTypes: LeaveType[] }, unknown>(
        client,
        GET_LEAVE_TYPES,
        { filter }
      ),
    { select: (data) => data.leaveTypes },
  );
}

// =====================
// Leave Balance Queries
// =====================

export function useLeaveBalances(employeeId: string, year: number) {
  const client = useGraphQLClient();

  return useTenantQuery(
    leaveKeys.balances(employeeId, year),
    () =>
      graphqlRequest<{ leaveBalances: LeaveBalance[] }, unknown>(
        client,
        GET_LEAVE_BALANCES,
        { employeeId, year }
      ),
    {
      select: (data) => data.leaveBalances,
      // BUG-005: year=0 is falsy but a valid-looking bad value; guard with range check
      enabled: !!employeeId && year > 2000 && year < 2100,
      // WHY: one record's or employee's data must never stand in for another's while it loads.
      keepPreviousData: false,
    },
  );
}

export function useLeaveBalanceSummary(employeeId: string, year: number) {
  const client = useGraphQLClient();
  return useTenantQuery(
    leaveKeys.balanceSummary(employeeId, year),
    () =>
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
    {
      select: (data) => data.leaveBalanceSummary,
      // BUG-005: match the same range guard used by useLeaveBalances so year=0 or
      // NaN values cannot trigger an erroneous fetch.
      enabled: !!employeeId && year > 2000 && year < 2100,
      // WHY: one record's or employee's data must never stand in for another's while it loads.
      keepPreviousData: false,
    },
  );
}

// =====================
// Leave Request Queries
// =====================

export function useLeaveRequests(
  filter?: LeaveRequestFilterInput,
  pagination?: PaginationInput
) {
  const client = useGraphQLClient();
  const moduleCode = useModuleScope();

  return useTenantQuery(
    leaveKeys.requestList(filter, pagination, moduleCode),
    () =>
      // WHY flat: GET_LEAVE_REQUESTS declares one variable per argument; a nested
      // `{ filter, pagination }` reaches no declared variable, so the filter never applied.
      graphqlRequest<{ leaveRequests: PaginatedResponse<LeaveRequest> }, unknown>(
        client,
        GET_LEAVE_REQUESTS,
        {
          employeeId: filter?.employeeId,
          status: filter?.status,
          leaveTypeId: filter?.leaveTypeId,
          startDate: filter?.startDate,
          endDate: filter?.endDate,
          limit: pagination?.limit ?? 20,
          page: pagination?.page ?? 1,
          moduleCode,
        },
      ),
    {
      select: (data) => data.leaveRequests,
      // WHY: another workspace's people must never stand in while this one loads.
      keepPreviousData: false,
    },
  );
}

export function useLeaveRequest(id: string) {
  const client = useGraphQLClient();

  return useTenantQuery(
    leaveKeys.requestDetail(id),
    () =>
      graphqlRequest<LeaveRequestResponse, unknown>(
        client,
        GET_LEAVE_REQUEST,
        { id }
      ),
    {
      select: (data) => data.leaveRequest,
      enabled: !!id,
      // WHY: one record's or employee's data must never stand in for another's while it loads.
      keepPreviousData: false,
    },
  );
}

/**
 * The signed-in employee's own requests. WHY a status and a page, not a filter: the resolver
 * takes `(status, limit, page)` and resolves the employee from the token — the auth user id is
 * not an employee id, so no caller can name the employee itself. It answers a bare array
 * (no total). `enabled` lets a page read it only while its tab shows: the server answers an
 * error for a user who has no employee record (a tenant admin, say).
 */
export function useMyLeaveRequests(
  status?: LeaveRequestStatus,
  pagination?: PaginationInput,
  options: { enabled?: boolean } = {},
) {
  const client = useGraphQLClient();

  return useTenantQuery(
    leaveKeys.myRequests(status, pagination),
    () =>
      graphqlRequest<{ myLeaveRequests: LeaveRequest[] }, unknown>(
        client,
        GET_MY_LEAVE_REQUESTS,
        {
          status,
          limit: pagination?.limit ?? MY_LEAVE_REQUESTS_PAGE_SIZE,
          page: pagination?.page ?? 1,
        },
      ),
    {
      select: (data) => data.myLeaveRequests,
      enabled: options.enabled ?? true,
      // WHY: another status's rows must not stand in while this one loads.
      keepPreviousData: false,
    },
  );
}

/**
 * The approver's pending list, a page at a time. WHY no approver id: the resolver takes
 * `(departmentId, limit, page, moduleCode)` and resolves the viewer — and whether to narrow
 * to their own department — from the token, and it answers a paginated connection.
 */
export function usePendingLeaveApprovals(pagination?: PaginationInput) {
  const client = useGraphQLClient();
  const moduleCode = useModuleScope();
  return useTenantQuery(
    leaveKeys.pendingApprovals(pagination, moduleCode),
    () =>
      graphqlRequest<{ pendingLeaveApprovals: PaginatedResponse<LeaveRequest> }, unknown>(
        client,
        GET_PENDING_LEAVE_APPROVALS,
        {
          limit: pagination?.limit ?? 20,
          page: pagination?.page ?? 1,
          moduleCode,
        },
      ),
    {
      select: (data) => data.pendingLeaveApprovals,
      // WHY: another workspace's people must never stand in while this one loads.
      keepPreviousData: false,
    },
  );
}

export function useTeamLeaveCalendar(
  departmentId: string | undefined,
  startDate: string,
  endDate: string
) {
  const client = useGraphQLClient();
  const moduleCode = useModuleScope();

  return useTenantQuery(
    leaveKeys.calendar(departmentId, startDate, endDate, moduleCode),
    () =>
      graphqlRequest<{ teamLeaveCalendar: LeaveCalendarEntry[] }, unknown>(
        client,
        GET_TEAM_LEAVE_CALENDAR,
        { departmentId, startDate, endDate, moduleCode },
      ),
    {
      select: (data) => data.teamLeaveCalendar,
      enabled: !!startDate && !!endDate,
      // WHY: another workspace's people must never stand in while this one loads.
      keepPreviousData: false,
    },
  );
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
  const client = useGraphQLClient();

  return useTenantQuery(
    leaveKeys.overlap(employeeId, startDate, endDate, excludeRequestId),
    () =>
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
    {
      select: (data) => data.checkLeaveOverlap,
      enabled: !!employeeId && !!startDate && !!endDate,
      // WHY: one record's or employee's data must never stand in for another's while it loads.
      keepPreviousData: false,
    },
  );
}

export function useCalculateLeaveDays(
  leaveTypeId: string,
  startDate: string,
  endDate: string,
  options?: { isHalfDayStart?: boolean; isHalfDayEnd?: boolean }
) {
  const client = useGraphQLClient();

  return useTenantQuery(
    leaveKeys.calculatedDays(leaveTypeId, startDate, endDate, options),
    () =>
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
    {
      select: (data) => data.calculateLeaveDays,
      enabled: !!leaveTypeId && !!startDate && !!endDate,
      // WHY: one record's or employee's data must never stand in for another's while it loads.
      keepPreviousData: false,
    },
  );
}

// =====================
// Cache upkeep shared by the mutations
// =====================

/**
 * A request can sit in the all-requests list, in its owner's own list and in an approver's
 * pending list, on whatever status filter or page each shows. Every mutation that changes a
 * request refreshes all three by DOMAIN PREFIX (tenant-prefixed, epoch-less), so no filter or
 * page is left showing the old state and none has to be named.
 */
function invalidateLeaveRequestLists(
  queryClient: QueryClient,
  tenantId: string | null | undefined,
): void {
  const prefixes: ReadonlyArray<readonly unknown[]> = [
    leaveKeys.requests(),
    leaveKeys.myRequestLists(),
    leaveKeys.pendingApprovalLists(),
  ];
  for (const prefix of prefixes) {
    void queryClient.invalidateQueries({
      queryKey: createTenantInvalidationKey(tenantId, ...prefix),
    });
  }
}

/** Refreshes one employee's balances of a year (default: this one): the entries and their summary. */
function invalidateLeaveBalances(
  queryClient: QueryClient,
  tenantId: string | null | undefined,
  employeeId: string,
  year = new Date().getFullYear(),
): void {
  for (const key of [leaveKeys.balances(employeeId, year), leaveKeys.balanceSummary(employeeId, year)]) {
    void queryClient.invalidateQueries({
      queryKey: createTenantInvalidationKey(tenantId, ...key),
    });
  }
}

/**
 * Seeds the detail entry with the request a mutation answered. WHY the wrapper: the detail read's
 * `select` unwraps `leaveRequest`, so the cache holds the operation's response shape.
 */
function cacheLeaveRequest(
  queryClient: QueryClient,
  tenantId: string | null | undefined,
  request: LeaveRequest,
): void {
  queryClient.setQueryData<LeaveRequestResponse>(
    createTenantQueryKey(tenantId, ...leaveKeys.requestDetail(request.id)),
    { leaveRequest: request },
  );
}

// =====================
// Leave Request Mutations
// =====================

export function useCreateLeaveRequest() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();
  return useFeedbackMutation({
    feedback: { success: 'Leave request created' },
    mutationFn: (input: CreateLeaveRequestInput) =>
      graphqlRequest<{ createLeaveRequest: LeaveRequest }, unknown>(
        client,
        CREATE_LEAVE_REQUEST,
        { input }
      ),
    onSuccess: (data) => {
      invalidateLeaveRequestLists(queryClient, tenantId);
      // Update balances if pending was increased
      invalidateLeaveBalances(queryClient, tenantId, data.createLeaveRequest.employeeId);
    },
  });
}

export function useUpdateLeaveRequest() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Leave request updated' },
    mutationFn: (input: UpdateLeaveRequestInput) =>
      graphqlRequest<{ updateLeaveRequest: LeaveRequest }, unknown>(
        client,
        UPDATE_LEAVE_REQUEST,
        { input }
      ),
    onSuccess: (data) => {
      invalidateLeaveRequestLists(queryClient, tenantId);
      cacheLeaveRequest(queryClient, tenantId, data.updateLeaveRequest);
    },
  });
}

export function useSubmitLeaveRequest() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();
  return useFeedbackMutation({
    feedback: { success: 'Leave request submitted' },
    mutationFn: (id: string) =>
      graphqlRequest<{ submitLeaveRequest: LeaveRequest }, unknown>(
        client,
        SUBMIT_LEAVE_REQUEST,
        { id }
      ),
    onSuccess: (data) => {
      invalidateLeaveRequestLists(queryClient, tenantId);
      cacheLeaveRequest(queryClient, tenantId, data.submitLeaveRequest);
    },
  });
}

export function useApproveLeaveRequest() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Leave request approved' },
    mutationFn: ({ id, notes }: { id: string; notes?: string }) =>
      graphqlRequest<{ approveLeaveRequest: LeaveRequest }, unknown>(
        client,
        APPROVE_LEAVE_REQUEST,
        { id, notes }
      ),
    onSuccess: (data) => {
      invalidateLeaveRequestLists(queryClient, tenantId);
      invalidateLeaveBalances(queryClient, tenantId, data.approveLeaveRequest.employeeId);
      cacheLeaveRequest(queryClient, tenantId, data.approveLeaveRequest);
    },
  });
}

export function useRejectLeaveRequest() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Leave request rejected' },
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      graphqlRequest<{ rejectLeaveRequest: LeaveRequest }, unknown>(
        client,
        REJECT_LEAVE_REQUEST,
        { id, reason }
      ),
    onSuccess: (data) => {
      invalidateLeaveRequestLists(queryClient, tenantId);
      invalidateLeaveBalances(queryClient, tenantId, data.rejectLeaveRequest.employeeId);
      cacheLeaveRequest(queryClient, tenantId, data.rejectLeaveRequest);
    },
  });
}

export function useCancelLeaveRequest() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();
  return useFeedbackMutation({
    feedback: { success: 'Leave request cancelled' },
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      graphqlRequest<{ cancelLeaveRequest: LeaveRequest }, unknown>(
        client,
        CANCEL_LEAVE_REQUEST,
        { id, reason }
      ),
    onSuccess: (data) => {
      invalidateLeaveRequestLists(queryClient, tenantId);
      invalidateLeaveBalances(queryClient, tenantId, data.cancelLeaveRequest.employeeId);
      cacheLeaveRequest(queryClient, tenantId, data.cancelLeaveRequest);
    },
  });
}

export function useWithdrawLeaveRequest() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();
  return useFeedbackMutation({
    feedback: { success: 'Leave request withdrawn' },
    mutationFn: (id: string) =>
      graphqlRequest<{ withdrawLeaveRequest: LeaveRequest }, unknown>(
        client,
        WITHDRAW_LEAVE_REQUEST,
        { id }
      ),
    onSuccess: (data) => {
      invalidateLeaveRequestLists(queryClient, tenantId);
      cacheLeaveRequest(queryClient, tenantId, data.withdrawLeaveRequest);
    },
  });
}

// =====================
// Leave Balance Mutations
// =====================

export function useAdjustLeaveBalance() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();
  return useFeedbackMutation({
    feedback: { success: 'Leave balance adjusted' },
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
      invalidateLeaveBalances(queryClient, tenantId, variables.employeeId, variables.year);
    },
  });
}
