/**
 * Data Channel List Hook
 *
 * Fetches all data channels for the current tenant with sensor info.
 * Used by widget configuration to select specific data channels.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
// FE-MEDIUM-380: the module's one GraphQL transport — the shared client, which also reports a
// GRAPHQL_VALIDATION_FAILED to the shell's build-skew check (config/api.ts).
import { graphqlFetch } from '../config/api';

// ============================================================================
// Types
// ============================================================================

export interface ChannelSensorInfo {
  id: string;
  name: string;
  type?: string;
}

export interface DataChannel {
  id: string;
  sensorId: string;
  sensor?: ChannelSensorInfo;
  tenantId: string;
  channelKey: string;
  displayLabel: string;
  description?: string;
  dataType: string;
  unit?: string;
  dataPath?: string;
  minValue?: number;
  maxValue?: number;
  isEnabled: boolean;
  displayOrder: number;
}

export interface GroupedChannels {
  sensorId: string;
  sensorName: string;
  sensorType?: string;
  channels: DataChannel[];
}

// ============================================================================
// GraphQL Query
// ============================================================================

const GET_ALL_DATA_CHANNELS_QUERY = `
  query GetAllDataChannels {
    allDataChannels {
      id
      sensorId
      sensor {
        id
        name
        type
      }
      tenantId
      channelKey
      displayLabel
      description
      dataType
      unit
      dataPath
      minValue
      maxValue
      isEnabled
      displayOrder
    }
  }
`;

// ============================================================================
// Hook Implementation
// ============================================================================

export function useDataChannelList() {
  const [channels, setChannels] = useState<DataChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchChannels = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ allDataChannels: DataChannel[] }>(
        GET_ALL_DATA_CHANNELS_QUERY
      );

      // Sort by sensor name, then display order
      const sorted = [...result.allDataChannels].sort((a, b) => {
        const sensorCompare = (a.sensor?.name || '').localeCompare(b.sensor?.name || '');
        if (sensorCompare !== 0) return sensorCompare;
        return a.displayOrder - b.displayOrder;
      });

      setChannels(sorted);
    } catch (err) {
      setError((err as Error).message);
      setChannels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  // Group channels by sensor
  const groupedBySensor = useMemo((): GroupedChannels[] => {
    const groups = new Map<string, GroupedChannels>();

    for (const channel of channels) {
      if (!groups.has(channel.sensorId)) {
        groups.set(channel.sensorId, {
          sensorId: channel.sensorId,
          sensorName: channel.sensor?.name || `Sensor ${channel.sensorId.slice(0, 8)}`,
          sensorType: channel.sensor?.type,
          channels: [],
        });
      }
      groups.get(channel.sensorId)!.channels.push(channel);
    }

    // Sort groups by sensor name
    return Array.from(groups.values()).sort((a, b) =>
      a.sensorName.localeCompare(b.sensorName)
    );
  }, [channels]);

  // Get only enabled channels
  const enabledChannels = useMemo(
    () => channels.filter((ch) => ch.isEnabled),
    [channels]
  );

  return {
    channels,
    enabledChannels,
    groupedBySensor,
    loading,
    error,
    refetch: fetchChannels,
  };
}

export default useDataChannelList;
