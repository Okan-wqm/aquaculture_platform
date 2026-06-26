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
  mutation CreateDataChannel($sensorId: ID!, $input: CreateDataChannelInput!) {
    createDataChannel(sensorId: $sensorId, input: $input) {
      id
      channelKey
      displayLabel
    }
  }
`;

// updateDataChannel takes a single input arg; the channel id lives inside the
// UpdateDataChannelInput (channelId), matching the backend resolver signature.
const UPDATE_CHANNEL_MUTATION = `
  mutation UpdateDataChannel($input: UpdateDataChannelInput!) {
    updateDataChannel(input: $input) {
      id
      channelKey
      displayLabel
    }
  }
`;

const DELETE_CHANNEL_MUTATION = `
  mutation DeleteDataChannel($channelId: ID!) {
    deleteDataChannel(channelId: $channelId)
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
          createDataChannel: SensorDataChannel;
        }>(CREATE_CHANNEL_MUTATION, { sensorId, input });

        if (!mountedRef.current) return null;
        // Refetch the full list after creation
        await refetch();
        return data.createDataChannel;
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
          updateDataChannel: SensorDataChannel;
        }>(UPDATE_CHANNEL_MUTATION, { input: { channelId, ...input } });

        if (!mountedRef.current) return null;
        // Refetch the full list after update
        await refetch();
        return data.updateDataChannel;
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
        await graphqlFetch<{ deleteDataChannel: boolean }>(
          DELETE_CHANNEL_MUTATION,
          { channelId },
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
