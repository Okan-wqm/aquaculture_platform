/**
 * Employee Management Hooks
 * TanStack Query hooks for employee operations
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGraphQLClient, graphqlRequest } from './useGraphQL';
import {
  GET_EMPLOYEES,
  GET_EMPLOYEE,
  GET_EMPLOYEE_BY_NUMBER,
  SEARCH_EMPLOYEES,
  GET_DEPARTMENTS,
  GET_DEPARTMENT,
  GET_POSITIONS,
  GET_ORGANIZATION_TREE,
  GET_DIRECT_REPORTS,
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
  Department,
  Position,
  EmployeeFilterInput,
  CreateEmployeeInput,
  UpdateEmployeeInput,
  EmployeeStatus,
  PaginationInput,
  PaginatedResponse,
} from '../types';

// Query Keys
export const employeeKeys = {
  all: ['employees'] as const,
  lists: () => [...employeeKeys.all, 'list'] as const,
  list: (filter?: EmployeeFilterInput, pagination?: PaginationInput) =>
    [...employeeKeys.lists(), { filter, pagination }] as const,
  details: () => [...employeeKeys.all, 'detail'] as const,
  detail: (id: string) => [...employeeKeys.details(), id] as const,
  byNumber: (employeeNumber: string) =>
    [...employeeKeys.all, 'byNumber', employeeNumber] as const,
  search: (query: string) => [...employeeKeys.all, 'search', query] as const,
  directReports: (managerId: string) =>
    [...employeeKeys.all, 'directReports', managerId] as const,
};

export const departmentKeys = {
  all: ['departments'] as const,
  lists: () => [...departmentKeys.all, 'list'] as const,
  list: (filter?: Record<string, unknown>) =>
    [...departmentKeys.lists(), { filter }] as const,
  details: () => [...departmentKeys.all, 'detail'] as const,
  detail: (id: string) => [...departmentKeys.details(), id] as const,
};

export const positionKeys = {
  all: ['positions'] as const,
  lists: () => [...positionKeys.all, 'list'] as const,
  list: (filter?: Record<string, unknown>) =>
    [...positionKeys.lists(), { filter }] as const,
};

export const organizationKeys = {
  tree: ['organizationTree'] as const,
};

// =====================
// Employee Queries
// =====================

export function useEmployees(
  filter?: EmployeeFilterInput,
  pagination?: PaginationInput
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: employeeKeys.list(filter, pagination),
    queryFn: () =>
      graphqlRequest<{ employees: PaginatedResponse<Employee> }, unknown>(
        client,
        GET_EMPLOYEES.loc?.source.body || '',
        { filter, pagination }
      ),
    select: (data) => data.employees,
  });
}

export function useEmployee(id: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: employeeKeys.detail(id),
    queryFn: () =>
      graphqlRequest<{ employee: Employee }, unknown>(
        client,
        GET_EMPLOYEE.loc?.source.body || '',
        { id }
      ),
    select: (data) => data.employee,
    enabled: !!id,
  });
}

export function useEmployeeByNumber(employeeNumber: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: employeeKeys.byNumber(employeeNumber),
    queryFn: () =>
      graphqlRequest<{ employeeByNumber: Employee }, unknown>(
        client,
        GET_EMPLOYEE_BY_NUMBER.loc?.source.body || '',
        { employeeNumber }
      ),
    select: (data) => data.employeeByNumber,
    enabled: !!employeeNumber,
  });
}

export function useSearchEmployees(search: string, limit = 10) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: employeeKeys.search(search),
    queryFn: () =>
      graphqlRequest<{ searchEmployees: Employee[] }, unknown>(
        client,
        SEARCH_EMPLOYEES.loc?.source.body || '',
        { search, limit }
      ),
    select: (data) => data.searchEmployees,
    enabled: search.length >= 2,
  });
}

export function useDirectReports(managerId: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: employeeKeys.directReports(managerId),
    queryFn: () =>
      graphqlRequest<{ directReports: Employee[] }, unknown>(
        client,
        GET_DIRECT_REPORTS.loc?.source.body || '',
        { managerId }
      ),
    select: (data) => data.directReports,
    enabled: !!managerId,
  });
}

// =====================
// Department Queries
// =====================

export function useDepartments(filter?: Record<string, unknown>) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: departmentKeys.list(filter),
    queryFn: () =>
      graphqlRequest<{ departments: Department[] }, unknown>(
        client,
        GET_DEPARTMENTS.loc?.source.body || '',
        { filter }
      ),
    select: (data) => data.departments,
  });
}

export function useDepartment(id: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: departmentKeys.detail(id),
    queryFn: () =>
      graphqlRequest<{ department: Department & { employees: Employee[] } }, unknown>(
        client,
        GET_DEPARTMENT.loc?.source.body || '',
        { id }
      ),
    select: (data) => data.department,
    enabled: !!id,
  });
}

// =====================
// Position Queries
// =====================

export function usePositions(filter?: Record<string, unknown>) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: positionKeys.list(filter),
    queryFn: () =>
      graphqlRequest<{ positions: Position[] }, unknown>(
        client,
        GET_POSITIONS.loc?.source.body || '',
        { filter }
      ),
    select: (data) => data.positions,
  });
}

// =====================
// Organization Tree
// =====================

export function useOrganizationTree() {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: organizationKeys.tree,
    queryFn: () =>
      graphqlRequest<{
        organizationTree: {
          departments: Department[];
          employees: Employee[];
        };
      }, unknown>(client, GET_ORGANIZATION_TREE.loc?.source.body || '', {}),
    select: (data) => data.organizationTree,
  });
}

// =====================
// Employee Mutations
// =====================

export function useCreateEmployee() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateEmployeeInput) =>
      graphqlRequest<{ createEmployee: Employee }, unknown>(
        client,
        CREATE_EMPLOYEE.loc?.source.body || '',
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: employeeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: departmentKeys.all });
    },
  });
}

export function useUpdateEmployee() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateEmployeeInput) =>
      graphqlRequest<{ updateEmployee: Employee }, unknown>(
        client,
        UPDATE_EMPLOYEE.loc?.source.body || '',
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: employeeKeys.lists() });
      queryClient.setQueryData(
        employeeKeys.detail(data.updateEmployee.id),
        data.updateEmployee
      );
    },
  });
}

export function useUpdateEmployeeStatus() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      status,
      reason,
    }: {
      id: string;
      status: EmployeeStatus;
      reason?: string;
    }) =>
      graphqlRequest<{ updateEmployeeStatus: Employee }, unknown>(
        client,
        UPDATE_EMPLOYEE_STATUS.loc?.source.body || '',
        { id, status, reason }
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: employeeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: employeeKeys.detail(variables.id) });
    },
  });
}

export function useAssignEmployeeToDepartment() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ employeeId, departmentId }: { employeeId: string; departmentId: string }) =>
      graphqlRequest<{ assignEmployeeToDepartment: Employee }, unknown>(
        client,
        ASSIGN_EMPLOYEE_TO_DEPARTMENT.loc?.source.body || '',
        { employeeId, departmentId }
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: employeeKeys.detail(variables.employeeId) });
      queryClient.invalidateQueries({ queryKey: departmentKeys.all });
    },
  });
}

export function useAssignEmployeeToPosition() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ employeeId, positionId }: { employeeId: string; positionId: string }) =>
      graphqlRequest<{ assignEmployeeToPosition: Employee }, unknown>(
        client,
        ASSIGN_EMPLOYEE_TO_POSITION.loc?.source.body || '',
        { employeeId, positionId }
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: employeeKeys.detail(variables.employeeId) });
    },
  });
}

export function useAssignManager() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ employeeId, managerId }: { employeeId: string; managerId: string }) =>
      graphqlRequest<{ assignManager: Employee }, unknown>(
        client,
        ASSIGN_MANAGER.loc?.source.body || '',
        { employeeId, managerId }
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: employeeKeys.detail(variables.employeeId) });
      queryClient.invalidateQueries({ queryKey: employeeKeys.directReports(variables.managerId) });
    },
  });
}

// =====================
// Department Mutations
// =====================

export function useCreateDepartment() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { code: string; name: string; description?: string; managerId?: string; parentDepartmentId?: string; colorCode?: string }) =>
      graphqlRequest<{ createDepartment: Department }, unknown>(
        client,
        CREATE_DEPARTMENT.loc?.source.body || '',
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: departmentKeys.all });
      queryClient.invalidateQueries({ queryKey: organizationKeys.tree });
    },
  });
}

export function useUpdateDepartment() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; name?: string; description?: string; managerId?: string; colorCode?: string; isActive?: boolean }) =>
      graphqlRequest<{ updateDepartment: Department }, unknown>(
        client,
        UPDATE_DEPARTMENT.loc?.source.body || '',
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: departmentKeys.all });
      queryClient.setQueryData(
        departmentKeys.detail(data.updateDepartment.id),
        data.updateDepartment
      );
    },
  });
}

// =====================
// Position Mutations
// =====================

export function useCreatePosition() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { code: string; title: string; description?: string; departmentId?: string; minSalary?: number; maxSalary?: number }) =>
      graphqlRequest<{ createPosition: Position }, unknown>(
        client,
        CREATE_POSITION.loc?.source.body || '',
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: positionKeys.all });
    },
  });
}

export function useUpdatePosition() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; title?: string; description?: string; minSalary?: number; maxSalary?: number; isActive?: boolean }) =>
      graphqlRequest<{ updatePosition: Position }, unknown>(
        client,
        UPDATE_POSITION.loc?.source.body || '',
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: positionKeys.all });
    },
  });
}
