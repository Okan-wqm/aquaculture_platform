import { useCallback, useEffect, useState } from 'react';

import { graphqlFetch } from '../config/api';

/**
 * A tenant-extensible sensor type definition (SensorTypeDefinition on the backend).
 * SENSOR-MEDIUM-071: harvested from the now-deleted BasicInfoStep so the live
 * parent-child wizard can offer custom types when configuring a child sensor.
 */
export interface SensorTypeDefinitionOption {
  id: string;
  typeKey: string;
  displayName: string;
  category: string | null;
  icon: string | null;
  isSystem: boolean;
}

const GET_SENSOR_TYPES_QUERY = `
  query GetSensorTypes {
    sensorTypes {
      id
      typeKey
      displayName
      category
      icon
      isSystem
    }
  }
`;

interface UseSensorTypeDefinitionsResult {
  types: SensorTypeDefinitionOption[];
  loading: boolean;
  error: Error | null;
}

/**
 * Fetch the tenant's (and system) sensor type definitions for a type picker.
 *
 * Uses the module's raw graphqlFetch (no client-side cache), so there is no
 * cross-tenant cache-leak surface to guard — the tenant is resolved server-side
 * from the request identity.
 */
export function useSensorTypeDefinitions(): UseSensorTypeDefinitionsResult {
  const [types, setTypes] = useState<SensorTypeDefinitionOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await graphqlFetch<{ sensorTypes: SensorTypeDefinitionOption[] }>(
        GET_SENSOR_TYPES_QUERY,
      );
      setTypes(data.sensorTypes);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { types, loading, error };
}
