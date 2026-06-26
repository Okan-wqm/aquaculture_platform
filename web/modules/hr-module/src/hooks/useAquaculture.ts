/**
 * Aquaculture-specific HR Hooks
 * TanStack Query hooks for work areas, rotations, and crew management
 */

import { useMemo } from 'react';
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
  GET_ROTATION_CHANGEOVERS,
  GET_CREW_ASSIGNMENTS,
  CREATE_WORK_AREA,
  UPDATE_WORK_AREA,
  DEACTIVATE_WORK_AREA,
  CREATE_WORK_ROTATION,
  UPDATE_WORK_ROTATION,
  START_ROTATION,
  END_ROTATION,
  CANCEL_ROTATION,
  APPROVE_ROTATION,
} from '../graphql';
import type {
  Employee,
  WorkArea,
  WorkRotation,
  WorkAreaFilterInput,
  WorkRotationFilterInput,
  CreateWorkAreaInput,
  UpdateWorkAreaInput,
  CreateWorkRotationInput,
  UpdateWorkRotationInput,
  CrewAssignment,
  RotationCalendarEntry,
  WorkAreaOccupancyReport,
  PaginatedResponse,
} from '../types';
import { useEmployees } from './useEmployees';

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
  list: (filter?: WorkRotationFilterInput) =>
    [...rotationKeys.lists(), { filter }] as const,
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
      graphqlRequest<{ workAreas: { items: WorkArea[]; total: number } }, unknown>(
        client,
        GET_WORK_AREAS,
        {
          workAreaType: filter?.workAreaType,
          siteId: filter?.siteId,
          isOffshore: filter?.isOffshore,
          isActive: filter?.isActive,
        }
      ),
    select: (data) => data.workAreas.items ?? [],
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
          currentAssignments: { id: string; firstName: string; lastName: string }[];
        };
      }, unknown>(client, GET_WORK_AREA, { id }),
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
        GET_OFFSHORE_WORK_AREAS,
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
        GET_WORK_AREA_OCCUPANCY,
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
      }, unknown>(client, GET_ALL_WORK_AREA_OCCUPANCIES, { date }),
    select: (data) => data.allWorkAreaOccupancies,
    enabled: !!date,
  });
}

// =====================
// Work Rotation Queries
// =====================

// WHY: Backend workRotations query returns a paginated WorkRotationConnection
// (with items, total, page, etc.), not a flat array. The previous implementation
// expected WorkRotation[] which caused a shape mismatch and silent data loss.
// Extract .items from the paginated response so downstream consumers get the array they expect.
export function useWorkRotations(filter?: WorkRotationFilterInput) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: rotationKeys.list(filter),
    queryFn: () =>
      graphqlRequest<{ workRotations: { items: WorkRotation[]; total: number } }, unknown>(
        client,
        GET_WORK_ROTATIONS,
        {
          employeeId: filter?.employeeId,
          workAreaId: filter?.workAreaId,
          rotationType: filter?.rotationType,
          status: filter?.status,
        }
      ),
    select: (data) => data.workRotations?.items ?? [],
  });
}

export function useWorkRotation(id: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: rotationKeys.detail(id),
    queryFn: () =>
      graphqlRequest<{ workRotation: WorkRotation }, unknown>(
        client,
        GET_WORK_ROTATION,
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
      graphqlRequest<{ myWorkRotations: WorkRotation[] }, unknown>(
        client,
        GET_MY_ROTATIONS,
        { status: filter?.status }
      ),
    select: (data) => data.myWorkRotations,
  });
}

export function useCurrentRotation(employeeId: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: rotationKeys.current(employeeId),
    queryFn: () =>
      graphqlRequest<{
        currentRotation: WorkRotation & { daysRemaining: number; progressPercent: number };
      }, unknown>(client, GET_CURRENT_ROTATION, { employeeId }),
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
        GET_UPCOMING_ROTATIONS,
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
        GET_ROTATION_CALENDAR,
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
      }, unknown>(client, GET_ROTATION_CHANGEOVERS, {
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
      graphqlRequest<{ currentlyOffshore: Employee[] }, unknown>(
        client,
        GET_CURRENTLY_OFFSHORE,
        { workAreaId }
      ),
    select: (data) => data.currentlyOffshore,
    refetchInterval: 60000, // Refresh every minute
  });
}

/**
 * Client-side aggregation of offshore headcount data.
 * Uses currentlyOffshore + offshoreWorkAreas queries instead of a dedicated
 * offshoreHeadcount backend query (which does not exist).
 */
