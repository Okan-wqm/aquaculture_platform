/**
 * Widget Data Hook
 *
 * Fetches sensor readings for dashboard widgets with real-time WebSocket updates.
 * Uses WebSocket for live data, GraphQL for initial load and history.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { WidgetConfig, TimeRange, SensorMetric, SENSOR_METRICS, SelectedChannel } from '../components/dashboard/types';
import { useSensorSocket, SensorReading as SocketSensorReading } from './useSensorSocket';

// API base URL
const API_URL = 'http://localhost:3000/graphql';

// ============================================================================
// Types
// ============================================================================

export interface SensorReadings {
  temperature?: number;
  ph?: number;
  dissolvedOxygen?: number;
  salinity?: number;
  ammonia?: number;
  nitrite?: number;
  nitrate?: number;
  turbidity?: number;
  waterLevel?: number;
}

export interface RawSensorReading {
  id: string;
  sensorId: string;
  tenantId: string;
  timestamp: string;
  readings: SensorReadings;
  pondId?: string;
  farmId?: string;
  quality?: number;
  source?: string;
}

export interface WidgetDataPoint {
  sensorId: string;
  sensorName: string;
  value: number;
  unit: string;
  timestamp: Date;
  status: 'normal' | 'warning' | 'critical' | 'offline';
  minValue?: number;
  maxValue?: number;
}

export interface HistoryPoint {
  sensorId: string;
  sensorName: string;
  channelKey?: string;
  channelLabel?: string;
  value: number;
  unit?: string;
  timestamp: Date;
}

export interface AggregatedDataPoint {
  bucket: string;
  count: number;
  avgTemperature?: number;
  minTemperature?: number;
  maxTemperature?: number;
  avgPh?: number;
  minPh?: number;
  maxPh?: number;
  avgDissolvedOxygen?: number;
  minDissolvedOxygen?: number;
  maxDissolvedOxygen?: number;
  avgSalinity?: number;
  avgAmmonia?: number;
  avgNitrite?: number;
  avgNitrate?: number;
  avgTurbidity?: number;
  avgWaterLevel?: number;
}

export interface AggregatedReadingsResponse {
  sensorId: string;
  sensorName?: string;
  interval: string;
  startTime: string;
  endTime: string;
  totalDataPoints: number;
  data: AggregatedDataPoint[];
}

export interface WidgetDataResult {
  data: WidgetDataPoint[];
  history: HistoryPoint[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

// ============================================================================
// GraphQL Queries
// ============================================================================

const GET_LATEST_READINGS_QUERY = `
  query GetLatestReadings($sensorIds: [ID!]!) {
    latestReadingsBatch(sensorIds: $sensorIds) {
      id
      sensorId
      tenantId
      timestamp
      readings {
        temperature
        ph
        dissolvedOxygen
        salinity
        ammonia
        nitrite
        nitrate
        turbidity
        waterLevel
      }
      quality
      source
    }
  }
`;

const GET_READINGS_HISTORY_QUERY = `
  query GetReadingsHistory($sensorId: ID!, $startTime: DateTime!, $endTime: DateTime!, $limit: Int) {
    readings(sensorId: $sensorId, startTime: $startTime, endTime: $endTime, limit: $limit) {
      id
      sensorId
      timestamp
      readings {
        temperature
        ph
        dissolvedOxygen
        salinity
        ammonia
        nitrite
        nitrate
        turbidity
        waterLevel
      }
    }
  }
`;

/**
 * Aggregated readings query - uses TimescaleDB time_bucket for efficient aggregation
 * Auto-selects optimal interval based on time range if not specified
 */
const GET_AGGREGATED_READINGS_QUERY = `
  query GetAggregatedReadings($sensorId: ID!, $startTime: DateTime!, $endTime: DateTime!, $interval: AggregationInterval) {
    aggregatedReadings(sensorId: $sensorId, startTime: $startTime, endTime: $endTime, interval: $interval) {
      sensorId
      sensorName
      interval
      startTime
      endTime
      totalDataPoints
      data {
        bucket
        count
        avgTemperature
        minTemperature
        maxTemperature
        avgPh
        minPh
        maxPh
        avgDissolvedOxygen
        minDissolvedOxygen
        maxDissolvedOxygen
        avgSalinity
        minSalinity
        maxSalinity
        avgAmmonia
        avgNitrite
        avgNitrate
        avgTurbidity
        avgWaterLevel
      }
    }
  }
`;

