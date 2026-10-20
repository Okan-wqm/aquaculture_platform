/**
 * Production-plan hooks — temperature scenarios + tank growth projection
 * (the farm module's Üretim Planı backing, PR design 2026-10-19).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  graphqlClient,
  useAuth,
  createTenantQueryKey,
  createTenantInvalidationKey,
} from '@aquaculture/shared-ui';

// ============================================================================
// TYPES
// ============================================================================

export interface TemperatureScenario {
  id: string;
  siteId: string;
  name: string;
  source: 'manual' | 'copernicus';
  points: { date: string; celsius: number }[];
  createdAt: string;
}

export interface ProjectionDay {
  day: number;
  date: string;
  temperatureC: number;
  avgWeightG: number;
  biomassKg: number;
  feedKg: number;
  capacityPercent: number;
}

export interface TankGrowthProjection {
  unitId: string;
  unitCode: string;
  unitName: string;
  siteId: string;
  siteName: string;
  departmentId: string | null;
  departmentName: string | null;
  protocolId: string;
  protocolName: string;
  fishCount: number;
  currentAvgWeightG: number;
  currentBiomassKg: number;
  capacityKg: number | null;
  projectedAvgWeightG: number;
  projectedBiomassKg: number;
  totalFeedKg: number;
  peakCapacityPercent: number;
  overCapacityDay: number | null;
  series: ProjectionDay[];
}

// ============================================================================
// QUERIES
// ============================================================================

export function useTemperatureScenarios(siteId: string | undefined) {
  const { token, tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'temperatureScenarios', siteId ?? null),
    queryFn: async () => {
      const data = await graphqlClient.request<{ temperatureScenarios: TemperatureScenario[] }>(
        `
        query TemperatureScenarios($siteId: ID!) {
          temperatureScenarios(siteId: $siteId) {
            id
            siteId
            name
            source
            points { date celsius }
            createdAt
          }
        }
      `,
        { siteId },
      );
      return data.temperatureScenarios;
    },
    enabled: !!token && !!tenantId && !!siteId,
  });
}

export function useTankGrowthProjection(input: {
  siteId?: string;
  departmentId?: string;
  horizonDays: number;
  scenarioId?: string;
}) {
  const { token, tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'tankGrowthProjection', input),
    queryFn: async () => {
      const data = await graphqlClient.request<{ tankGrowthProjection: TankGrowthProjection[] }>(
        `
        query TankGrowthProjection($input: TankGrowthProjectionInput) {
          tankGrowthProjection(input: $input) {
            unitId
            unitCode
            unitName
            siteId
            siteName
            departmentId
            departmentName
            protocolId
            protocolName
            fishCount
            currentAvgWeightG
            currentBiomassKg
            capacityKg
            projectedAvgWeightG
            projectedBiomassKg
            totalFeedKg
            peakCapacityPercent
            overCapacityDay
            series {
              day
              date
              temperatureC
              avgWeightG
              biomassKg
              feedKg
              capacityPercent
            }
          }
        }
      `,
        { input },
      );
      return data.tankGrowthProjection;
    },
    enabled: !!token && !!tenantId,
  });
}

// ============================================================================
// MUTATIONS
// ============================================================================

export function useCreateTemperatureScenario() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      siteId: string;
      name: string;
      points: { date: string; celsius: number }[];
    }) => {
      if (!token) throw new Error('Authentication required');
      if (!tenantId) throw new Error('Tenant context required');
      const data = await graphqlClient.request<{
        createTemperatureScenario: TemperatureScenario;
      }>(
        `
        mutation CreateTemperatureScenario($input: CreateTemperatureScenarioInput!) {
          createTemperatureScenario(input: $input) {
            id
            siteId
            name
            source
            points { date celsius }
            createdAt
          }
        }
      `,
        { input },
      );
      return data.createTemperatureScenario;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'temperatureScenarios'),
      });
    },
  });
}

export function useDeleteTemperatureScenario() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) throw new Error('Authentication required');
      if (!tenantId) throw new Error('Tenant context required');
      const data = await graphqlClient.request<{ deleteTemperatureScenario: boolean }>(
        `
        mutation DeleteTemperatureScenario($id: ID!) {
          deleteTemperatureScenario(id: $id)
        }
      `,
        { id },
      );
      return data.deleteTemperatureScenario;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'temperatureScenarios'),
      });
    },
  });
}
