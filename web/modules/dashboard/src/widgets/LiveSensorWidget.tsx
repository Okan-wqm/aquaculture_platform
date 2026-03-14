/**
 * Live Sensor Widget
 *
 * Displays real-time sensor readings via GraphQL polling.
 * Uses @tanstack/react-query refetchInterval for automatic updates.
 */

import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, Badge, formatRelativeTime, graphqlClient } from '@aquaculture/shared-ui';
// PERF-L4: shared icon components -- eliminates duplicate inline SVG bytes
import { SensorIcon } from '../components/icons';

// ============================================================================
// Types
// ============================================================================

interface SensorReading {
  id: string;
  sensorId: string;
  value: number;
  unit: string;
  timestamp: string;
}

interface SensorInfo {
  id: string;
  name: string;
  sensorType: string;
  status: string;
  unit: string;
}

export interface LiveSensorWidgetProps {
  sensorId?: string;
  sensorType?: string;
  className?: string;
  /** Polling interval in ms. Default 15000 (15s) */
  pollingInterval?: number;
}

// ============================================================================
// GraphQL
// ============================================================================

const LATEST_READING_QUERY = `
  query LatestReading($sensorId: ID!) {
    latestReading(sensorId: $sensorId) {
      id
      sensorId
      value
      unit
      timestamp
    }
  }
`;

const SENSOR_INFO_QUERY = `
  query SensorInfo($id: ID!) {
    sensor(id: $id) {
      id
      name
      sensorType
      status
      unit
    }
  }
`;

// ============================================================================
// Component
// ============================================================================

export const LiveSensorWidget: React.FC<LiveSensorWidgetProps> = ({
  sensorId,
  sensorType,
  className = '',
  pollingInterval = 15_000,
}) => {
  // Sensor info query (fetch once, long staleTime)
  const sensorInfoQuery = useQuery({
    queryKey: ['sensor', 'info', sensorId],
    staleTime: 5 * 60_000, // 5 min
    enabled: !!sensorId,
    queryFn: async () => {
      const result = await graphqlClient.request<{ sensor: SensorInfo }>(
        SENSOR_INFO_QUERY,
        { id: sensorId },
      );
      return result.sensor;
    },
  });

  // Latest reading query with polling
  const readingQuery = useQuery({
    queryKey: ['sensor', 'latestReading', sensorId],
    staleTime: 10_000, // 10s
    refetchInterval: pollingInterval,
    enabled: !!sensorId,
    queryFn: async () => {
      const result = await graphqlClient.request<{
        latestReading: SensorReading | null;
      }>(LATEST_READING_QUERY, { sensorId });
      return result.latestReading;
    },
  });

  const sensorName = useMemo(() => {
    if (sensorInfoQuery.data?.name) return sensorInfoQuery.data.name;
    if (sensorType) return `${sensorType} Sensoru`;
    return 'Canli Sensor';
  }, [sensorInfoQuery.data, sensorType]);

  const statusColor = useMemo(() => {
    const status = sensorInfoQuery.data?.status;
    if (status === 'ACTIVE') return 'success';
    if (status === 'WARNING') return 'warning';
    if (status === 'ERROR' || status === 'OFFLINE') return 'error';
    return 'default';
  }, [sensorInfoQuery.data?.status]);

  // No sensor ID provided -- placeholder
  if (!sensorId) {
    return (
      <Card className={`p-4 ${className}`}>
        <div className="text-center py-6 text-gray-500">
          <SensorIcon className="w-8 h-8 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-500">Canli Sensor</p>
          <p className="text-xs text-gray-500 mt-2">Sensor ID gerekli</p>
        </div>
      </Card>
    );
  }

  // Loading state
  if (readingQuery.isLoading && !readingQuery.data) {
    return (
      <Card className={`p-4 ${className}`}>
        <div className="animate-pulse">
          <div className="flex items-center justify-between mb-3">
            <div className="h-4 bg-gray-200 rounded w-1/3" />
            <div className="h-5 bg-gray-200 rounded-full w-16" />
          </div>
          <div className="text-center py-4">
            <div className="h-10 bg-gray-200 rounded w-24 mx-auto" />
            <div className="h-3 bg-gray-200 rounded w-20 mx-auto mt-2" />
          </div>
        </div>
      </Card>
    );
  }

  // Error state
  if (readingQuery.isError) {
    return (
      <Card className={`p-4 ${className}`}>
        <div className="text-center py-6">
          <SensorIcon className="w-8 h-8 mx-auto mb-2 text-red-400" />
          <p className="text-sm font-medium text-gray-500">{sensorName}</p>
          <p className="text-xs text-red-500 mt-1">Veri okunamadi</p>
          <button
            type="button"
            onClick={() => readingQuery.refetch()}
            className="text-xs text-primary-600 font-medium hover:underline mt-2"
          >
            Tekrar Dene
          </button>
        </div>
      </Card>
    );
  }

  const reading = readingQuery.data;

  return (
    <Card className={`p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center space-x-2">
          <SensorIcon className="w-4 h-4 text-gray-500" />
          <h4 className="text-sm font-medium text-gray-700">{sensorName}</h4>
        </div>
        <Badge variant={statusColor} size="sm">
          {sensorInfoQuery.data?.status === 'ACTIVE' ? 'Aktif' : (sensorInfoQuery.data?.status ?? 'Bilinmiyor')}
        </Badge>
      </div>

      {reading ? (
        <div className="text-center py-2">
          <p className="text-3xl font-bold text-gray-900">
            {reading.value.toFixed(2)}
          </p>
          <p className="text-sm text-gray-500 mt-1">{reading.unit}</p>
          <p className="text-xs text-gray-500 mt-2">
            Son okuma: {formatRelativeTime(new Date(reading.timestamp))}
          </p>
          {/* Live indicator */}
          <div className="flex items-center justify-center mt-2 space-x-1">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            <span className="text-xs text-green-600">Canli</span>
          </div>
        </div>
      ) : (
        <div className="text-center py-4">
          <p className="text-sm text-gray-500">Henuz okuma yok</p>
          <p className="text-xs text-gray-500 mt-1">
            Sensor ID: {sensorId.slice(0, 8)}...
          </p>
        </div>
      )}
    </Card>
  );
};

export default LiveSensorWidget;
