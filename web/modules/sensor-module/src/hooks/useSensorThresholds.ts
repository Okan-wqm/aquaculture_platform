/**
 * Hook for fetching and managing sensor thresholds
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSensorList, RegisteredSensor } from './useSensorList';
import { graphqlFetch } from '../config/api';

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

/**
 * PERF-RISK-004: Single bulk mutation replaces N individual updateDataChannel calls.
 * Executes all threshold updates in one atomic transaction on the backend.
 * Maximum 100 items per request.
 */
const BULK_UPDATE_DATA_CHANNELS_MUTATION = `
  mutation BulkUpdateDataChannels($input: BulkUpdateDataChannelsInput!) {
    bulkUpdateDataChannels(input: $input) {
      success
      count
    }
  }
`;

const BULK_UPDATE_MAX_ITEMS = 100;

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

  // PERF-RISK-004: Bulk update thresholds via single atomic mutation.
  // Previously used Promise.all with N separate mutations; now sends
  // one bulkUpdateDataChannels call with all updates in a single transaction.
  const updateThresholdsBulk = useCallback(async (inputs: ThresholdUpdateInput[]) => {
    if (inputs.length === 0) return;

    if (inputs.length > BULK_UPDATE_MAX_ITEMS) {
      throw new Error(
        `Bulk update limited to ${BULK_UPDATE_MAX_ITEMS} items, received ${inputs.length}`,
      );
    }

    setUpdating(true);
    setUpdateError(null);

    try {
      await graphqlFetch(BULK_UPDATE_DATA_CHANNELS_MUTATION, {
        input: {
          updates: inputs.map((input) => ({
            channelId: input.sensorId,
            alertThresholds: input.alertThresholds,
          })),
        },
      });

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
