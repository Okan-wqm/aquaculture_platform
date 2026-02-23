/**
 * useChannelManagement Hook
 *
 * CRUD operations for sensor data channels.
 * GraphQL mutations may not exist on the backend yet -- they will be wired up in Task 9.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { graphqlFetch } from '../config/api';
import {
  DataChannelConfig,
} from '../types/registration.types';

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
// Input types for create/update (L5: added unitSymbol)
// ============================================================================

export interface CreateChannelInput {
  channelKey: string;
  displayLabel: string;
  dataType: string;
  unit?: string;
  unitSymbol?: string;
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
  unitSymbol?: string;
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
// Hook (M2: split fetchLoading / mutating)
// ============================================================================

export function useChannelManagement(sensorId: string) {
  const [channels, setChannels] = useState<SensorDataChannel[]>([]);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [mutationError, setMutationError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refetch = useCallback(async () => {
    if (!sensorId) return;

    setFetchLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{
        sensor: { dataChannels: SensorDataChannel[] };
      }>(GET_SENSOR_CHANNELS_QUERY, { sensorId });
      if (!mountedRef.current) return;
      setChannels(data.sensor?.dataChannels || []);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err as Error);
    } finally {
      if (mountedRef.current) {
        setFetchLoading(false);
      }
    }
  }, [sensorId]);

  // Fetch channels on mount
  useEffect(() => {
    refetch();
  }, [refetch]);

  const createChannel = useCallback(
    async (input: CreateChannelInput): Promise<SensorDataChannel | null> => {
      setMutating(true);
      setMutationError(null);

      try {
        const data = await graphqlFetch<{
          createSensorDataChannel: SensorDataChannel;
        }>(CREATE_CHANNEL_MUTATION, { sensorId, input });

        if (!mountedRef.current) return null;
        // Refetch the full list after creation
        await refetch();
        return data.createSensorDataChannel;
      } catch (err) {
        if (!mountedRef.current) return null;
        setMutationError(err as Error);
        return null;
      } finally {
        if (mountedRef.current) {
          setMutating(false);
        }
      }
    },
    [sensorId, refetch],
  );

  const updateChannel = useCallback(
    async (channelId: string, input: UpdateChannelInput): Promise<SensorDataChannel | null> => {
      setMutating(true);
      setMutationError(null);

      try {
        const data = await graphqlFetch<{
          updateSensorDataChannel: SensorDataChannel;
        }>(UPDATE_CHANNEL_MUTATION, { id: channelId, input });

        if (!mountedRef.current) return null;
        // Refetch the full list after update
        await refetch();
        return data.updateSensorDataChannel;
      } catch (err) {
        if (!mountedRef.current) return null;
        setMutationError(err as Error);
        return null;
      } finally {
        if (mountedRef.current) {
          setMutating(false);
        }
      }
    },
    [refetch],
  );

  const deleteChannel = useCallback(
    async (channelId: string): Promise<boolean> => {
      setMutating(true);
      setMutationError(null);

      try {
        await graphqlFetch<{ deleteSensorDataChannel: boolean }>(
          DELETE_CHANNEL_MUTATION,
          { id: channelId },
        );

        if (!mountedRef.current) return false;
        // Refetch the full list after deletion
        await refetch();
        return true;
      } catch (err) {
        if (!mountedRef.current) return false;
        setMutationError(err as Error);
        return false;
      } finally {
        if (mountedRef.current) {
          setMutating(false);
        }
      }
    },
    [refetch],
  );

  return {
    channels,
    loading: fetchLoading || mutating,
    fetchLoading,
    mutating,
    error,
    mutationError,
    createChannel,
    updateChannel,
    deleteChannel,
    refetch,
  };
}
