/**
 * Feeder Calibration hooks
 * Handles CRUD for feeder calibrations via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';

export interface FeederCalibration {
  id: string;
  equipmentId: string;
  feedSizeMm: number;
  feedSizeLabel?: string;
  gramsPerDispensing: number;
  siloCapacityKg: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeederCalibrationItemInput {
  feedSizeMm: number;
  feedSizeLabel?: string;
  gramsPerDispensing: number;
  siloCapacityKg: number;
  notes?: string;
}

const FEEDER_CALIBRATIONS_QUERY = `
  query FeederCalibrations($equipmentId: ID!) {
    feederCalibrations(equipmentId: $equipmentId) {
      id
      equipmentId
      feedSizeMm
      feedSizeLabel
      gramsPerDispensing
      siloCapacityKg
      notes
      createdAt
      updatedAt
    }
  }
`;

const SAVE_FEEDER_CALIBRATIONS_MUTATION = `
  mutation SaveFeederCalibrations($input: SaveFeederCalibrationsInput!) {
    saveFeederCalibrations(input: $input) {
      id
      equipmentId
      feedSizeMm
      feedSizeLabel
      gramsPerDispensing
      siloCapacityKg
      notes
      createdAt
      updatedAt
    }
  }
`;

/**
 * Hook to fetch feeder calibrations for an equipment
 */
export function useFeederCalibrations(equipmentId: string | null) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feederCalibrations', tenantId, equipmentId),
    queryFn: async () => {
      const data = await graphqlClient.request<{ feederCalibrations: FeederCalibration[] }>(
        FEEDER_CALIBRATIONS_QUERY,
        { equipmentId },
      );
      return data.feederCalibrations;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!equipmentId,
  });
}

/**
 * Hook to save feeder calibrations (upsert all at once)
 */
export function useSaveFeederCalibrations() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ equipmentId, calibrations }: {
      equipmentId: string;
      calibrations: FeederCalibrationItemInput[];
    }) => {
      if (!tenantId) throw new Error('Tenant context required');
      const data = await graphqlClient.request<{ saveFeederCalibrations: FeederCalibration[] }>(
        SAVE_FEEDER_CALIBRATIONS_MUTATION,
        { input: { equipmentId, calibrations } },
      );
      return data.saveFeederCalibrations;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feederCalibrations', tenantId, variables.equipmentId) });
    },
  });
}
