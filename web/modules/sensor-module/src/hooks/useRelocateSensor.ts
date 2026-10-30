/**
 * Move a sensor to another place in the farm topology (`relocateSensor`).
 *
 * Farm checks the path and says whether the unit is a tank or other water
 * equipment; a parent device moves with its child sensors. The answer is the
 * sensor as it now stands; the cached sensor lists are dropped so they show
 * the new place too.
 */
import { useTenantMutation } from '@aquaculture/shared-ui';
import type { UseMutationResult } from '@tanstack/react-query';

import { graphqlFetch } from '../config/api';

export const RELOCATE_SENSOR_MUTATION = `
  mutation RelocateSensor($input: RelocateSensorInput!) {
    relocateSensor(input: $input) {
      id
      siteId
      departmentId
      systemId
      tankId
      equipmentId
    }
  }
`;

export interface RelocateSensorInput {
  sensorId: string;
  siteId: string;
  departmentId: string | null;
  systemId: string | null;
  unitId: string | null;
}

export interface RelocatedSensor {
  id: string;
  siteId: string | null;
  departmentId: string | null;
  systemId: string | null;
  tankId: string | null;
  equipmentId: string | null;
}

export function useRelocateSensor(): UseMutationResult<
  RelocatedSensor,
  Error,
  RelocateSensorInput
> {
  return useTenantMutation<RelocatedSensor, Error, RelocateSensorInput>(
    async (input) => {
      const data = await graphqlFetch<{ relocateSensor: RelocatedSensor }>(
        RELOCATE_SENSOR_MUTATION,
        { input },
      );
      return data.relocateSensor;
    },
    { invalidate: [['sensors']] },
  );
}
