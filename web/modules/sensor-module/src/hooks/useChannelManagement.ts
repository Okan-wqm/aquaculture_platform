/**
 * useChannelManagement Hook
 *
 * CRUD operations for sensor data channels.
 * GraphQL mutations may not exist on the backend yet — they will be wired up in Task 9.
 */

import { useState, useCallback, useEffect } from 'react';
import { getAccessToken, getTenantId } from '@platform/shared-ui/utils/api-client';
import {
  DataChannelConfig,
} from '../types/registration.types';

// ============================================================================
// GraphQL Helper
// ============================================================================

const API_URL = '/graphql';

async function graphqlFetch<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = getAccessToken();
  const tenantId = getTenantId();

  const response = await fetch(API_URL, {
    method: 'POST',
    credentials: 'include',
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
// GraphQL Queries & Mutations
// ============================================================================

const GET_SENSOR_CHANNELS_QUERY = `
  query GetSensorChannels($sensorId: ID!) {
    sensor(id: $sensorId) {
      dataChannels {
        id
        channelKey
        displayLabel
        dataType
        unit
        unitSymbol
        operationalMin
        operationalMax
        calibrationEnabled
        calibrationMultiplier
        calibrationOffset
        alertThresholds
        displaySettings
        discoverySource
        isEnabled
        displayOrder
      }
    }
  }
`;

const CREATE_CHANNEL_MUTATION = `
  mutation CreateSensorDataChannel($sensorId: ID!, $input: CreateSensorDataChannelInput!) {
    createSensorDataChannel(sensorId: $sensorId, input: $input) {
      id
      channelKey
      displayLabel
    }
  }
`;

const UPDATE_CHANNEL_MUTATION = `
  mutation UpdateSensorDataChannel($id: ID!, $input: UpdateSensorDataChannelInput!) {
    updateSensorDataChannel(id: $id, input: $input) {
      id
      channelKey
      displayLabel
    }
  }
`;

const DELETE_CHANNEL_MUTATION = `
  mutation DeleteSensorDataChannel($id: ID!) {
    deleteSensorDataChannel(id: $id)
  }
`;

// ============================================================================
// Channel type returned from the API
// ============================================================================

export interface SensorDataChannel {
  id: string;
  channelKey: string;
  displayLabel: string;
  dataType: string;
  unit?: string;
  unitSymbol?: string;
  operationalMin?: number;
  operationalMax?: number;
  calibrationEnabled: boolean;
  calibrationMultiplier: number;
  calibrationOffset: number;
  alertThresholds?: Record<string, unknown>;
  displaySettings?: Record<string, unknown>;
  discoverySource?: 'template' | 'manual' | 'auto';
  isEnabled: boolean;
  displayOrder: number;
}

// ============================================================================
// Input types for create/update
// ============================================================================

export interface CreateChannelInput {
  channelKey: string;
  displayLabel: string;
  dataType: string;
  unit?: string;
  operationalMin?: number;
  operationalMax?: number;
  calibrationEnabled?: boolean;
  calibrationMultiplier?: number;
  calibrationOffset?: number;
  alertThresholds?: Record<string, unknown>;
  displaySettings?: Record<string, unknown>;
  discoverySource?: string;
  isEnabled?: boolean;
  displayOrder?: number;
}

export interface UpdateChannelInput {
  displayLabel?: string;
  dataType?: string;
  unit?: string;
  operationalMin?: number;
  operationalMax?: number;
  calibrationEnabled?: boolean;
  calibrationMultiplier?: number;
  calibrationOffset?: number;
  alertThresholds?: Record<string, unknown>;
  displaySettings?: Record<string, unknown>;
  isEnabled?: boolean;
  displayOrder?: number;
}

// ============================================================================
// Hook
// ============================================================================

export function useChannelManagement(sensorId: string) {
  const [channels, setChannels] = useState<SensorDataChannel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    if (!sensorId) return;

    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{
        sensor: { dataChannels: SensorDataChannel[] };
      }>(GET_SENSOR_CHANNELS_QUERY, { sensorId });
      setChannels(data.sensor?.dataChannels || []);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [sensorId]);

  // Fetch channels on mount
  useEffect(() => {
    refetch();
  }, [refetch]);

  const createChannel = useCallback(
    async (input: CreateChannelInput): Promise<SensorDataChannel | null> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          createSensorDataChannel: SensorDataChannel;
        }>(CREATE_CHANNEL_MUTATION, { sensorId, input });

        // Refetch the full list after creation
        await refetch();
        return data.createSensorDataChannel;
      } catch (err) {
        setError(err as Error);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [sensorId, refetch],
  );

  const updateChannel = useCallback(
    async (channelId: string, input: UpdateChannelInput): Promise<SensorDataChannel | null> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          updateSensorDataChannel: SensorDataChannel;
        }>(UPDATE_CHANNEL_MUTATION, { id: channelId, input });

        // Refetch the full list after update
        await refetch();
        return data.updateSensorDataChannel;
      } catch (err) {
        setError(err as Error);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [refetch],
  );

  const deleteChannel = useCallback(
    async (channelId: string): Promise<boolean> => {
      setLoading(true);
      setError(null);

      try {
        await graphqlFetch<{ deleteSensorDataChannel: boolean }>(
          DELETE_CHANNEL_MUTATION,
          { id: channelId },
        );

        // Refetch the full list after deletion
        await refetch();
        return true;
      } catch (err) {
        setError(err as Error);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [refetch],
  );

  return {
    channels,
    loading,
    error,
    createChannel,
    updateChannel,
    deleteChannel,
    refetch,
  };
}
