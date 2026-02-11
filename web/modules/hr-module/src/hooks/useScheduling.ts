/**
 * Scheduling Hooks
 * TanStack Query hooks for weekly workforce planning
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGraphQLClient, graphqlRequest } from './useGraphQL';
import {
  GET_WEEKLY_PLANS,
  GET_WEEKLY_PLAN,
  GET_TEAM_WEEKLY_OVERVIEW,
  GET_SCHEDULING_SETTINGS,
  GET_OVERTIME_SUMMARY,
  CREATE_WEEKLY_PLAN,
  UPDATE_PLAN_ENTRY,
  BULK_ASSIGN_SHIFTS,
  COPY_WEEKLY_PLAN,
  PUBLISH_WEEKLY_PLAN,
  DELETE_WEEKLY_PLAN,
  UPDATE_SCHEDULING_SETTINGS,
} from '../graphql/scheduling.operations';
import type {
  WeeklyPlan,
  WeeklyPlanEntry,
  WeeklyPlanConnection,
  TeamWeeklyOverview,
  SchedulingSettings,
  OvertimeSummary,
  BulkAssignResult,
  CreateWeeklyPlanInput,
  UpdatePlanEntryInput,
  BulkAssignShiftsInput,
  UpdateSchedulingSettingsInput,
  WeeklyPlanFilter,
  WeeklyPlanStatus,
} from '../types/scheduling.types';

// Query Keys
export const schedulingKeys = {
  all: ['scheduling'] as const,
  weeklyPlans: () => [...schedulingKeys.all, 'weeklyPlans'] as const,
  weeklyPlanList: (filter?: WeeklyPlanFilter, limit?: number, offset?: number) =>
    [...schedulingKeys.weeklyPlans(), { filter, limit, offset }] as const,
  weeklyPlan: (id: string) => [...schedulingKeys.weeklyPlans(), id] as const,
  teamOverview: (weekStartDate: string, departmentId?: string, siteId?: string) =>
    [...schedulingKeys.all, 'teamOverview', weekStartDate, departmentId, siteId] as const,
  settings: () => [...schedulingKeys.all, 'settings'] as const,
  overtimeSummary: (month: number, year: number, employeeId?: string, departmentId?: string) =>
    [...schedulingKeys.all, 'overtime', month, year, employeeId, departmentId] as const,
};

// =====================
// Weekly Plan Queries
// =====================

export function useWeeklyPlans(
  filter?: WeeklyPlanFilter,
  limit = 20,
  offset = 0
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: schedulingKeys.weeklyPlanList(filter, limit, offset),
    queryFn: () =>
      graphqlRequest<{ weeklyPlans: WeeklyPlanConnection }, unknown>(
        client,
        GET_WEEKLY_PLANS,
        {
          employeeId: filter?.employeeId,
          departmentId: filter?.departmentId,
          siteId: filter?.siteId,
          weekStartDate: filter?.weekStartDate,
          status: filter?.status,
          limit,
          offset,
        }
      ),
    select: (data) => data.weeklyPlans,
  });
}

export function useWeeklyPlan(id: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: schedulingKeys.weeklyPlan(id),
    queryFn: () =>
      graphqlRequest<{ weeklyPlan: WeeklyPlan }, unknown>(
        client,
        GET_WEEKLY_PLAN,
        { id }
      ),
    select: (data) => data.weeklyPlan,
    enabled: !!id,
  });
}

export function useTeamWeeklyOverview(
  weekStartDate: string,
  departmentId?: string,
  siteId?: string
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: schedulingKeys.teamOverview(weekStartDate, departmentId, siteId),
    queryFn: () =>
      graphqlRequest<{ teamWeeklyOverview: TeamWeeklyOverview }, unknown>(
        client,
        GET_TEAM_WEEKLY_OVERVIEW,
        { weekStartDate, departmentId, siteId }
      ),
    select: (data) => data.teamWeeklyOverview,
    enabled: !!weekStartDate,
  });
}

export function useSchedulingSettings() {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: schedulingKeys.settings(),
    queryFn: () =>
      graphqlRequest<{ schedulingSettings: SchedulingSettings }, unknown>(
        client,
        GET_SCHEDULING_SETTINGS,
        {}
      ),
    select: (data) => data.schedulingSettings,
  });
}

export function useOvertimeSummary(
  month: number,
  year: number,
  employeeId?: string,
  departmentId?: string
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: schedulingKeys.overtimeSummary(month, year, employeeId, departmentId),
    queryFn: () =>
      graphqlRequest<{ overtimeSummary: OvertimeSummary }, unknown>(
        client,
        GET_OVERTIME_SUMMARY,
        { month, year, employeeId, departmentId }
      ),
    select: (data) => data.overtimeSummary,
    // Note: month can be 0 (January), so use explicit undefined check
    enabled: month !== undefined && month !== null && !!year,
  });
}

// =====================
// Weekly Plan Mutations
// =====================

export function useCreateWeeklyPlan() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateWeeklyPlanInput) =>
      graphqlRequest<{ createWeeklyPlan: WeeklyPlan }, unknown>(
        client,
        CREATE_WEEKLY_PLAN,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: schedulingKeys.weeklyPlans() });
      queryClient.invalidateQueries({ queryKey: schedulingKeys.all });
    },
  });
}

export function useUpdatePlanEntry() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdatePlanEntryInput) =>
      graphqlRequest<{ updatePlanEntry: WeeklyPlanEntry }, unknown>(
        client,
        UPDATE_PLAN_ENTRY,
        { input }
      ),
    onSuccess: (_data, variables) => {
      // Invalidate the specific weekly plan and list
      queryClient.invalidateQueries({ queryKey: schedulingKeys.weeklyPlans() });
      queryClient.invalidateQueries({ queryKey: schedulingKeys.all });
    },
  });
}

export function useBulkAssignShifts() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: BulkAssignShiftsInput) =>
      graphqlRequest<{ bulkAssignShifts: BulkAssignResult }, unknown>(
        client,
        BULK_ASSIGN_SHIFTS,
        { input }
      ),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: schedulingKeys.weeklyPlan(variables.weeklyPlanId),
      });
      queryClient.invalidateQueries({ queryKey: schedulingKeys.weeklyPlans() });
    },
  });
}

export function useCopyWeeklyPlan() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      sourceId,
      targetWeekStartDate,
    }: {
      sourceId: string;
      targetWeekStartDate: string;
    }) =>
      graphqlRequest<{ copyWeeklyPlan: WeeklyPlan }, unknown>(
        client,
        COPY_WEEKLY_PLAN,
        { sourceId, targetWeekStartDate }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: schedulingKeys.weeklyPlans() });
    },
  });
}

export function usePublishWeeklyPlan() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      graphqlRequest<{ publishWeeklyPlan: WeeklyPlan }, unknown>(
        client,
        PUBLISH_WEEKLY_PLAN,
        { id }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: schedulingKeys.weeklyPlan(data.publishWeeklyPlan.id),
      });
      queryClient.invalidateQueries({ queryKey: schedulingKeys.weeklyPlans() });
    },
  });
}

export function useDeleteWeeklyPlan() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      graphqlRequest<{ deleteWeeklyPlan: boolean }, unknown>(
        client,
        DELETE_WEEKLY_PLAN,
        { id }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: schedulingKeys.weeklyPlans() });
    },
  });
}

// =====================
// Settings Mutations
// =====================

export function useUpdateSchedulingSettings() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateSchedulingSettingsInput) =>
      graphqlRequest<{ updateSchedulingSettings: SchedulingSettings }, unknown>(
        client,
        UPDATE_SCHEDULING_SETTINGS,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: schedulingKeys.settings() });
    },
  });
}

// =====================
// Utility Functions
// =====================

/**
 * Format minutes as hours string (e.g., "8h 30m")
 */
export function formatMinutesAsHours(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Get Monday of the week for a given date
 */
export function getWeekMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}

/**
 * Format date as ISO string (YYYY-MM-DD)
 */
export function formatDateISO(date: Date): string {
  return date.toISOString().split('T')[0]!;
}

/**
 * Get weekday name in Turkish
 */
export function getWeekdayNameTR(day: string): string {
  const names: Record<string, string> = {
    monday: 'Pazartesi',
    tuesday: 'Salı',
    wednesday: 'Çarşamba',
    thursday: 'Perşembe',
    friday: 'Cuma',
    saturday: 'Cumartesi',
    sunday: 'Pazar',
  };
  return names[day] || day;
}

/**
 * Get short weekday name in Turkish
 */
export function getWeekdayShortTR(day: string): string {
  const names: Record<string, string> = {
    monday: 'Pzt',
    tuesday: 'Sal',
    wednesday: 'Çar',
    thursday: 'Per',
    friday: 'Cum',
    saturday: 'Cts',
    sunday: 'Paz',
  };
  return names[day] || day;
}
