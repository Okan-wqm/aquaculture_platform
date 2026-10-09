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

export interface FarmSensor {
  id: string;
  name: string;
  type: string;
  serialNumber?: string;
  registrationStatus?: string;
  siteId: string | null;
}

/** Narrows the list to one site's sensors (the binding dialog picks among the point's site). */
export interface SensorListFilter {
  siteId?: string;
}

interface SensorsResponse {
  items: FarmSensor[];
  total: number;
}

// Federated `sensors` query (sensor-service). SensorPaginationInput = page/limit
// with limit capped at 100 by the backend; limit:100 fetches the full sensor
// list for the picker in a single request.
const SENSORS_QUERY = `
  query Sensors($filter: SensorFilterInput, $pagination: SensorPaginationInput) {
    sensors(filter: $filter, pagination: $pagination) {
      items {
        id
        name
        type
        serialNumber
        registrationStatus
        siteId
      }
      total
    }
  }
`;

interface UseSensorsResult {
  sensors: FarmSensor[];
  isLoading: boolean;
}

/**
 * Hook to fetch the tenant's registered sensors — all of them for linking to
 * equipment (tanks/ponds/cages) at create/edit time, or one site's for the
 * water-chemistry channel binding.
 */
export function useSensors(filter: SensorListFilter = {}): UseSensorsResult {
  const { data, isLoading } = useTenantQuery<SensorsResponse>(
    ['sensors', 'list', filter],
    async (): Promise<SensorsResponse> => {
      const result = await graphqlClient.request<{ sensors: SensorsResponse }>(SENSORS_QUERY, {
        filter,
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
