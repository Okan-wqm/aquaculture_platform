import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@aquaculture/shared-ui';
import { graphqlFetch } from '../config/api';

// Types
export interface SensorConnectionStatus {
  isConnected: boolean;
  lastTestedAt?: string;
  lastError?: string;
  latency?: number;
}

export interface RegisteredSensor {
  id: string;
  name: string;
  type: string;
  protocolCode: string;
  protocolConfiguration: Record<string, unknown>;
  connectionStatus?: SensorConnectionStatus;
  registrationStatus: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  description?: string;
  farmId?: string;
  pondId?: string;
  tankId?: string;
  location?: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  // Parent-child fields
  parentId?: string;
  isParentDevice?: boolean;
  dataPath?: string;
  sensorRole?: 'parent' | 'child';
  unit?: string;
  siteId?: string;
  alertThresholds?: Record<string, unknown>;
}

export interface SensorFilter {
  type?: string;
  protocolCode?: string;
  registrationStatus?: string;
  farmId?: string;
  pondId?: string;
  tankId?: string;
  search?: string;
}

export interface Pagination {
  page: number;
  limit: number;
}

export interface SensorListResult {
  items: RegisteredSensor[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// GraphQL Query - Uses the sensors query from registration.resolver.ts
// Returns SensorListType with pagination input object
// SCHEMA-CONTRACT: Sensor-service uses SensorPaginationInput (page/limit)
const GET_SENSORS_QUERY = `
  query GetSensors($pagination: SensorPaginationInput) {
    sensors(pagination: $pagination) {
      items {
        id
        name
        type
        protocolCode
        protocolConfiguration
        connectionStatus {
          isConnected
          lastTestedAt
          lastError
          latency
        }
        registrationStatus
        manufacturer
        model
        serialNumber
        description
        farmId
        pondId
        tankId
        location
        tenantId
        createdAt
        updatedAt
        parentId
        isParentDevice
        dataPath
        sensorRole
      }
      total
      page
      limit
      totalPages
    }
  }
`;

// Hook for fetching sensor list
export function useSensorList(filter?: SensorFilter, pagination?: Pagination) {
  const { token, tenantId } = useAuth();
  const [data, setData] = useState<SensorListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSensors = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // BUG-020: include filter in variables so server-side filtering is actually applied
      const result = await graphqlFetch<{ sensors: SensorListResult }>(GET_SENSORS_QUERY, {
        // Note: Only pass 'page' because federation schema doesn't have 'limit' (conflict with farm-service)
        ...(filter ? { filter } : {}),
        pagination: {
          page: pagination?.page || 1,
        },
      });

      setData(result.sensors);
    } catch (err) {
      setError((err as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [filter, pagination]);

  useEffect(() => {
    // AUTH-READINESS GATE: do not query before tenant context (token + tenantId)
    // is ready, otherwise the mount fetch races the auth lifecycle and queries
    // with a null tenant (401/empty). Re-runs when the tenant becomes ready/changes.
    if (!token || !tenantId) {
      setData(null);
      setLoading(false);
      return;
    }
    fetchSensors();
  }, [fetchSensors, token, tenantId]);

  const refetch = useCallback(() => {
    fetchSensors();
  }, [fetchSensors]);

  return {
    data,
    sensors: data?.items || [],
    total: data?.total || 0,
    loading,
    error,
    refetch,
  };
}

// Hook for fetching sensors by type/category
export function useSensorsByCategory() {
  const { sensors, loading, error, refetch } = useSensorList();

  // Group sensors by type
  const sensorsByType = sensors.reduce((acc, sensor) => {
    const type = sensor.type || 'unknown';
    if (!acc[type]) {
      acc[type] = [];
    }
    acc[type].push(sensor);
    return acc;
  }, {} as Record<string, RegisteredSensor[]>);

  // Category mappings
  const categoryMap: Record<string, string[]> = {
    'water_quality': ['PH', 'DISSOLVED_OXYGEN', 'TEMPERATURE', 'SALINITY', 'TURBIDITY', 'AMMONIA', 'NITRATE', 'NITRITE'],
    'energy': ['VOLTAGE', 'CURRENT', 'POWER', 'ENERGY', 'FREQUENCY'],
    'environment': ['AIR_TEMPERATURE', 'HUMIDITY', 'PRESSURE', 'LIGHT', 'UV', 'WIND'],
    'flow': ['FLOW_RATE', 'WATER_LEVEL', 'PRESSURE'],
    'feeding': ['FEED_AMOUNT', 'FEED_RATE'],
  };

  // Group by category
  const sensorsByCategory = Object.entries(categoryMap).reduce((acc, [category, types]) => {
    acc[category] = sensors.filter(s => types.includes(s.type?.toUpperCase()));
    return acc;
  }, {} as Record<string, RegisteredSensor[]>);

  // Get uncategorized sensors
  const categorizedTypes = Object.values(categoryMap).flat();
  sensorsByCategory['other'] = sensors.filter(s => !categorizedTypes.includes(s.type?.toUpperCase()));

  return {
    sensors,
    sensorsByType,
    sensorsByCategory,
    loading,
    error,
    refetch,
  };
}

// Simple hook for getting sensor count stats
export function useSensorStats() {
  const { sensors, loading, error } = useSensorList();

  const stats = {
    total: sensors.length,
    online: sensors.filter(s => s.connectionStatus?.isConnected).length,
    offline: sensors.filter(s => !s.connectionStatus?.isConnected).length,
    byType: sensors.reduce((acc, s) => {
      const type = s.type || 'unknown';
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    byProtocol: sensors.reduce((acc, s) => {
      const protocol = s.protocolCode || 'unknown';
      acc[protocol] = (acc[protocol] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };

  return {
    stats,
    loading,
    error,
  };
}
