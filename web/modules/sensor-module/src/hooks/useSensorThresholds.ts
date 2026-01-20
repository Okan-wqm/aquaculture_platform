/**
 * Hook for fetching and managing sensor thresholds
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSensorList, RegisteredSensor } from './useSensorList';

// API base URL
const API_URL = 'http://localhost:3000/graphql';

// ============================================================================
// Types
// ============================================================================

export interface AlertThresholds {
  warning?: { low?: number; high?: number };
  critical?: { low?: number; high?: number };
  hysteresis?: number;
}

export interface SensorThreshold {
  sensorId: string;
  sensorName: string;
  sensorType: string;
  unit: string;
  minValue?: number;
  maxValue?: number;
  alertThresholds: AlertThresholds;
  isParentDevice: boolean;
  parentId?: string;
  dataPath?: string;
}

export interface ThresholdUpdateInput {
  sensorId: string;
  alertThresholds: AlertThresholds;
}

// ============================================================================
// GraphQL Queries and Mutations
// ============================================================================

const UPDATE_DATA_CHANNEL_MUTATION = `
  mutation UpdateDataChannel($input: UpdateDataChannelInput!) {
    updateDataChannel(input: $input) {
      id
      alertThresholds {
        warning {
          low
          high
        }
        critical {
          low
          high
        }
        hysteresis
      }
    }
  }
`;

// ============================================================================
// GraphQL fetch helper
// ============================================================================

async function graphqlFetch<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const token = localStorage.getItem('access_token');
  const tenantId = localStorage.getItem('tenant_id');

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL Error');
  }

  return result.data;
}

// ============================================================================
// Default thresholds by sensor type
// ============================================================================

const DEFAULT_THRESHOLDS: Record<string, { unit: string; min: number; max: number; thresholds: AlertThresholds }> = {
  temperature: {
    unit: '°C',
    min: 0,
    max: 40,
    thresholds: {
      warning: { low: 18, high: 28 },
      critical: { low: 15, high: 32 },
    },
  },
  ph: {
    unit: 'pH',
    min: 0,
    max: 14,
    thresholds: {
      warning: { low: 6.5, high: 8.5 },
      critical: { low: 6.0, high: 9.0 },
    },
  },
  dissolved_oxygen: {
    unit: 'mg/L',
    min: 0,
    max: 20,
    thresholds: {
      warning: { low: 5, high: 12 },
      critical: { low: 3, high: 15 },
    },
  },
  salinity: {
    unit: 'ppt',
    min: 0,
    max: 50,
    thresholds: {
      warning: { low: 25, high: 38 },
      critical: { low: 20, high: 42 },
    },
  },
  ammonia: {
    unit: 'mg/L',
    min: 0,
    max: 5,
    thresholds: {
      warning: { high: 0.5 },
      critical: { high: 1.0 },
    },
  },
  nitrite: {
    unit: 'mg/L',
    min: 0,
    max: 5,
    thresholds: {
      warning: { high: 0.3 },
      critical: { high: 0.5 },
    },
  },
  nitrate: {
    unit: 'mg/L',
    min: 0,
    max: 100,
    thresholds: {
      warning: { high: 50 },
      critical: { high: 80 },
    },
  },
  turbidity: {
    unit: 'NTU',
    min: 0,
    max: 100,
    thresholds: {
      warning: { high: 20 },
      critical: { high: 50 },
    },
  },
  water_level: {
    unit: '%',
    min: 0,
    max: 100,
    thresholds: {
      warning: { low: 20, high: 90 },
      critical: { low: 10, high: 95 },
    },
  },
};

function getDefaultsForType(type: string | undefined): { unit: string; min: number; max: number; thresholds: AlertThresholds } {
  const normalized = type?.toLowerCase().replace(/-/g, '_') || 'other';
  return DEFAULT_THRESHOLDS[normalized] || {
    unit: '',
    min: 0,
    max: 100,
    thresholds: {},
  };
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useSensorThresholds() {
  const { sensors, loading: sensorsLoading, error: sensorsError, refetch } = useSensorList();
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  // Transform sensors to threshold data
  const thresholds = useMemo(() => {
    if (!sensors) return [];

    // Only show child sensors (data channels) - not parent devices
    return sensors
      .filter((s) => !s.isParentDevice)
      .map((sensor): SensorThreshold => {
        const defaults = getDefaultsForType(sensor.type);

        // Parse alertThresholds if it exists
        let alertThresholds: AlertThresholds = {};
        if (sensor.alertThresholds) {
          alertThresholds = sensor.alertThresholds as AlertThresholds;
        } else {
          alertThresholds = defaults.thresholds;
        }

        return {
          sensorId: sensor.id,
          sensorName: sensor.name,
          sensorType: sensor.type || 'OTHER',
          unit: sensor.unit || defaults.unit,
          minValue: defaults.min,
          maxValue: defaults.max,
          alertThresholds,
          isParentDevice: sensor.isParentDevice || false,
          parentId: sensor.parentId,
          dataPath: sensor.dataPath,
        };
      });
  }, [sensors]);

  // Group thresholds by sensor type
  const groupedByType = useMemo(() => {
    const groups: Record<string, SensorThreshold[]> = {};

    thresholds.forEach((threshold) => {
      const type = threshold.sensorType.toLowerCase().replace(/-/g, '_');
      if (!groups[type]) {
        groups[type] = [];
      }
      groups[type].push(threshold);
    });

    return groups;
  }, [thresholds]);

  // Update threshold for a sensor
  const updateThreshold = useCallback(async (input: ThresholdUpdateInput) => {
    setUpdating(true);
    setUpdateError(null);

    try {
      await graphqlFetch(UPDATE_DATA_CHANNEL_MUTATION, {
        input: {
          channelId: input.sensorId,
          alertThresholds: input.alertThresholds,
        },
      });

      // Refetch to get updated data
      await refetch();
    } catch (error) {
      setUpdateError((error as Error).message);
      throw error;
    } finally {
      setUpdating(false);
    }
  }, [refetch]);

  // Bulk update thresholds
  const updateThresholdsBulk = useCallback(async (inputs: ThresholdUpdateInput[]) => {
    setUpdating(true);
    setUpdateError(null);

    try {
      await Promise.all(
        inputs.map((input) =>
          graphqlFetch(UPDATE_DATA_CHANNEL_MUTATION, {
            input: {
              channelId: input.sensorId,
              alertThresholds: input.alertThresholds,
            },
          })
        )
      );

      await refetch();
    } catch (error) {
      setUpdateError((error as Error).message);
      throw error;
    } finally {
      setUpdating(false);
    }
  }, [refetch]);

  return {
    thresholds,
    groupedByType,
    loading: sensorsLoading,
    error: sensorsError,
    updating,
    updateError,
    updateThreshold,
    updateThresholdsBulk,
    refetch,
  };
}

// Type labels for display
export const SENSOR_TYPE_LABELS: Record<string, string> = {
  temperature: 'Sıcaklık',
  ph: 'pH',
  dissolved_oxygen: 'Çözünmüş Oksijen',
  salinity: 'Tuzluluk',
  ammonia: 'Amonyak',
  nitrite: 'Nitrit',
  nitrate: 'Nitrat',
  turbidity: 'Bulanıklık',
  water_level: 'Su Seviyesi',
  flow_rate: 'Akış Hızı',
  pressure: 'Basınç',
  humidity: 'Nem',
  other: 'Diğer',
};

export function getSensorTypeLabel(type: string): string {
  const normalized = type.toLowerCase().replace(/-/g, '_');
  return SENSOR_TYPE_LABELS[normalized] || type;
}
