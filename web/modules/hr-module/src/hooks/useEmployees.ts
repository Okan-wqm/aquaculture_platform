/**
 * Employee Management Hooks
 * TanStack Query hooks for employee operations
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';
import { useGraphQLClient, graphqlRequest } from './useGraphQL';
import { useModuleScope } from './useModuleScope';
import { attendanceKeys } from './useAttendance';
import { leaveKeys } from './useLeaves';
import { schedulingKeys } from './useScheduling';
import {
  useAuth,
  createTenantQueryKey,
  createTenantInvalidationKey,
  useFeedbackMutation,
  useTenantQuery,
} from '@aquaculture/shared-ui';
import {
  GET_EMPLOYEES,
  GET_EMPLOYEE,
  GET_EMPLOYEE_BY_NUMBER,
  GET_HR_DASHBOARD_STATS,
  GET_DEPARTMENTS,
  GET_POSITIONS,
  CREATE_EMPLOYEE,
  UPDATE_EMPLOYEE,
  UPDATE_EMPLOYEE_STATUS,
  ASSIGN_EMPLOYEE_TO_DEPARTMENT,
  ASSIGN_EMPLOYEE_TO_POSITION,
  ASSIGN_MANAGER,
  CREATE_DEPARTMENT,
  UPDATE_DEPARTMENT,
  CREATE_POSITION,
  UPDATE_POSITION,
} from '../graphql';
import type {
  Employee,
  EmployeeDepartment,
  Department,
  Position,
  EmployeeFilterInput,
  CreateEmployeeInput,
  UpdateEmployeeInput,
  CreateDepartmentInput,
  UpdateDepartmentInput,
  EmployeeStatus,
  PaginatedResponse,
} from '../types';

type EmployeePagination = { limit?: number; page?: number };

// Query Keys — domain segments; every hook wraps them with createTenantQueryKey
// (reads) / createTenantInvalidationKey (invalidations) so no entry outlives a tenant switch.
export const employeeKeys = {
  all: ['employees'] as const,
  lists: () => [...employeeKeys.all, 'list'] as const,
  // WHY: the filter here is the one SENT (module scope included), so two workspaces
  // asking for different modules can never share a cache entry.
  list: (filter: EmployeeFilterInput | undefined, pagination: EmployeePagination | undefined) =>
    [...employeeKeys.lists(), { filter, pagination }] as const,
  details: () => [...employeeKeys.all, 'detail'] as const,
  detail: (id: string) => [...employeeKeys.details(), id] as const,
  byNumber: (employeeNumber: string) =>
    [...employeeKeys.all, 'byNumber', employeeNumber] as const,
};

export const departmentKeys = {
  all: ['departments'] as const,
  lists: () => [...departmentKeys.all, 'list'] as const,
  list: (filter?: Record<string, unknown>) =>
    [...departmentKeys.lists(), { filter }] as const,
  /** The departments with the head counts the organization chart draws. */
  organization: (variables: { moduleCode?: HrModuleCode }) =>
    [...departmentKeys.all, 'organization', variables] as const,
};

/** The tenant-wide HR statistics (head counts, people placed in no department, ...). */
const dashboardStatsKeys = {
  all: ['hrDashboardStats'] as const,
};

/**
 * Everything one change to who works where can alter besides the employee: who
 * stands in each module's Team areas (roster, leave, attendance, schedules),
 * each department's head count, and the tenant-wide statistics. The mutations
 * that hire, edit, change the status of or place an employee, and those that
 * create or move a department, end here, so none of them can refresh the list
 * and leave a module's Team pages or the org chart showing the old team.
 * Employee detail caches are included: they embed the employee's department.
 */
function invalidateWorkforceReads(queryClient: QueryClient, tenantId: string | null | undefined): void {
  const prefixes: ReadonlyArray<readonly unknown[]> = [
    employeeKeys.all,
    departmentKeys.all,
    dashboardStatsKeys.all,
    attendanceKeys.all,
    leaveKeys.all,
    schedulingKeys.all,
  ];
  for (const prefix of prefixes) {
    void queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, ...prefix) });
  }
}

export const positionKeys = {
  all: ['positions'] as const,
  lists: () => [...positionKeys.all, 'list'] as const,
  list: (filter?: Record<string, unknown>) =>
    [...positionKeys.lists(), { filter }] as const,
};

// =====================
// Employee Queries
// =====================

