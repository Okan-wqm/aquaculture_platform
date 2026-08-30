import { useCallback, useEffect, useState } from 'react';

import { graphqlFetch } from '../config/api';
import { ParameterCatalog, SensorParameterCatalogEntry } from '../types/registration.types';

/**
 * SENSOR-MEDIUM-065: fetch the aquaculture parameter catalog from the backend SSoT
 * (`sensorParameterCatalog` query) so the registration wizard prefills discovered
 * channels with the SAME units/ranges the backend uses — no more hardcoded FE map.
 *
 * Uses the module's raw graphqlFetch (no client-side cache): the catalog is global
 * reference data, so there is no cross-tenant cache-leak surface to guard.
 */
const GET_PARAMETER_CATALOG_QUERY = `
  query GetSensorParameterCatalog {
    sensorParameterCatalog {
      key
      sensorType
      label
      unit
      min
      max
    }
  }
`;

interface UseSensorParameterCatalogResult {
  catalog: ParameterCatalog;
  loading: boolean;
  error: Error | null;
}

export function useSensorParameterCatalog(): UseSensorParameterCatalogResult {
  const [catalog, setCatalog] = useState<ParameterCatalog>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await graphqlFetch<{ sensorParameterCatalog: SensorParameterCatalogEntry[] }>(
        GET_PARAMETER_CATALOG_QUERY,
      );
      const map: ParameterCatalog = {};
      for (const entry of data.sensorParameterCatalog) {
        map[entry.key] = entry;
      }
      setCatalog(map);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { catalog, loading, error };
}
