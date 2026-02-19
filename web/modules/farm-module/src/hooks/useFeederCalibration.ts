/**
 * Feeder Calibration hooks
 * Handles CRUD for feeder calibrations via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

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
  query FeederCalibrations($tenantId: ID!, $schemaName: String!, $equipmentId: ID!) {
    feederCalibrations(tenantId: $tenantId, schemaName: $schemaName, equipmentId: $equipmentId) {
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
  mutation SaveFeederCalibrations($tenantId: ID!, $schemaName: String!, $input: SaveFeederCalibrationsInput!) {
    saveFeederCalibrations(tenantId: $tenantId, schemaName: $schemaName, input: $input) {
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

  // Derive schema name per project convention
  const schemaName = tenantId
    ? `tenant_${tenantId.replace(/-/g, '').substring(0, 8).toLowerCase()}`
    : null;

  return useQuery({
    queryKey: ['feederCalibrations', tenantId, equipmentId],
    queryFn: async () => {
      const data = await graphqlClient.request<{ feederCalibrations: FeederCalibration[] }>(
        FEEDER_CALIBRATIONS_QUERY,
        { tenantId, schemaName, equipmentId },
      );
      return data.feederCalibrations;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!equipmentId && !!schemaName,
  });
}

/**
 * Hook to save feeder calibrations (upsert all at once)
 */
export function useSaveFeederCalibrations() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  const schemaName = tenantId
    ? `tenant_${tenantId.replace(/-/g, '').substring(0, 8).toLowerCase()}`
    : null;

  return useMutation({
    mutationFn: async ({ equipmentId, calibrations }: {
      equipmentId: string;
      calibrations: FeederCalibrationItemInput[];
    }) => {
      if (!tenantId || !schemaName) throw new Error('Tenant context required');
      const data = await graphqlClient.request<{ saveFeederCalibrations: FeederCalibration[] }>(
        SAVE_FEEDER_CALIBRATIONS_MUTATION,
        { tenantId, schemaName, input: { equipmentId, calibrations } },
      );
      return data.saveFeederCalibrations;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['feederCalibrations', tenantId, variables.equipmentId] });
    },
  });
}