// WHY: Backend employees resolver accepts filter and pagination as SEPARATE GraphQL arguments.
// EmployeeFilterInput does not contain limit/page — those belong in EmployeePaginationInput.
// Merging them into a single object caused GraphQL validation 400 errors.
function useEmployeeList(
  filter: EmployeeFilterInput | undefined,
  pagination: EmployeePagination | undefined,
  enabled: boolean
) {
  const client = useGraphQLClient();
  // WHY: the module is resolved once (explicit filter.moduleCode, else the workspace's)
  // and that one value feeds BOTH the request and the cache key.
  const moduleCode = useModuleScope(filter?.moduleCode);
  const scopedFilter: EmployeeFilterInput = { ...filter, moduleCode };

  return useTenantQuery(
    employeeKeys.list(scopedFilter, pagination),
    () =>
      graphqlRequest<{ employees: PaginatedResponse<Employee> }, unknown>(
        client,
        GET_EMPLOYEES,
        { filter: scopedFilter, pagination }
      ),
    {
      select: (data) => data.employees,
      enabled,
      // WHY: another workspace's people must never stand in while this one loads.
      keepPreviousData: false,
    },
  );
}

/**
 * The people of the reader's workspace: a module workspace lists that module's
 * employees, Company lists everyone. `filter.moduleCode` narrows explicitly.
 */
export function useEmployees(filter?: EmployeeFilterInput, pagination?: EmployeePagination) {
  return useEmployeeList(filter, pagination, true);
}

export function useEmployee(id: string) {
  const client = useGraphQLClient();

  return useTenantQuery(
    employeeKeys.detail(id),
    () =>
      graphqlRequest<{ employee: Employee }, unknown>(
        client,
        GET_EMPLOYEE,
        { id }
      ),
    {
      select: (data) => data.employee,
      enabled: !!id,
      // WHY: one person's record must never stand in for another's while it loads.
      keepPreviousData: false,
    },
  );
}

export function useEmployeeByNumber(employeeNumber: string) {
  const client = useGraphQLClient();

  return useTenantQuery(
    employeeKeys.byNumber(employeeNumber),
    () =>
      graphqlRequest<{ employees: PaginatedResponse<Employee> }, unknown>(
        client,
        GET_EMPLOYEE_BY_NUMBER,
        { filter: { employeeNumber } }
      ),
    {
      select: (data) => data.employees?.items?.[0],
      enabled: !!employeeNumber,
      keepPreviousData: false,
    },
  );
}

/**
 * Pre-aggregated dashboard statistics — replaces the limit:1000 employee fetch.
 * CRIT-3 / PERF-001: no raw employee records, no PII transmitted.
 */
export function useHRDashboardStats(options: { enabled?: boolean } = {}) {
  const client = useGraphQLClient();

  return useTenantQuery(
    dashboardStatsKeys.all,
    () =>
      graphqlRequest<{
        hrDashboardStats: {
          totalEmployees: number;
          activeEmployees: number;
          onLeaveEmployees: number;
          terminatedEmployees: number;
          newHiresThisMonth: number;
          offshoreEmployees: number;
          onshoreEmployees: number;
          attendanceRate: number;
          pendingLeaveRequests: number;
          totalDepartments: number;
          /** Head count of the employees placed in no department. */
          unplacedEmployees: number;
        };
      }, unknown>(client, GET_HR_DASHBOARD_STATS, {}),
    { select: (data) => data.hrDashboardStats, enabled: options.enabled ?? true },
  );
}

/**
 * Resolves the current authenticated user's HR employee record.
 * CRIT-5 / BUG-011 / SEC-009: centralises auth→employee mapping to avoid
 * inconsistent use of user.id vs user.sub across pages.
 *
 * The HR service maps the token's `sub` (auth identity) to the employee record.
 * Using `sub` here because that is the standard JWT subject claim that the
 * HR service registers employees against.
 */
export function useCurrentEmployeeId(): string {
  const { user } = useAuth();
  // `sub` is the standard JWT subject — used as the authoritative identity field.
  // All pages should use this hook rather than reading user.id or user.sub directly.
  return user?.id || '';
}

// =====================
// Department Queries
// =====================

/**
 * The departments of the reader's workspace: a module workspace lists that module's
 * departments, Company lists all of them. `filter.moduleCode` narrows explicitly.
 */
export function useDepartments(filter?: {
  siteId?: string;
  isDeleted?: boolean;
  moduleCode?: HrModuleCode;
}) {
  const client = useGraphQLClient();
  const moduleCode = useModuleScope(filter?.moduleCode);
  // WHY: one object is both the request variables and the cache key, so they cannot disagree.
  const variables = {
    siteId: filter?.siteId,
    isDeleted: filter?.isDeleted ?? false,
    moduleCode,
  };

  return useTenantQuery(
    departmentKeys.list(variables),
    () =>
      graphqlRequest<{ hrDepartments: Department[] }, unknown>(
        client,
        GET_DEPARTMENTS,
        variables
      ),
    { select: (data) => data.hrDepartments, keepPreviousData: false },
  );
}

// =====================
// Position Queries
// =====================

/**
 * Position is a string field in the backend, not a separate entity.
 * This hook is kept for backward compatibility but returns empty array.
 */
export function usePositions(_filter?: Record<string, unknown>) {
  return { data: [] as Position[], isLoading: false, error: null };
}

// =====================
// Employee Mutations
// =====================

