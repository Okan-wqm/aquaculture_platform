/**
 * Sensor hook for farm-module
 *
 * WHY: sensor-module owns web/modules/sensor-module/src/hooks/useSensorList.ts,
 * but Module-Federation remotes cannot import each other's internals. The
 * tank/equipment create+edit form links a temperature sensor to a tank at
 * creation, so farm-module needs its own small hook that runs the federated
 * `sensors` query through farm-module's shared graphqlClient.
 *
 * WHAT: uses the shared `useTenantQuery` (tenant-prefixed key + auth gate) with
 * the federated `sensors` query through farm-module's shared graphqlClient, so
 * the sensor list is cache-isolated per tenant.
 */
import { useTenantQuery, graphqlClient } from '@aquaculture/shared-ui';
import type { PaginationResultV1 } from '@platform/pagination-contracts';

export interface FarmSensor {
  id: string;
  name: string;
  type: string;
  serialNumber?: string;
  registrationStatus?: string;
}

type SensorsResponse = Pick<PaginationResultV1<FarmSensor>, 'items' | 'total'>;

// Federated `sensors` query (sensor-service). SensorPaginationInput = page/limit
// with limit capped at 100 by the backend; limit:100 fetches the full sensor
// list for the picker in a single request.
const SENSORS_QUERY = `
  query Sensors($pagination: SensorPaginationInput) {
    sensors(pagination: $pagination) {
      items {
        id
        name
        type
        serialNumber
        registrationStatus
      }
      total
    }
  }
`;

interface UseSensorsResult {
  sensors: readonly FarmSensor[];
  isLoading: boolean;
}

/**
 * Hook to fetch the tenant's registered sensors for linking to equipment
 * (tanks/ponds/cages) at create/edit time.
 */
export function useSensors(): UseSensorsResult {
  const { data, isLoading } = useTenantQuery<SensorsResponse>(
    ['sensors', 'list'],
    async (): Promise<SensorsResponse> => {
      const result = await graphqlClient.request<{ sensors: SensorsResponse }>(SENSORS_QUERY, {
        pagination: { page: 1, limit: 100 },
      });
      return result.sensors;
    },
    { staleTime: 30000 },
  );

  return {
    sensors: data?.items ?? [],
    isLoading,
  };
}