export function useOffshoreHeadcount() {
  const offshoreQuery = useCurrentlyOffshore();
  const offshoreWorkAreasQuery = useOffshoreWorkAreas();

  const data = useMemo(() => {
    const offshoreEmployees = offshoreQuery.data ?? [];
    const workAreas = offshoreWorkAreasQuery.data ?? [];

    const totalOffshore = offshoreEmployees.length;

    // Build byWorkArea from offshore work areas
    const byWorkArea = workAreas.map((wa: WorkArea) => ({
      workAreaId: wa.id,
      workAreaName: wa.name,
      // Exact per-work-area counts are not available from currentlyOffshore;
      // report capacity only.
      count: 0,
      maxCapacity: wa.maxCapacity ?? 0,
    }));

    // Build byRotationType from employee personnelCategory
    const rotationMap = new Map<string, number>();
    for (const emp of offshoreEmployees) {
      const key = (emp as Employee & { personnelCategory?: string }).personnelCategory ?? 'UNKNOWN';
      rotationMap.set(key, (rotationMap.get(key) ?? 0) + 1);
    }
    const byRotationType = Array.from(rotationMap.entries()).map(([rotationType, count]) => ({
      rotationType,
      count,
    }));

    return { totalOffshore, byWorkArea, byRotationType };
  }, [offshoreQuery.data, offshoreWorkAreasQuery.data]);

  return {
    data,
    isLoading: offshoreQuery.isLoading || offshoreWorkAreasQuery.isLoading,
    error: offshoreQuery.error || offshoreWorkAreasQuery.error,
    isError: offshoreQuery.isError || offshoreWorkAreasQuery.isError,
  };
}

export function useCrewAssignments() {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: crewKeys.assignments(),
    queryFn: () =>
      graphqlRequest<{ crewAssignments: CrewAssignment[] }, unknown>(
        client,
        GET_CREW_ASSIGNMENTS,
        {}
      ),
    select: (data) => data.crewAssignments,
  });
}

/**
 * Client-side aggregation of sea/land split data.
 * Uses currentlyOffshore + employees queries instead of a dedicated
 * seaLandSplit backend query (which does not exist).
 *
 * Categories:
 * - offshore: employees returned by currentlyOffshore query
 * - onLeave: employees with status ON_LEAVE
 * - onshore: all remaining active employees
 * - inTransit: currently empty (no transit status available from backend)
 */
export function useSeaLandSplit(_departmentId?: string) {
  const offshoreQuery = useCurrentlyOffshore();
  // Backend EmployeeFilterInput does not support departmentHrId; fetch all
  // employees and rely on the offshore query for the split.
  const employeesQuery = useEmployees();

  const data = useMemo(() => {
    const offshoreEmployees = offshoreQuery.data ?? [];
    const allEmployees = employeesQuery.data?.items ?? [];
    const offshoreIds = new Set(offshoreEmployees.map((e) => e.id));

    const offshore = offshoreEmployees.map((e) => ({
      id: e.id,
      firstName: e.firstName,
      lastName: e.lastName,
      currentWorkArea: e.personnelCategory ?? undefined,
    }));

    const onLeave = allEmployees
      .filter((e) => e.status === 'ON_LEAVE' && !offshoreIds.has(e.id))
      .map((e) => ({
        id: e.id,
        firstName: e.firstName,
        lastName: e.lastName,
      }));
    const onLeaveIds = new Set(onLeave.map((e) => e.id));

    const onshore = allEmployees
      .filter((e) => !offshoreIds.has(e.id) && !onLeaveIds.has(e.id))
      .map((e) => ({
        id: e.id,
        firstName: e.firstName,
        lastName: e.lastName,
      }));

    // inTransit: not available from current backend — return empty
    const inTransit: { id: string; firstName: string; lastName: string; destination?: string }[] = [];

    return {
      offshore: { count: offshore.length, employees: offshore },
      onshore: { count: onshore.length, employees: onshore },
      inTransit: { count: inTransit.length, employees: inTransit },
      onLeave: { count: onLeave.length, employees: onLeave },
    };
  }, [offshoreQuery.data, employeesQuery.data]);

  return {
    data,
    isLoading: offshoreQuery.isLoading || employeesQuery.isLoading,
    error: offshoreQuery.error || employeesQuery.error,
    isError: offshoreQuery.isError || employeesQuery.isError,
  };
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
        CREATE_WORK_AREA,
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
        UPDATE_WORK_AREA,
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
        CREATE_WORK_ROTATION,
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
        UPDATE_WORK_ROTATION,
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
        START_ROTATION,
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
        END_ROTATION,
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
        CANCEL_ROTATION,
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
        APPROVE_ROTATION,
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

// =====================
// Work Area Deactivation
// =====================

export function useDeactivateWorkArea() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      graphqlRequest<{ deactivateWorkArea: WorkArea }, unknown>(
        client,
        DEACTIVATE_WORK_AREA,
        { id }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: workAreaKeys.lists() });
      queryClient.invalidateQueries({ queryKey: workAreaKeys.offshore() });
      queryClient.setQueryData(
        workAreaKeys.detail(data.deactivateWorkArea.id),
        data.deactivateWorkArea
      );
    },
  });
}