export function useCreateEmployee() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Employee created' },
    mutationFn: (input: CreateEmployeeInput) =>
      graphqlRequest<{ createEmployee: Employee }, unknown>(
        client,
        CREATE_EMPLOYEE,
        { input }
      ),
    onSuccess: () => {
      invalidateWorkforceReads(queryClient, tenantId);
    },
  });
}

export function useUpdateEmployee() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();
  return useFeedbackMutation({
    feedback: { success: 'Employee updated' },
    mutationFn: (input: UpdateEmployeeInput) =>
      graphqlRequest<{ updateEmployee: Employee }, unknown>(
        client,
        UPDATE_EMPLOYEE,
        { input }
      ),
    onSuccess: (data) => {
      invalidateWorkforceReads(queryClient, tenantId);
      // WHY: the detail query's `select` unwraps `employee`, so the cache holds the response shape.
      queryClient.setQueryData(
        createTenantQueryKey(tenantId, ...employeeKeys.detail(data.updateEmployee.id)),
        { employee: data.updateEmployee }
      );
    },
  });
}

export function useUpdateEmployeeStatus() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Employee status updated' },
    mutationFn: ({
      id,
      status,
    }: {
      id: string;
      status: EmployeeStatus;
    }) =>
      graphqlRequest<{ updateEmployee: { id: string; status: string; terminationDate?: string } }, unknown>(
        client,
        UPDATE_EMPLOYEE_STATUS,
        { input: { id, status } }
      ),
    onSuccess: (_, variables) => {
      invalidateWorkforceReads(queryClient, tenantId);
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, ...employeeKeys.detail(variables.id)) });
    },
  });
}

/** Places an employee in a department (`departmentHrId`), or removes the placement with null. */
export function useAssignEmployeeToDepartment() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Department assigned' },
    mutationFn: ({ employeeId, departmentHrId }: { employeeId: string; departmentHrId: string | null }) =>
      graphqlRequest<{ updateEmployee: { id: string; departmentHrId: string | null; departmentHr: EmployeeDepartment | null } }, unknown>(
        client,
        ASSIGN_EMPLOYEE_TO_DEPARTMENT,
        { input: { id: employeeId, departmentHrId } }
      ),
    onSuccess: (_, variables) => {
      // WHY: a placement moves the employee between module lists as well as department headcounts.
      invalidateWorkforceReads(queryClient, tenantId);
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, ...employeeKeys.detail(variables.employeeId)) });
    },
  });
}

export function useAssignEmployeeToPosition() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();
  return useFeedbackMutation({
    feedback: { success: 'Position assigned' },
    mutationFn: ({ employeeId, position }: { employeeId: string; position: string }) =>
      graphqlRequest<{ updateEmployee: { id: string; position: string; positionId?: string } }, unknown>(
        client,
        ASSIGN_EMPLOYEE_TO_POSITION,
        { input: { id: employeeId, position } }
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, ...employeeKeys.detail(variables.employeeId)) });
    },
  });
}

export function useAssignManager() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Manager assigned' },
    mutationFn: ({ employeeId, supervisorId }: { employeeId: string; supervisorId: string }) =>
      graphqlRequest<{ updateEmployee: { id: string; supervisorId: string } }, unknown>(
        client,
        ASSIGN_MANAGER,
        { input: { id: employeeId, supervisorId } }
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, ...employeeKeys.detail(variables.employeeId)) });
    },
  });
}

// =====================
// Department Mutations
// =====================

export function useCreateDepartment() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();
  return useFeedbackMutation({
    feedback: { success: 'Department created' },
    mutationFn: (input: CreateDepartmentInput) =>
      graphqlRequest<{ createHRDepartment: Department }, unknown>(
        client,
        CREATE_DEPARTMENT,
        { input }
      ),
    onSuccess: () => {
      invalidateWorkforceReads(queryClient, tenantId);
    },
  });
}

export function useUpdateDepartment() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useFeedbackMutation({
    feedback: { success: 'Department updated' },
    mutationFn: (input: UpdateDepartmentInput) =>
      graphqlRequest<{ updateHRDepartment: Department }, unknown>(
        client,
        UPDATE_DEPARTMENT,
        { input }
      ),
    onSuccess: () => {
      // WHY: a module change also moves the department's employees between module lists.
      invalidateWorkforceReads(queryClient, tenantId);
    },
  });
}

// =====================
// Position Mutations (stubs — position is a string field, not an entity)
// =====================

export function useCreatePosition() {
  return useFeedbackMutation({
    feedback: { success: 'Position created' },
    mutationFn: async (_input: { title: string }) => {
      return { createPosition: { title: _input.title } as Position };
    },
  });
}

export function useUpdatePosition() {
  return useFeedbackMutation({
    feedback: { success: 'Position updated' },
    mutationFn: async (_input: { id: string; title?: string }) => {
      return { updatePosition: { title: _input.title || '' } as Position };
    },
  });
}
