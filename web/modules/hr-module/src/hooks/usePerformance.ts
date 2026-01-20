/**
 * Performance Management Hooks
 * TanStack Query hooks for performance reviews and goals
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
  PaginationInput,
  PaginatedResponse,
} from '../types';

// Query Keys
export const reviewKeys = {
  all: ['reviews'] as const,
  lists: () => [...reviewKeys.all, 'list'] as const,
  list: (filter?: PerformanceReviewFilterInput, pagination?: PaginationInput) =>
    [...reviewKeys.lists(), { filter, pagination }] as const,
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
  list: (filter?: GoalFilterInput, pagination?: PaginationInput) =>
    [...goalKeys.lists(), { filter, pagination }] as const,
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
  filter?: PerformanceReviewFilterInput,
  pagination?: PaginationInput
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: reviewKeys.list(filter, pagination),
    queryFn: () =>
      graphqlRequest<{
        performanceReviews: PaginatedResponse<PerformanceReview>;
      }, unknown>(client, GET_PERFORMANCE_REVIEWS.loc?.source.body || '', {
        filter,
        pagination,
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
        GET_PERFORMANCE_REVIEW.loc?.source.body || '',
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
        GET_MY_PERFORMANCE_REVIEWS.loc?.source.body || '',
        { filter }
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
        GET_PENDING_REVIEWS.loc?.source.body || '',
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
      }, unknown>(client, GET_TEAM_PERFORMANCE_OVERVIEW.loc?.source.body || '', {
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
        GET_PERFORMANCE_SUMMARY.loc?.source.body || '',
        { employeeId }
      ),
    select: (data) => data.performanceSummary,
    enabled: !!employeeId,
  });
}

// =====================
// Goal Queries
// =====================

export function useGoals(filter?: GoalFilterInput, pagination?: PaginationInput) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: goalKeys.list(filter, pagination),
    queryFn: () =>
      graphqlRequest<{ goals: PaginatedResponse<Goal> }, unknown>(
        client,
        GET_GOALS.loc?.source.body || '',
        { filter, pagination }
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
      }, unknown>(client, GET_GOAL.loc?.source.body || '', { id }),
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
        GET_MY_GOALS.loc?.source.body || '',
        { filter }
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
        GET_TEAM_GOALS.loc?.source.body || '',
        { managerId, filter }
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
      }, unknown>(client, GET_OVERDUE_GOALS.loc?.source.body || '', { departmentId }),
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
        GET_EMPLOYEE_KPIS.loc?.source.body || '',
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
        CREATE_PERFORMANCE_REVIEW.loc?.source.body || '',
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: reviewKeys.lists() });
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
        SUBMIT_SELF_ASSESSMENT.loc?.source.body || '',
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: reviewKeys.lists() });
      queryClient.invalidateQueries({ queryKey: reviewKeys.my() });
      queryClient.setQueryData(
        reviewKeys.detail(data.submitSelfAssessment.id),
        data.submitSelfAssessment
      );
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
        SUBMIT_MANAGER_ASSESSMENT.loc?.source.body || '',
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: reviewKeys.lists() });
      queryClient.invalidateQueries({ queryKey: reviewKeys.pending });
      queryClient.setQueryData(
        reviewKeys.detail(data.submitManagerAssessment.id),
        data.submitManagerAssessment
      );
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
        FINALIZE_REVIEW.loc?.source.body || '',
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: reviewKeys.lists() });
      queryClient.setQueryData(
        reviewKeys.detail(data.finalizeReview.id),
        data.finalizeReview
      );
    },
  });
}

export function useAcknowledgeReview() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ reviewId, comments }: { reviewId: string; comments?: string }) =>
      graphqlRequest<{ acknowledgeReview: PerformanceReview }, unknown>(
        client,
        ACKNOWLEDGE_REVIEW.loc?.source.body || '',
        { reviewId, comments }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: reviewKeys.lists() });
      queryClient.invalidateQueries({ queryKey: reviewKeys.my() });
      queryClient.setQueryData(
        reviewKeys.detail(data.acknowledgeReview.id),
        data.acknowledgeReview
      );
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
        CREATE_GOAL.loc?.source.body || '',
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: goalKeys.lists() });
      queryClient.invalidateQueries({ queryKey: goalKeys.my() });
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
        UPDATE_GOAL.loc?.source.body || '',
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: goalKeys.lists() });
      queryClient.setQueryData(goalKeys.detail(data.updateGoal.id), data.updateGoal);
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
        UPDATE_GOAL_PROGRESS.loc?.source.body || '',
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: goalKeys.lists() });
      queryClient.invalidateQueries({ queryKey: goalKeys.my() });
      queryClient.setQueryData(
        goalKeys.detail(data.updateGoalProgress.id),
        data.updateGoalProgress
      );
    },
  });
}

export function useCompleteGoal() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ goalId, completionNotes }: { goalId: string; completionNotes?: string }) =>
      graphqlRequest<{ completeGoal: Goal }, unknown>(
        client,
        COMPLETE_GOAL.loc?.source.body || '',
        { goalId, completionNotes }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: goalKeys.lists() });
      queryClient.invalidateQueries({ queryKey: goalKeys.my() });
      queryClient.setQueryData(goalKeys.detail(data.completeGoal.id), data.completeGoal);
    },
  });
}

export function useCancelGoal() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ goalId, reason }: { goalId: string; reason: string }) =>
      graphqlRequest<{ cancelGoal: Goal }, unknown>(
        client,
        CANCEL_GOAL.loc?.source.body || '',
        { goalId, reason }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: goalKeys.lists() });
      queryClient.invalidateQueries({ queryKey: goalKeys.my() });
      queryClient.setQueryData(goalKeys.detail(data.cancelGoal.id), data.cancelGoal);
    },
  });
}

export function useDeferGoal() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      goalId,
      newTargetDate,
      reason,
    }: {
      goalId: string;
      newTargetDate: string;
      reason?: string;
    }) =>
      graphqlRequest<{ deferGoal: Goal }, unknown>(
        client,
        DEFER_GOAL.loc?.source.body || '',
        { goalId, newTargetDate, reason }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: goalKeys.lists() });
      queryClient.invalidateQueries({ queryKey: goalKeys.overdue() });
      queryClient.setQueryData(goalKeys.detail(data.deferGoal.id), data.deferGoal);
    },
  });
}
