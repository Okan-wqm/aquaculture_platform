/**
 * Feeder setup hooks — the machine's dosing physics plus its per-feed
 * calibrations, read and written as one unit.
 *
 * The wire shape mirrors the backend's discriminated input: a payload carries
 * EITHER a `discrete` branch (grams per actuation) OR a `continuous` one (grams
 * per minute at a drive speed, plus the speed band the rate is valid on). There
 * is deliberately no flat object with both sets of fields — a mixed row is not
 * expressible from here, exactly as it is not storable in the database.
 *
 * The speed band and the silo capacity appear ONCE per payload, on the branch,
 * never per calibration row: they describe the machine, and a per-row copy is
 * how the old shape ended up with one silo claiming two capacities.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useAuth,
  graphqlClient,
  createTenantQueryKey,
  createTenantInvalidationKey,
} from '@aquaculture/shared-ui';

export type FeederDosingMode = 'DISCRETE' | 'CONTINUOUS';
export type FeederDispenseControl = 'TIME_BASED' | 'WEIGHT_BASED';

export interface FeederCalibration {
  id: string;
  equipmentId: string;
  /** `feeds.id` — the identity a protocol band selects, not a pellet diameter. */
  feedId: string;
  dosingMode: FeederDosingMode;
  gramsPerDispensing?: number | null;
  gramsPerMinute?: number | null;
  referenceSpeedHz?: number | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeederCapability {
  equipmentId: string;
  dosingMode: FeederDosingMode;
  siloCapacityKg?: number | null;
  minSpeedHz?: number | null;
  maxSpeedHz?: number | null;
  dispenseControl: FeederDispenseControl;
  weightSensorId?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeederSetup {
  /** Null when the equipment was never commissioned as a feeder. */
  capability?: FeederCapability | null;
  calibrations: FeederCalibration[];
}

export interface DiscreteFeederCalibrationItemInput {
  feedId: string;
  gramsPerDispensing: number;
  notes?: string;
}

export interface ContinuousFeederCalibrationItemInput {
  feedId: string;
  gramsPerMinute: number;
  referenceSpeedHz: number;
  notes?: string;
}

export interface SaveFeederSetupInput {
  equipmentId: string;
  dispense: { mode: FeederDispenseControl; weightSensorId?: string };
  discrete?: { siloCapacityKg?: number; calibrations: DiscreteFeederCalibrationItemInput[] };
  continuous?: {
    siloCapacityKg?: number;
    minSpeedHz: number;
    maxSpeedHz: number;
    calibrations: ContinuousFeederCalibrationItemInput[];
  };
  notes?: string;
}

const FEEDER_SETUP_FIELDS = `
  capability {
    equipmentId
    dosingMode
    siloCapacityKg
    minSpeedHz
    maxSpeedHz
    dispenseControl
    weightSensorId
    notes
    createdAt
    updatedAt
  }
  calibrations {
    id
    equipmentId
    feedId
    dosingMode
    gramsPerDispensing
    gramsPerMinute
    referenceSpeedHz
    notes
    createdAt
    updatedAt
  }
`;

const FEEDER_SETUP_QUERY = `
  query FeederSetup($equipmentId: ID!) {
    feederSetup(equipmentId: $equipmentId) {
      ${FEEDER_SETUP_FIELDS}
    }
  }
`;

const SAVE_FEEDER_CALIBRATIONS_MUTATION = `
  mutation SaveFeederCalibrations($input: SaveFeederCalibrationsInput!) {
    saveFeederCalibrations(input: $input) {
      id
      equipmentId
      feedId
      dosingMode
      gramsPerDispensing
      gramsPerMinute
      referenceSpeedHz
      notes
      createdAt
      updatedAt
    }
  }
`;

/**
 * Hook to fetch a feeder's dosing physics and per-feed calibrations.
 */
export function useFeederSetup(equipmentId: string | null) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feederSetup', tenantId, equipmentId),
    queryFn: async () => {
      const data = await graphqlClient.request<{ feederSetup: FeederSetup }>(FEEDER_SETUP_QUERY, {
        equipmentId,
      });
      return data.feederSetup;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!equipmentId,
  });
}

/**
 * Hook to save a feeder's setup (capability + calibrations, one transaction).
 */
export function useSaveFeederSetup() {
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SaveFeederSetupInput) => {
      if (!tenantId) throw new Error('Tenant context required');
      const data = await graphqlClient.request<{ saveFeederCalibrations: FeederCalibration[] }>(
        SAVE_FEEDER_CALIBRATIONS_MUTATION,
        { input },
      );
      return data.saveFeederCalibrations;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(
          tenantId,
          'feederSetup',
          tenantId,
          variables.equipmentId,
        ),
      });
    },
  });
}
