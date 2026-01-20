/**
 * Aquaculture-specific HR Hooks
 * TanStack Query hooks for work areas, rotations, and crew management
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGraphQLClient, graphqlRequest } from './useGraphQL';
import {
  GET_WORK_AREAS,
  GET_WORK_AREA,
  GET_OFFSHORE_WORK_AREAS,
  GET_WORK_AREA_OCCUPANCY,
  GET_ALL_WORK_AREA_OCCUPANCIES,
  GET_WORK_ROTATIONS,
  GET_WORK_ROTATION,
  GET_MY_ROTATIONS,
  GET_CURRENT_ROTATION,
  GET_UPCOMING_ROTATIONS,
  GET_ROTATION_CALENDAR,
  GET_CURRENTLY_OFFSHORE,
  GET_OFFSHORE_HEADCOUNT,
  GET_ROTATION_CHANGEOVERS,
  GET_CREW_ASSIGNMENTS,
  GET_SEA_LAND_SPLIT,
  CREATE_WORK_AREA,
  UPDATE_WORK_AREA,
  CREATE_WORK_ROTATION,
  UPDATE_WORK_ROTATION,
  START_ROTATION,
  END_ROTATION,
  CANCEL_ROTATION,
  APPROVE_ROTATION,
} from '../graphql';
import type {
  WorkArea,
  WorkRotation,
  WorkAreaFilterInput,
  WorkRotationFilterInput,
  CreateWorkAreaInput,
  UpdateWorkAreaInput,
  CreateWorkRotationInput,
  UpdateWorkRotationInput,
  OffshoreStatus,
  CrewAssignment,
  RotationCalendarEntry,
  WorkAreaOccupancyReport,
  PaginationInput,
  PaginatedResponse,
} from '../types';

// Query Keys
export const workAreaKeys = {
  all: ['workAreas'] as const,
  lists: () => [...workAreaKeys.all, 'list'] as const,
  list: (filter?: WorkAreaFilterInput) =>
    [...workAreaKeys.lists(), { filter }] as const,
  details: () => [...workAreaKeys.all, 'detail'] as const,
  detail: (id: string) => [...workAreaKeys.details(), id] as const,
  offshore: () => [...workAreaKeys.all, 'offshore'] as const,
  occupancy: (workAreaId: string, date: string) =>
    [...workAreaKeys.all, 'occupancy', workAreaId, date] as const,
  allOccupancies: (date: string) =>
    [...workAreaKeys.all, 'allOccupancies', date] as const,
};

export const rotationKeys = {
  all: ['rotations'] as const,
  lists: () => [...rotationKeys.all, 'list'] as const,
  list: (filter?: WorkRotationFilterInput, pagination?: PaginationInput) =>
    [...rotationKeys.lists(), { filter, pagination }] as const,
  details: () => [...rotationKeys.all, 'detail'] as const,
  detail: (id: string) => [...rotationKeys.details(), id] as const,
  my: (filter?: WorkRotationFilterInput) =>
    [...rotationKeys.all, 'my', { filter }] as const,
  current: (employeeId: string) =>
    [...rotationKeys.all, 'current', employeeId] as const,
  upcoming: (employeeId: string) =>
    [...rotationKeys.all, 'upcoming', employeeId] as const,
  calendar: (workAreaId: string | undefined, startDate: string, endDate: string) =>
    [...rotationKeys.all, 'calendar', workAreaId, startDate, endDate] as const,
  changeovers: (startDate: string, endDate: string) =>
    [...rotationKeys.all, 'changeovers', startDate, endDate] as const,
};

export const crewKeys = {
  all: ['crew'] as const,
  currentlyOffshore: (workAreaId?: string) =>
    [...crewKeys.all, 'currentlyOffshore', workAreaId] as const,
  offshoreHeadcount: () => [...crewKeys.all, 'offshoreHeadcount'] as const,
  assignments: () => [...crewKeys.all, 'assignments'] as const,
  seaLandSplit: (departmentId?: string) =>
    [...crewKeys.all, 'seaLandSplit', departmentId] as const,
};

// =====================
// Work Area Queries
// =====================

export function useWorkAreas(filter?: WorkAreaFilterInput) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: workAreaKeys.list(filter),
    queryFn: () =>
      graphqlRequest<{ workAreas: WorkArea[] }, unknown>(
        client,
        GET_WORK_AREAS.loc?.source.body || '',
        { filter }
      ),
    select: (data) => data.workAreas,
  });
}

export function useWorkArea(id: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: workAreaKeys.detail(id),
    queryFn: () =>
      graphqlRequest<{
        workArea: WorkArea & {
          requiredCertifications: { id: string; code: string; name: string; category: string }[];
          currentAssignments: { id: string; firstName: string; lastName: string; avatarUrl?: string }[];
        };
      }, unknown>(client, GET_WORK_AREA.loc?.source.body || '', { id }),
    select: (data) => data.workArea,
    enabled: !!id,
  });
}

export function useOffshoreWorkAreas() {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: workAreaKeys.offshore(),
    queryFn: () =>
      graphqlRequest<{ offshoreWorkAreas: WorkArea[] }, unknown>(
        client,
        GET_OFFSHORE_WORK_AREAS.loc?.source.body || '',
        {}
      ),
    select: (data) => data.offshoreWorkAreas,
  });
}

export function useWorkAreaOccupancy(workAreaId: string, date: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: workAreaKeys.occupancy(workAreaId, date),
    queryFn: () =>
      graphqlRequest<{ workAreaOccupancy: WorkAreaOccupancyReport }, unknown>(
        client,
        GET_WORK_AREA_OCCUPANCY.loc?.source.body || '',
        { workAreaId, date }
      ),
    select: (data) => data.workAreaOccupancy,
    enabled: !!workAreaId && !!date,
  });
}

export function useAllWorkAreaOccupancies(date: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: workAreaKeys.allOccupancies(date),
    queryFn: () =>
      graphqlRequest<{
        allWorkAreaOccupancies: WorkAreaOccupancyReport[];
      }, unknown>(client, GET_ALL_WORK_AREA_OCCUPANCIES.loc?.source.body || '', { date }),
    select: (data) => data.allWorkAreaOccupancies,
    enabled: !!date,
  });
}

// =====================
// Work Rotation Queries
// =====================

export function useWorkRotations(
  filter?: WorkRotationFilterInput,
  pagination?: PaginationInput
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: rotationKeys.list(filter, pagination),
    queryFn: () =>
      graphqlRequest<{ workRotations: PaginatedResponse<WorkRotation> }, unknown>(
        client,
        GET_WORK_ROTATIONS.loc?.source.body || '',
        { filter, pagination }
      ),
    select: (data) => data.workRotations,
  });
}

export function useWorkRotation(id: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: rotationKeys.detail(id),
    queryFn: () =>
      graphqlRequest<{ workRotation: WorkRotation }, unknown>(
        client,
        GET_WORK_ROTATION.loc?.source.body || '',
        { id }
      ),
    select: (data) => data.workRotation,
    enabled: !!id,
  });
}

export function useMyRotations(filter?: WorkRotationFilterInput) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: rotationKeys.my(filter),
    queryFn: () =>
      graphqlRequest<{ myRotations: WorkRotation[] }, unknown>(
        client,
        GET_MY_ROTATIONS.loc?.source.body || '',
        { filter }
      ),
    select: (data) => data.myRotations,
  });
}

export function useCurrentRotation(employeeId: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: rotationKeys.current(employeeId),
    queryFn: () =>
      graphqlRequest<{
        currentRotation: WorkRotation & { daysRemaining: number; progressPercent: number };
      }, unknown>(client, GET_CURRENT_ROTATION.loc?.source.body || '', { employeeId }),
    select: (data) => data.currentRotation,
    enabled: !!employeeId,
  });
}

export function useUpcomingRotations(employeeId: string, limit = 5) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: rotationKeys.upcoming(employeeId),
    queryFn: () =>
      graphqlRequest<{ upcomingRotations: WorkRotation[] }, unknown>(
        client,
        GET_UPCOMING_ROTATIONS.loc?.source.body || '',
        { employeeId, limit }
      ),
    select: (data) => data.upcomingRotations,
    enabled: !!employeeId,
  });
}

export function useRotationCalendar(
  workAreaId: string | undefined,
  startDate: string,
  endDate: string
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: rotationKeys.calendar(workAreaId, startDate, endDate),
    queryFn: () =>
      graphqlRequest<{ rotationCalendar: RotationCalendarEntry[] }, unknown>(
        client,
        GET_ROTATION_CALENDAR.loc?.source.body || '',
        { workAreaId, startDate, endDate }
      ),
    select: (data) => data.rotationCalendar,
    enabled: !!startDate && !!endDate,
  });
}

export function useRotationChangeovers(startDate: string, endDate: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: rotationKeys.changeovers(startDate, endDate),
    queryFn: () =>
      graphqlRequest<{
        rotationChangeovers: {
          date: string;
          goingOffshore: {
            employeeId: string;
            employeeName: string;
            workAreaName: string;
            transportMethod: string;
            rotationId: string;
          }[];
          returningOnshore: {
            employeeId: string;
            employeeName: string;
            workAreaName: string;
            transportMethod: string;
            rotationId: string;
          }[];
        }[];
      }, unknown>(client, GET_ROTATION_CHANGEOVERS.loc?.source.body || '', {
        startDate,
        endDate,
      }),
    select: (data) => data.rotationChangeovers,
    enabled: !!startDate && !!endDate,
  });
}

// =====================
// Crew Status Queries
// =====================

export function useCurrentlyOffshore(workAreaId?: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: crewKeys.currentlyOffshore(workAreaId),
    queryFn: () =>
      graphqlRequest<{ currentlyOffshore: OffshoreStatus[] }, unknown>(
        client,
        GET_CURRENTLY_OFFSHORE.loc?.source.body || '',
        { workAreaId }
      ),
    select: (data) => data.currentlyOffshore,
    refetchInterval: 60000, // Refresh every minute
  });
}

export function useOffshoreHeadcount() {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: crewKeys.offshoreHeadcount(),
    queryFn: () =>
      graphqlRequest<{
        offshoreHeadcount: {
          totalOffshore: number;
          byWorkArea: { workAreaId: string; workAreaName: string; count: number; maxCapacity: number }[];
          byRotationType: { rotationType: string; count: number }[];
        };
      }, unknown>(client, GET_OFFSHORE_HEADCOUNT.loc?.source.body || '', {}),
    select: (data) => data.offshoreHeadcount,
  });
}

export function useCrewAssignments() {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: crewKeys.assignments(),
    queryFn: () =>
      graphqlRequest<{ crewAssignments: CrewAssignment[] }, unknown>(
        client,
        GET_CREW_ASSIGNMENTS.loc?.source.body || '',
        {}
      ),
    select: (data) => data.crewAssignments,
  });
}

export function useSeaLandSplit(departmentId?: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: crewKeys.seaLandSplit(departmentId),
    queryFn: () =>
      graphqlRequest<{
        seaLandSplit: {
          offshore: { count: number; employees: { id: string; firstName: string; lastName: string; currentWorkArea?: string }[] };
          onshore: { count: number; employees: { id: string; firstName: string; lastName: string }[] };
          inTransit: { count: number; employees: { id: string; firstName: string; lastName: string; destination?: string }[] };
          onLeave: { count: number; employees: { id: string; firstName: string; lastName: string }[] };
        };
      }, unknown>(client, GET_SEA_LAND_SPLIT.loc?.source.body || '', { departmentId }),
    select: (data) => data.seaLandSplit,
  });
}

// =====================
// Work Area Mutations
// =====================

export function useCreateWorkArea() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateWorkAreaInput) =>
      graphqlRequest<{ createWorkArea: WorkArea }, unknown>(
        client,
        CREATE_WORK_AREA.loc?.source.body || '',
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workAreaKeys.lists() });
      queryClient.invalidateQueries({ queryKey: workAreaKeys.offshore() });
    },
  });
}

export function useUpdateWorkArea() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateWorkAreaInput) =>
      graphqlRequest<{ updateWorkArea: WorkArea }, unknown>(
        client,
        UPDATE_WORK_AREA.loc?.source.body || '',
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: workAreaKeys.lists() });
      queryClient.setQueryData(
        workAreaKeys.detail(data.updateWorkArea.id),
        data.updateWorkArea
      );
    },
  });
}

// =====================
// Work Rotation Mutations
// =====================

export function useCreateWorkRotation() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateWorkRotationInput) =>
      graphqlRequest<{ createWorkRotation: WorkRotation }, unknown>(
        client,
        CREATE_WORK_ROTATION.loc?.source.body || '',
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: rotationKeys.lists() });
      queryClient.invalidateQueries({ queryKey: rotationKeys.my() });
    },
  });
}

export function useUpdateWorkRotation() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateWorkRotationInput) =>
      graphqlRequest<{ updateWorkRotation: WorkRotation }, unknown>(
        client,
        UPDATE_WORK_ROTATION.loc?.source.body || '',
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: rotationKeys.lists() });
      queryClient.setQueryData(
        rotationKeys.detail(data.updateWorkRotation.id),
        data.updateWorkRotation
      );
    },
  });
}

export function useStartRotation() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ rotationId, actualStartDate }: { rotationId: string; actualStartDate?: string }) =>
      graphqlRequest<{ startRotation: WorkRotation }, unknown>(
        client,
        START_ROTATION.loc?.source.body || '',
        { rotationId, actualStartDate }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: rotationKeys.lists() });
      queryClient.invalidateQueries({ queryKey: crewKeys.currentlyOffshore() });
      queryClient.invalidateQueries({ queryKey: crewKeys.offshoreHeadcount() });
      queryClient.setQueryData(
        rotationKeys.detail(data.startRotation.id),
        data.startRotation
      );
    },
  });
}

export function useEndRotation() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      rotationId,
      actualEndDate,
      notes,
    }: {
      rotationId: string;
      actualEndDate?: string;
      notes?: string;
    }) =>
      graphqlRequest<{ endRotation: WorkRotation }, unknown>(
        client,
        END_ROTATION.loc?.source.body || '',
        { rotationId, actualEndDate, notes }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: rotationKeys.lists() });
      queryClient.invalidateQueries({ queryKey: crewKeys.currentlyOffshore() });
      queryClient.invalidateQueries({ queryKey: crewKeys.offshoreHeadcount() });
      queryClient.setQueryData(
        rotationKeys.detail(data.endRotation.id),
        data.endRotation
      );
    },
  });
}

export function useCancelRotation() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ rotationId, reason }: { rotationId: string; reason: string }) =>
      graphqlRequest<{ cancelRotation: WorkRotation }, unknown>(
        client,
        CANCEL_ROTATION.loc?.source.body || '',
        { rotationId, reason }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: rotationKeys.lists() });
      queryClient.setQueryData(
        rotationKeys.detail(data.cancelRotation.id),
        data.cancelRotation
      );
    },
  });
}

export function useApproveRotation() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ rotationId, notes }: { rotationId: string; notes?: string }) =>
      graphqlRequest<{ approveRotation: WorkRotation }, unknown>(
        client,
        APPROVE_ROTATION.loc?.source.body || '',
        { rotationId, notes }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: rotationKeys.lists() });
      queryClient.setQueryData(
        rotationKeys.detail(data.approveRotation.id),
        data.approveRotation
      );
    },
  });
}
