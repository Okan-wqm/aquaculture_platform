/**
 * Payroll Management Hooks
 * TanStack Query hooks for payroll operations
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { PaginationResultV1 } from '@platform/pagination-contracts';
import { useGraphQLClient, graphqlRequest } from './useGraphQL';
import {
  GET_PAYROLLS,
  GET_PENDING_PAYROLLS,
  CREATE_PAYROLL,
  APPROVE_PAYROLL,
} from '../graphql';
import type {
  Payroll,
  PayrollFilterInput,
  CreatePayrollInput,
} from '../types';

// Query Keys
export const payrollKeys = {
  all: ['payrolls'] as const,
  lists: () => [...payrollKeys.all, 'list'] as const,
  list: (filter?: PayrollFilterInput) =>
    [...payrollKeys.lists(), { filter }] as const,
  pending: () => [...payrollKeys.all, 'pending'] as const,
};

// =====================
// Payroll Queries
// =====================

export function usePayrolls(filter?: PayrollFilterInput) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: payrollKeys.list(filter),
    queryFn: () =>
      graphqlRequest<{ payrolls: PaginationResultV1<Payroll> }, unknown>(
        client,
        GET_PAYROLLS,
        {
          employeeId: filter?.employeeId,
          status: filter?.status,
          limit: filter?.limit ?? 20,
          page: filter?.page ?? 1,
        }
      ),
    select: (data) => data.payrolls,
  });
}

export function usePendingPayrolls(limit = 50) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: payrollKeys.pending(),
    queryFn: () =>
      graphqlRequest<{ pendingPayrolls: Payroll[] }, unknown>(
        client,
        GET_PENDING_PAYROLLS,
        { limit }
      ),
    select: (data) => data.pendingPayrolls,
  });
}

// =====================
// Payroll Mutations
// =====================

export function useCreatePayroll() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreatePayrollInput) =>
      graphqlRequest<{ createPayroll: Payroll }, unknown>(
        client,
        CREATE_PAYROLL,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: payrollKeys.lists() });
      queryClient.invalidateQueries({ queryKey: payrollKeys.pending() });
    },
  });
}

export function useApprovePayroll() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      graphqlRequest<{ approvePayroll: Payroll }, unknown>(
        client,
        APPROVE_PAYROLL,
        { id }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: payrollKeys.lists() });
      queryClient.invalidateQueries({ queryKey: payrollKeys.pending() });
    },
  });
}
