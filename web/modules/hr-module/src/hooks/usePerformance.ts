/**
 * Performance Management Hooks
 * TanStack Query hooks for performance reviews and goals
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { PaginationResultV1 } from '@platform/pagination-contracts';
import { useGraphQLClient, graphqlRequest } from './useGraphQL';
import {
  GET_PERFORMANCE_REVIEWS,
  GET_PERFORMANCE_REVIEW,
  GET_MY_PERFORMANCE_REVIEWS,
  GET_PENDING_REVIEWS,
  GET_TEAM_PERFORMANCE_OVERVIEW,
  GET_PERFORMANCE_SUMMARY,
  GET_GOALS,
  GET_GOAL,
  GET_MY_GOALS,
  GET_TEAM_GOALS,
  GET_OVERDUE_GOALS,
  GET_EMPLOYEE_KPIS,
  CREATE_PERFORMANCE_REVIEW,
  SUBMIT_SELF_ASSESSMENT,
  SUBMIT_MANAGER_ASSESSMENT,
  FINALIZE_REVIEW,
  ACKNOWLEDGE_REVIEW,
  CREATE_GOAL,
  UPDATE_GOAL,
  UPDATE_GOAL_PROGRESS,
  COMPLETE_GOAL,
  CANCEL_GOAL,
  DEFER_GOAL,
} from '../graphql';
import type {
  PerformanceReview,
  Goal,
  EmployeeKPI,
  PerformanceSummary,
  TeamPerformanceOverview,
  PerformanceReviewFilterInput,
  GoalFilterInput,
  CreatePerformanceReviewInput,
  SubmitSelfAssessmentInput,
  SubmitManagerAssessmentInput,
  FinalizeReviewInput,
  CreateGoalInput,
  UpdateGoalInput,
  UpdateGoalProgressInput,
} from '../types';

// Query Keys
export const reviewKeys = {
  all: ['reviews'] as const,
  lists: () => [...reviewKeys.all, 'list'] as const,
  list: (filter?: PerformanceReviewFilterInput) =>
    [...reviewKeys.lists(), { filter }] as const,
  details: () => [...reviewKeys.all, 'detail'] as const,
  detail: (id: string) => [...reviewKeys.details(), id] as const,
  my: (filter?: PerformanceReviewFilterInput) =>
    [...reviewKeys.all, 'my', { filter }] as const,
  pending: (reviewerId: string) =>
    [...reviewKeys.all, 'pending', reviewerId] as const,
  summary: (employeeId: string) =>
    [...reviewKeys.all, 'summary', employeeId] as const,
  teamOverview: (departmentId: string) =>
    [...reviewKeys.all, 'teamOverview', departmentId] as const,
};

export const goalKeys = {
  all: ['goals'] as const,
  lists: () => [...goalKeys.all, 'list'] as const,
  list: (filter?: GoalFilterInput) =>
    [...goalKeys.lists(), { filter }] as const,
  details: () => [...goalKeys.all, 'detail'] as const,
  detail: (id: string) => [...goalKeys.details(), id] as const,
  my: (filter?: GoalFilterInput) => [...goalKeys.all, 'my', { filter }] as const,
  team: (managerId: string, filter?: GoalFilterInput) =>
    [...goalKeys.all, 'team', managerId, { filter }] as const,
  overdue: (departmentId?: string) =>
    [...goalKeys.all, 'overdue', departmentId] as const,
};

export const kpiKeys = {
  all: ['kpis'] as const,
  employee: (employeeId: string, periodStart?: string, periodEnd?: string) =>
    [...kpiKeys.all, 'employee', employeeId, periodStart, periodEnd] as const,
};

// =====================
// Performance Review Queries
// =====================

export function usePerformanceReviews(
  filter?: PerformanceReviewFilterInput
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: reviewKeys.list(filter),
    queryFn: () =>
      graphqlRequest<{
        performanceReviews: PaginationResultV1<PerformanceReview>;
      }, unknown>(client, GET_PERFORMANCE_REVIEWS, {
        employeeId: filter?.employeeId,
        status: filter?.status,
        page: 1,
        limit: 20,
      }),
    select: (data) => data.performanceReviews,
  });
}

export function usePerformanceReview(id: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: reviewKeys.detail(id),
    queryFn: () =>
      graphqlRequest<{ performanceReview: PerformanceReview }, unknown>(
        client,
        GET_PERFORMANCE_REVIEW,
        { id }
      ),
    select: (data) => data.performanceReview,
    enabled: !!id,
  });
}

export function useMyPerformanceReviews(filter?: PerformanceReviewFilterInput) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: reviewKeys.my(filter),
    queryFn: () =>
      graphqlRequest<{ myPerformanceReviews: PerformanceReview[] }, unknown>(
        client,
        GET_MY_PERFORMANCE_REVIEWS,
        { status: filter?.status }
      ),
    select: (data) => data.myPerformanceReviews,
  });
}

export function usePendingReviews(reviewerId: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: reviewKeys.pending(reviewerId),
    queryFn: () =>
      graphqlRequest<{ pendingReviews: PerformanceReview[] }, unknown>(
        client,
        GET_PENDING_REVIEWS,
        { reviewerId }
      ),
    select: (data) => data.pendingReviews,
    enabled: !!reviewerId,
  });
}

export function useTeamPerformanceOverview(departmentId: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: reviewKeys.teamOverview(departmentId),
    queryFn: () =>
      graphqlRequest<{
        teamPerformanceOverview: TeamPerformanceOverview;
      }, unknown>(client, GET_TEAM_PERFORMANCE_OVERVIEW, {
        departmentId,
      }),
    select: (data) => data.teamPerformanceOverview,
    enabled: !!departmentId,
  });
}

export function usePerformanceSummary(employeeId: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: reviewKeys.summary(employeeId),
    queryFn: () =>
      graphqlRequest<{ performanceSummary: PerformanceSummary }, unknown>(
        client,
        GET_PERFORMANCE_SUMMARY,
        { employeeId }
      ),
    select: (data) => data.performanceSummary,
    enabled: !!employeeId,
  });
}

// =====================
// Goal Queries
// =====================

export function useGoals(filter?: GoalFilterInput) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: goalKeys.list(filter),
    queryFn: () =>
      graphqlRequest<{ goals: PaginationResultV1<Goal> }, unknown>(
        client,
        GET_GOALS,
        {
          employeeId: filter?.employeeId,
          status: filter?.status,
          page: 1,
          limit: 20,
        }
      ),
    select: (data) => data.goals,
  });
}

export function useGoal(id: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: goalKeys.detail(id),
    queryFn: () =>
      graphqlRequest<{
        goal: Goal & {
          parentGoal?: { id: string; title: string };
          childGoals?: { id: string; title: string; status: string; progressPercent: number }[];
        };
      }, unknown>(client, GET_GOAL, { id }),
    select: (data) => data.goal,
    enabled: !!id,
  });
}

export function useMyGoals(filter?: GoalFilterInput) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: goalKeys.my(filter),
    queryFn: () =>
      graphqlRequest<{ myGoals: Goal[] }, unknown>(
        client,
        GET_MY_GOALS,
        { status: filter?.status }
      ),
    select: (data) => data.myGoals,
  });
}

export function useTeamGoals(managerId: string, filter?: GoalFilterInput) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: goalKeys.team(managerId, filter),
    queryFn: () =>
      graphqlRequest<{ teamGoals: Goal[] }, unknown>(
        client,
        GET_TEAM_GOALS,
        { managerId, status: filter?.status }
      ),
    select: (data) => data.teamGoals,
    enabled: !!managerId,
  });
}

export function useOverdueGoals(departmentId?: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: goalKeys.overdue(departmentId),
    queryFn: () =>
      graphqlRequest<{
        overdueGoals: (Goal & { daysOverdue: number })[];
      }, unknown>(client, GET_OVERDUE_GOALS, { departmentId }),
    select: (data) => data.overdueGoals,
  });
}

// =====================
// KPI Queries
// =====================

export function useEmployeeKPIs(
  employeeId: string,
  periodStart?: string,
  periodEnd?: string
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: kpiKeys.employee(employeeId, periodStart, periodEnd),
    queryFn: () =>
      graphqlRequest<{ employeeKPIs: EmployeeKPI[] }, unknown>(
        client,
        GET_EMPLOYEE_KPIS,
        { employeeId, periodStart, periodEnd }
      ),
    select: (data) => data.employeeKPIs,
    enabled: !!employeeId,
  });
}

// =====================
// Performance Review Mutations
// =====================

export function useCreatePerformanceReview() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreatePerformanceReviewInput) =>
      graphqlRequest<{ createPerformanceReview: PerformanceReview }, unknown>(
        client,
        CREATE_PERFORMANCE_REVIEW,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: reviewKeys.all });
    },
  });
}

export function useSubmitSelfAssessment() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: SubmitSelfAssessmentInput) =>
      graphqlRequest<{ submitSelfAssessment: PerformanceReview }, unknown>(
        client,
        SUBMIT_SELF_ASSESSMENT,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: reviewKeys.all });
    },
  });
}

export function useSubmitManagerAssessment() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: SubmitManagerAssessmentInput) =>
      graphqlRequest<{ submitManagerAssessment: PerformanceReview }, unknown>(
        client,
        SUBMIT_MANAGER_ASSESSMENT,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: reviewKeys.all });
    },
  });
}

export function useFinalizeReview() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: FinalizeReviewInput) =>
      graphqlRequest<{ finalizeReview: PerformanceReview }, unknown>(
        client,
        FINALIZE_REVIEW,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: reviewKeys.all });
    },
  });
}

export function useAcknowledgeReview() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { reviewId: string; comments?: string }) =>
      graphqlRequest<{ acknowledgeReview: PerformanceReview }, unknown>(
        client,
        ACKNOWLEDGE_REVIEW,
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: reviewKeys.all });
    },
  });
}

// =====================
// Goal Mutations
// =====================

export function useCreateGoal() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateGoalInput) =>
      graphqlRequest<{ createGoal: Goal }, unknown>(
        client,
        CREATE_GOAL,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: goalKeys.all });
    },
  });
}

export function useUpdateGoal() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateGoalInput) =>
      graphqlRequest<{ updateGoal: Goal }, unknown>(
        client,
        UPDATE_GOAL,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: goalKeys.all });
    },
  });
}

export function useUpdateGoalProgress() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateGoalProgressInput) =>
      graphqlRequest<{ updateGoalProgress: Goal }, unknown>(
        client,
        UPDATE_GOAL_PROGRESS,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: goalKeys.all });
    },
  });
}

export function useCompleteGoal() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { goalId: string; completionNotes?: string }) =>
      graphqlRequest<{ completeGoal: Goal }, unknown>(
        client,
        COMPLETE_GOAL,
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: goalKeys.all });
    },
  });
}

export function useCancelGoal() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { goalId: string; reason: string }) =>
      graphqlRequest<{ cancelGoal: Goal }, unknown>(
        client,
        CANCEL_GOAL,
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: goalKeys.all });
    },
  });
}

export function useDeferGoal() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { goalId: string; newTargetDate: string; reason?: string }) =>
      graphqlRequest<{ deferGoal: Goal }, unknown>(
        client,
        DEFER_GOAL,
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: goalKeys.all });
    },
  });
}