const GET_SENSOR_INFO_QUERY = `
  query GetSensorInfo($id: ID!) {
    sensor(id: $id) {
      id
      name
      type
      alertThresholds
    }
  }
`;

// ============================================================================
// Utilities
// ============================================================================

// Time range to milliseconds
function getTimeRangeMs(timeRange: TimeRange): number {
  const ranges: Record<TimeRange, number> = {
    live: 5 * 60 * 1000, // 5 minutes for live
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  return ranges[timeRange] || ranges['1h'];
}

// Extract value from readings based on selected metric
function extractValueByMetric(
  readings: SensorReadings,
  metric?: SensorMetric
): { value: number; unit: string; metric: SensorMetric } | null {
  // If metric specified, get that specific value
  if (metric) {
    const value = readings[metric];
    if (value !== undefined && value !== null) {
      const metricInfo = SENSOR_METRICS.find(m => m.value === metric);
      return { value, unit: metricInfo?.unit || '', metric };
    }
    return null; // Metric requested but not available in readings
  }

  // Fallback: return first available value (for backward compatibility)
  for (const metricInfo of SENSOR_METRICS) {
    const value = readings[metricInfo.value];
    if (value !== undefined && value !== null) {
      return { value, unit: metricInfo.unit, metric: metricInfo.value };
    }
  }

  return null;
}

// Map SensorMetric to aggregated data field name
const METRIC_TO_AGGREGATED_FIELD: Record<SensorMetric, keyof AggregatedDataPoint> = {
  temperature: 'avgTemperature',
  ph: 'avgPh',
  dissolvedOxygen: 'avgDissolvedOxygen',
  salinity: 'avgSalinity',
  ammonia: 'avgAmmonia',
  nitrite: 'avgNitrite',
  nitrate: 'avgNitrate',
  turbidity: 'avgTurbidity',
  waterLevel: 'avgWaterLevel',
};

// Map channel key to aggregated data field name (more flexible than SensorMetric)
const CHANNEL_KEY_TO_AGGREGATED_FIELD: Record<string, keyof AggregatedDataPoint> = {
  temperature: 'avgTemperature',
  ph: 'avgPh',
  dissolvedOxygen: 'avgDissolvedOxygen',
  dissolved_oxygen: 'avgDissolvedOxygen',
  salinity: 'avgSalinity',
  ammonia: 'avgAmmonia',
  nitrite: 'avgNitrite',
  nitrate: 'avgNitrate',
  turbidity: 'avgTurbidity',
  waterLevel: 'avgWaterLevel',
  water_level: 'avgWaterLevel',
};

// Extract value from aggregated data by channel key
function extractAggregatedValueByChannelKey(
  dataPoint: AggregatedDataPoint,
  channelKey: string
): number | null {
  const fieldName = CHANNEL_KEY_TO_AGGREGATED_FIELD[channelKey];
  if (fieldName) {
    const value = dataPoint[fieldName];
    if (value !== undefined && value !== null) {
      return value as number;
    }
  }

  // Try direct match with readings field name pattern
  const avgKey = `avg${channelKey.charAt(0).toUpperCase()}${channelKey.slice(1)}` as keyof AggregatedDataPoint;
  const value = dataPoint[avgKey];
  if (value !== undefined && value !== null) {
    return value as number;
  }

  return null;
}

// Extract value from raw readings by channel key
function extractRawValueByChannelKey(
  readings: SensorReadings,
  channelKey: string
): number | null {
  // Direct access if key matches
  const value = readings[channelKey as keyof SensorReadings];
  if (value !== undefined && value !== null) {
    return value;
  }

  // Handle underscore vs camelCase variations
  const camelKey = channelKey.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const camelValue = readings[camelKey as keyof SensorReadings];
  if (camelValue !== undefined && camelValue !== null) {
    return camelValue;
  }

  return null;
}

// Extract value from aggregated data point based on selected metric
function extractAggregatedValue(
  dataPoint: AggregatedDataPoint,
  metric?: SensorMetric
): number | null {
  // If metric specified, get that specific aggregated value
  if (metric) {
    const fieldName = METRIC_TO_AGGREGATED_FIELD[metric];
    const value = dataPoint[fieldName];
    if (value !== undefined && value !== null) {
      return value as number;
    }
    return null; // Metric requested but not available
  }

  // Fallback: return first available aggregated value (for backward compatibility)
  for (const metricInfo of SENSOR_METRICS) {
    const fieldName = METRIC_TO_AGGREGATED_FIELD[metricInfo.value];
    const value = dataPoint[fieldName];
    if (value !== undefined && value !== null) {
      return value as number;
    }
  }

  return null;
}

// Determine status based on thresholds
function determineStatus(
  value: number,
  thresholds?: {
    warningLow?: number;
    warningHigh?: number;
    criticalLow?: number;
    criticalHigh?: number;
  }
): 'normal' | 'warning' | 'critical' | 'offline' {
  if (!thresholds) return 'normal';

  const { warningLow, warningHigh, criticalLow, criticalHigh } = thresholds;

  if (
    (criticalLow !== undefined && value < criticalLow) ||
    (criticalHigh !== undefined && value > criticalHigh)
  ) {
    return 'critical';
  }

  if (
    (warningLow !== undefined && value < warningLow) ||
    (warningHigh !== undefined && value > warningHigh)
  ) {
    return 'warning';
  }

  return 'normal';
}

// GraphQL fetch helper
async function graphqlFetch<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const token = localStorage.getItem('access_token');
  const tenantId = localStorage.getItem('tenant_id');

  console.log('[graphqlFetch] Auth:', {
    hasToken: !!token,
    tokenPreview: token ? token.substring(0, 20) + '...' : null,
    tenantId
  });

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
  console.log('[graphqlFetch] Response status:', response.status);

  if (result.errors) {
    console.error('[graphqlFetch] GraphQL errors:', result.errors);
    throw new Error(result.errors[0]?.message || 'GraphQL Error');
  }

  return result.data;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useWidgetData(config: WidgetConfig): WidgetDataResult {
  const [data, setData] = useState<WidgetDataPoint[]>([]);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const isInitialLoadRef = useRef(true); // Track if this is the first load
  const sensorInfoCache = useRef<Map<string, { name: string; type: string; thresholds?: Record<string, unknown> }>>(
    new Map()
  );
  // Bug #1 fix: Queue for WebSocket readings that arrive before initial data load
  const pendingReadingsRef = useRef<Map<string, SocketSensorReading>>(new Map());

  // Extract unique sensor IDs for WebSocket subscription
  const sensorIds = useMemo(() => {
    const ids = new Set<string>();

    if (config.selectedChannels && config.selectedChannels.length > 0) {
      config.selectedChannels.forEach((ch) => ids.add(ch.sensorId));
    } else if (config.sensorIds && config.sensorIds.length > 0) {
      config.sensorIds.forEach((id) => ids.add(id));
    }

    return Array.from(ids);
  }, [config.selectedChannels, config.sensorIds]);

  // Subscribe to WebSocket for real-time updates
  const { isConnected, readings: socketReadings, getLatestReading } = useSensorSocket(sensorIds);

  // Update data when WebSocket receives new readings
  // Bug #1 & #2 fix: Handle race conditions and multi-channel extraction
  useEffect(() => {
    if (socketReadings.size === 0) return;

    console.log('[useWidgetData] WebSocket readings updated:', socketReadings.size, 'sensors');

    // Bug #1 fix: If still loading initial data, queue readings for later
    if (loading) {
      console.log('[useWidgetData] Still loading, queueing WebSocket readings');
      for (const [sensorId, reading] of socketReadings) {
        pendingReadingsRef.current.set(sensorId, reading);
      }
      return;
    }

    setData((prevData) => {
      const newData = [...prevData];
      let hasChanges = false;

      for (const [sensorId, reading] of socketReadings) {
        if (!reading.readings) continue;

        // Bug #2 fix: Get ALL channels from this sensor, not just the first one
        const channelsFromSensor = config.selectedChannels?.filter(
          (ch) => ch.sensorId === sensorId
        ) || [];

        if (channelsFromSensor.length > 0) {
          // Process each channel from this sensor
          for (const channel of channelsFromSensor) {
            const newValue = reading.readings[channel.channelKey];
            if (newValue === undefined) continue;

            // Find existing data point for this channel
            const dataIndex = newData.findIndex((d) => d.sensorId === channel.id);

            if (dataIndex >= 0) {
              // Update existing data point
              const existingPoint = newData[dataIndex];
              if (newValue !== existingPoint.value) {
                newData[dataIndex] = {
                  ...existingPoint,
                  value: newValue,
                  timestamp: new Date(reading.timestamp),
                };
                hasChanges = true;
              }
            } else {
              // Add new data point for this channel
              newData.push({
                sensorId: channel.id,
                sensorName: `${channel.sensorName} - ${channel.displayLabel}`,
                value: newValue,
                unit: channel.unit || '',
                timestamp: new Date(reading.timestamp),
                status: 'normal',
                minValue: 0,
                maxValue: 100,
              });
              hasChanges = true;
            }
          }
        } else {
          // Legacy mode: use sensorId + metric
          const channelKey = config.metric || 'temperature';
          const value = reading.readings[channelKey];

          if (value !== undefined) {
            const dataIndex = newData.findIndex((d) => d.sensorId === sensorId);

            if (dataIndex >= 0) {
              const existingPoint = newData[dataIndex];
              if (value !== existingPoint.value) {
                newData[dataIndex] = {
                  ...existingPoint,
                  value,
                  timestamp: new Date(reading.timestamp),
                };
                hasChanges = true;
              }
            } else {
              newData.push({
                sensorId,
                sensorName: reading.sensorName || `Sensor ${sensorId.slice(0, 8)}`,
                value,
                unit: '',
                timestamp: new Date(reading.timestamp),
                status: 'normal',
                minValue: 0,
                maxValue: 100,
              });
              hasChanges = true;
            }
          }
        }
      }

      return hasChanges ? newData : prevData;
    });
  }, [socketReadings, config.selectedChannels, config.metric, loading]);

  // Bug #1 fix: Process pending WebSocket readings after initial load completes
  useEffect(() => {
    if (loading || pendingReadingsRef.current.size === 0) return;

    console.log('[useWidgetData] Processing', pendingReadingsRef.current.size, 'pending WebSocket readings');

    // Re-trigger the WebSocket handler by updating data with pending readings
    setData((prevData) => {
      const newData = [...prevData];
      let hasChanges = false;

      for (const [sensorId, reading] of pendingReadingsRef.current) {
        if (!reading.readings) continue;

        const channelsFromSensor = config.selectedChannels?.filter(
          (ch) => ch.sensorId === sensorId
        ) || [];

        if (channelsFromSensor.length > 0) {
          for (const channel of channelsFromSensor) {
            const newValue = reading.readings[channel.channelKey];
            if (newValue === undefined) continue;

            const dataIndex = newData.findIndex((d) => d.sensorId === channel.id);
            if (dataIndex >= 0) {
              const existingPoint = newData[dataIndex];
              // Only update if WebSocket data is newer
              if (new Date(reading.timestamp) > existingPoint.timestamp) {
                newData[dataIndex] = {
                  ...existingPoint,
                  value: newValue,
                  timestamp: new Date(reading.timestamp),
                };
                hasChanges = true;
              }
            }
          }
        }
      }

      // Clear pending readings after processing
      pendingReadingsRef.current.clear();
      return hasChanges ? newData : prevData;
    });
  }, [loading, config.selectedChannels]);

  // Fetch sensor info (cached)
  const fetchSensorInfo = useCallback(async (sensorId: string) => {
    if (sensorInfoCache.current.has(sensorId)) {
      return sensorInfoCache.current.get(sensorId)!;
    }

    try {
      const result = await graphqlFetch<{
        sensor: { id: string; name: string; type: string; alertThresholds?: Record<string, unknown> };
      }>(GET_SENSOR_INFO_QUERY, { id: sensorId });

      const info = {
        name: result.sensor.name,
        type: result.sensor.type,
        thresholds: result.sensor.alertThresholds,
      };
      sensorInfoCache.current.set(sensorId, info);
      return info;
    } catch {
      // Fallback if sensor info not available
      return { name: `Sensor ${sensorId.slice(0, 8)}`, type: 'UNKNOWN' };
    }
  }, []);

  // Fetch latest readings
  const fetchLatestReadings = useCallback(async () => {
    // Determine data source: new selectedChannels or legacy sensorIds
    const hasSelectedChannels = config.selectedChannels && config.selectedChannels.length > 0;
    const hasSensorIds = config.sensorIds && config.sensorIds.length > 0;

    console.log('[useWidgetData] Fetching for widget:', config.id, {
      hasSelectedChannels,
      hasSensorIds,
      selectedChannels: config.selectedChannels,
      sensorIds: config.sensorIds,
    });

    if (!hasSelectedChannels && !hasSensorIds) {
      console.warn('[useWidgetData] No channels or sensors configured');
      setData([]);
      setLoading(false);
      return;
    }

    try {
      const readings: WidgetDataPoint[] = [];

      if (hasSelectedChannels) {
        // New approach: fetch by selected channels
        // Group channels by sensorId
        const channelsBySensor = new Map<string, SelectedChannel[]>();
        for (const ch of config.selectedChannels!) {
          if (!channelsBySensor.has(ch.sensorId)) {
            channelsBySensor.set(ch.sensorId, []);
          }
          channelsBySensor.get(ch.sensorId)!.push(ch);
        }

        for (const [sensorId, channels] of channelsBySensor) {
          try {
            const endTime = new Date();
            // Use 7 days window to find latest reading (in case sensor data is old)
            const startTime = new Date(endTime.getTime() - 7 * 24 * 60 * 60 * 1000);

            console.log('[useWidgetData] Fetching readings for sensor:', sensorId, 'from', startTime.toISOString(), 'to', endTime.toISOString());
            const result = await graphqlFetch<{ readings: RawSensorReading[] }>(
              GET_READINGS_HISTORY_QUERY,
              {
                sensorId,
                startTime: startTime.toISOString(),
                endTime: endTime.toISOString(),
                limit: 1,
              }
            );

            console.log('[useWidgetData] Readings result:', result);

            if (result.readings && result.readings.length > 0) {
              const rawReading = result.readings[0];
              console.log('[useWidgetData] Raw reading:', rawReading);

              for (const channel of channels) {
                const value = extractRawValueByChannelKey(rawReading.readings, channel.channelKey);
                console.log(`[useWidgetData] Channel ${channel.channelKey} value:`, value);
                if (value !== null) {
                  readings.push({
                    sensorId: channel.id, // Use channel ID as identifier
                    sensorName: `${channel.sensorName} - ${channel.displayLabel}`,
                    value,
                    unit: channel.unit || '',
                    timestamp: new Date(rawReading.timestamp),
                    status: 'normal', // TODO: Implement channel-based thresholds
                    minValue: 0,
                    maxValue: 100,
                  });
                }
              }
            } else {
              console.warn('[useWidgetData] No readings returned for sensor:', sensorId);
            }
          } catch (sensorError) {
            console.error(`[useWidgetData] Failed to fetch reading for sensor ${sensorId}:`, sensorError);
          }
        }
      } else {
        // Legacy approach: sensorIds + metric
        for (const sensorId of config.sensorIds!) {
          try {
            const sensorInfo = await fetchSensorInfo(sensorId);
            const endTime = new Date();
            // Use 7 days window to find latest reading
            const startTime = new Date(endTime.getTime() - 7 * 24 * 60 * 60 * 1000);

            const result = await graphqlFetch<{ readings: RawSensorReading[] }>(
              GET_READINGS_HISTORY_QUERY,
              {
                sensorId,
                startTime: startTime.toISOString(),
                endTime: endTime.toISOString(),
                limit: 1,
              }
            );

            if (result.readings && result.readings.length > 0) {
              const rawReading = result.readings[0];
              const extracted = extractValueByMetric(rawReading.readings, config.metric);

              if (extracted) {
                readings.push({
                  sensorId,
                  sensorName: sensorInfo.name,
                  value: extracted.value,
                  unit: extracted.unit,
                  timestamp: new Date(rawReading.timestamp),
                  status: determineStatus(extracted.value, sensorInfo.thresholds as {
                    warningLow?: number;
                    warningHigh?: number;
                    criticalLow?: number;
                    criticalHigh?: number;
                  }),
                  minValue: 0,
                  maxValue: 100,
                });
              }
            }
          } catch (sensorError) {
            console.warn(`Failed to fetch reading for sensor ${sensorId}:`, sensorError);
          }
        }
      }

      console.log('[useWidgetData] Final readings data:', readings);
      setData(readings);
      setError(null);
    } catch (err) {
      console.error('[useWidgetData] Error fetching readings:', err);
      setError((err as Error).message);
    }
  }, [config.selectedChannels, config.sensorIds, config.metric, fetchSensorInfo]);

  // Fetch history using aggregated data (efficient for large datasets)
  const fetchHistory = useCallback(async () => {
    // Determine data source: new selectedChannels or legacy sensorIds
    const hasSelectedChannels = config.selectedChannels && config.selectedChannels.length > 0;
    const hasSensorIds = config.sensorIds && config.sensorIds.length > 0;

    if (!hasSelectedChannels && !hasSensorIds) {
      setHistory([]);
      return;
    }

    try {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - getTimeRangeMs(config.timeRange));
      const allHistory: HistoryPoint[] = [];

      if (hasSelectedChannels) {
        // New approach: fetch by selected channels
        // Group channels by sensorId
        const channelsBySensor = new Map<string, SelectedChannel[]>();
        for (const ch of config.selectedChannels!) {
          if (!channelsBySensor.has(ch.sensorId)) {
            channelsBySensor.set(ch.sensorId, []);
          }
          channelsBySensor.get(ch.sensorId)!.push(ch);
        }

        for (const [sensorId, channels] of channelsBySensor) {
          try {
            // Use aggregated readings - backend auto-selects optimal interval
            const result = await graphqlFetch<{ aggregatedReadings: AggregatedReadingsResponse }>(
              GET_AGGREGATED_READINGS_QUERY,
              {
                sensorId,
                startTime: startTime.toISOString(),
                endTime: endTime.toISOString(),
              }
            );

            if (result.aggregatedReadings?.data) {
              for (const dataPoint of result.aggregatedReadings.data) {
                for (const channel of channels) {
                  const value = extractAggregatedValueByChannelKey(dataPoint, channel.channelKey);
                  if (value !== null) {
                    allHistory.push({
                      sensorId: channel.id, // Use channel ID
                      sensorName: channel.sensorName,
                      channelKey: channel.channelKey,
                      channelLabel: channel.displayLabel,
                      value,
                      unit: channel.unit,
                      timestamp: new Date(dataPoint.bucket),
                    });
                  }
                }
              }
            }
          } catch (sensorError) {
            console.warn(`Failed to fetch aggregated history for sensor ${sensorId}:`, sensorError);
            // Fallback to raw readings for each channel
            for (const channel of channels) {
              await fetchRawHistoryByChannel(sensorId, channel, startTime, endTime, allHistory);
            }
          }
        }
      } else {
        // Legacy approach: sensorIds + metric
        for (const sensorId of config.sensorIds!) {
          try {
            const sensorInfo = await fetchSensorInfo(sensorId);

            const result = await graphqlFetch<{ aggregatedReadings: AggregatedReadingsResponse }>(
              GET_AGGREGATED_READINGS_QUERY,
              {
                sensorId,
                startTime: startTime.toISOString(),
                endTime: endTime.toISOString(),
              }
            );

            if (result.aggregatedReadings?.data) {
              const sensorName = result.aggregatedReadings.sensorName || sensorInfo.name;

              for (const dataPoint of result.aggregatedReadings.data) {
                const value = extractAggregatedValue(dataPoint, config.metric);
                if (value !== null) {
                  allHistory.push({
                    sensorId,
                    sensorName,
                    value,
                    timestamp: new Date(dataPoint.bucket),
                  });
                }
              }
            }
          } catch (sensorError) {
            console.warn(`Failed to fetch aggregated history for sensor ${sensorId}:`, sensorError);
            await fetchRawHistory(sensorId, startTime, endTime, allHistory);
          }
        }
      }

      // Sort by timestamp
      allHistory.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      setHistory(allHistory);
    } catch (err) {
      console.error('Failed to fetch history:', err);
    }
  }, [config.selectedChannels, config.sensorIds, config.metric, config.timeRange, fetchSensorInfo]);

  // Fallback: fetch raw readings (for backward compatibility)
  const fetchRawHistory = useCallback(async (
    sensorId: string,
    startTime: Date,
    endTime: Date,
    allHistory: HistoryPoint[]
  ) => {
    try {
      const sensorInfo = await fetchSensorInfo(sensorId);

      const result = await graphqlFetch<{ readings: RawSensorReading[] }>(
        GET_READINGS_HISTORY_QUERY,
        {
          sensorId,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          limit: 100,
        }
      );

      if (result.readings) {
        for (const rawReading of result.readings) {
          // Use config.metric for extraction
          const extracted = extractValueByMetric(rawReading.readings, config.metric);
          if (extracted) {
            allHistory.push({
              sensorId,
              sensorName: sensorInfo.name,
              value: extracted.value,
              timestamp: new Date(rawReading.timestamp),
            });
          }
        }
      }
    } catch (error) {
      console.warn(`Fallback raw history also failed for ${sensorId}:`, error);
    }
  }, [config.metric, fetchSensorInfo]);

  // Fallback: fetch raw readings by channel
  const fetchRawHistoryByChannel = useCallback(async (
    sensorId: string,
    channel: SelectedChannel,
    startTime: Date,
    endTime: Date,
    allHistory: HistoryPoint[]
  ) => {
    try {
      const result = await graphqlFetch<{ readings: RawSensorReading[] }>(
        GET_READINGS_HISTORY_QUERY,
        {
          sensorId,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          limit: 100,
        }
      );

      if (result.readings) {
        for (const rawReading of result.readings) {
          const value = extractRawValueByChannelKey(rawReading.readings, channel.channelKey);
          if (value !== null) {
            allHistory.push({
              sensorId: channel.id,
              sensorName: channel.sensorName,
              channelKey: channel.channelKey,
              channelLabel: channel.displayLabel,
              value,
              unit: channel.unit,
              timestamp: new Date(rawReading.timestamp),
            });
          }
        }
      }
    } catch (error) {
      console.warn(`Fallback raw history by channel failed for ${channel.id}:`, error);
    }
  }, []);

  // Combined fetch function
  const fetchData = useCallback(async () => {
    console.log('[useWidgetData] fetchData called for widget:', config.id, 'isInitialLoad:', isInitialLoadRef.current);

    // Only show loading spinner on initial load, not on refresh
    if (isInitialLoadRef.current) {
      setLoading(true);
    }

    await Promise.all([fetchLatestReadings(), fetchHistory()]);

    if (isInitialLoadRef.current) {
      setLoading(false);
      isInitialLoadRef.current = false;
    }

    console.log('[useWidgetData] fetchData completed for widget:', config.id);
  }, [fetchLatestReadings, fetchHistory, config.id]);

  // Initial fetch and history refresh interval
  // Note: Live data comes via WebSocket, polling is only for history charts
  useEffect(() => {
    console.log('[useWidgetData] Setting up widget:', config.id, {
      refreshInterval: config.refreshInterval,
      wsConnected: isConnected,
    });

    fetchData();

    // History refresh interval: use config value or default to 60 seconds
    // Since live data comes via WebSocket, we only need to refresh history periodically
    const historyRefreshInterval = config.refreshInterval > 0 ? config.refreshInterval : 60000;
    console.log('[useWidgetData] History refresh interval:', historyRefreshInterval, 'ms for widget:', config.id);

    intervalRef.current = setInterval(() => {
      // Only refresh history, live data comes from WebSocket
      fetchHistory();
    }, historyRefreshInterval);

    return () => {
      if (intervalRef.current) {
        console.log('[useWidgetData] Clearing interval for widget:', config.id);
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [fetchData, fetchHistory, config.refreshInterval, config.id, isConnected]);

  // Refetch on config changes
  useEffect(() => {
    fetchData();
  }, [config.selectedChannels, config.sensorIds, config.metric, config.timeRange, fetchData]);

  return {
    data,
    history,
    loading,
    error,
    refetch: fetchData,
  };
}

export default useWidgetData;
