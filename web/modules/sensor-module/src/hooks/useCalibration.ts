/**
 * Hook for fetching and managing sensor calibration data
 *
 * Uses the sensor-service's channel resolver:
 * - allDataChannels query (returns calibration fields per channel)
 * - updateDataChannel mutation (update calibration parameters)
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { graphqlFetch } from '../config/api';

// ============================================================================
// Types
// ============================================================================

export interface CalibrationChannel {
  id: string;
  sensorId: string;
  channelKey: string;
  displayLabel: string;
  unit?: string;
  unitSymbol?: string;
  dataType: string;
  calibrationEnabled: boolean;
  calibrationMultiplier: number;
  calibrationOffset: number;
  lastCalibratedAt?: string;
  nextCalibrationDue?: string;
  calibrationIntervalDays?: number;
  calibrationPolynomial?: { coefficients: number[] };
  isEnabled: boolean;
}

export interface CalibrationUpdateInput {
  channelId: string;
  calibrationEnabled: boolean;
  calibrationMultiplier: number;
  calibrationOffset: number;
  /**
   * Per-channel calibration interval in days. When set, the backend computes
   * nextCalibrationDue from it so overdue-calibration warnings can fire.
   */
  intervalDays?: number;
}

export type CalibrationStatus = 'calibrated' | 'due' | 'overdue' | 'never';

// ============================================================================
// GraphQL Queries and Mutations
// ============================================================================

const ALL_DATA_CHANNELS_QUERY = `
  query AllDataChannels {
    allDataChannels {
      id
      sensorId
      channelKey
      displayLabel
      unit
      dataType
      calibrationEnabled
      calibrationMultiplier
      calibrationOffset
      lastCalibratedAt
      nextCalibrationDue
      calibrationIntervalDays
      isEnabled
    }
  }
`;

// SENSOR-HIGH-083: calibration is recorded through the calibration aggregate, not
// updateDataChannel. recordCalibration persists an immutable calibration event and
// stamps lastCalibratedAt/nextCalibrationDue, so the status the page derives is
// truthful (a calibrated channel no longer reads "never calibrated" forever).
const RECORD_CALIBRATION_MUTATION = `
  mutation RecordCalibration($input: RecordCalibrationInput!) {
    recordCalibration(input: $input) {
      id
      calibrationEnabled
      calibrationMultiplier
      calibrationOffset
      lastCalibratedAt
      nextCalibrationDue
      calibrationIntervalDays
    }
  }
`;

// ============================================================================
// Helpers
// ============================================================================

export function getCalibrationStatus(channel: CalibrationChannel): CalibrationStatus {
  if (!channel.calibrationEnabled) {
    return channel.lastCalibratedAt ? 'calibrated' : 'never';
  }

  if (!channel.lastCalibratedAt) {
    return 'never';
  }

  if (channel.nextCalibrationDue) {
    const dueDate = new Date(channel.nextCalibrationDue);
    const now = new Date();
    if (dueDate < now) {
      return 'overdue';
    }
    // Due within 7 days
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
    if (dueDate <= sevenDaysFromNow) {
      return 'due';
    }
  }

  return 'calibrated';
}

export function getStatusLabel(status: CalibrationStatus): string {
  switch (status) {
    case 'calibrated':
      return 'Kalibre';
    case 'due':
      return 'Kalibrasyon Yaklasıyor';
    case 'overdue':
      return 'Kalibrasyon Gecikti';
    case 'never':
      return 'Hic Kalibre Edilmedi';
  }
}

export function getStatusColor(status: CalibrationStatus): string {
  switch (status) {
    case 'calibrated':
      return 'text-success-600 dark:text-success-400 bg-success-50 dark:bg-success-900/20 border-success-200 dark:border-success-800';
    case 'due':
      return 'text-warning-600 dark:text-warning-400 bg-warning-50 dark:bg-warning-900/20 border-warning-200 dark:border-warning-800';
    case 'overdue':
      return 'text-error-600 dark:text-error-400 bg-error-50 dark:bg-error-900/20 border-error-200 dark:border-error-800';
    case 'never':
      return 'text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700';
  }
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useCalibration() {
  const [channels, setChannels] = useState<CalibrationChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const fetchChannels = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ allDataChannels: CalibrationChannel[] }>(
        ALL_DATA_CHANNELS_QUERY,
      );
      setChannels(result.allDataChannels || []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  // Only show enabled channels with numeric data type (calibration makes sense for numbers)
  const calibratableChannels = useMemo(
    () => channels.filter((c) => c.isEnabled && c.dataType === 'number'),
    [channels],
  );

  // Group by sensor
  const channelsBySensor = useMemo(() => {
    const groups: Record<string, CalibrationChannel[]> = {};
    for (const ch of calibratableChannels) {
      const key = ch.sensorId;
      if (!groups[key]) groups[key] = [];
      groups[key].push(ch);
    }
    return groups;
  }, [calibratableChannels]);

  // Calibration stats
  const stats = useMemo(() => {
    const total = calibratableChannels.length;
    const enabled = calibratableChannels.filter((c) => c.calibrationEnabled).length;
    const overdue = calibratableChannels.filter(
      (c) => getCalibrationStatus(c) === 'overdue',
    ).length;
    const due = calibratableChannels.filter((c) => getCalibrationStatus(c) === 'due').length;
    const neverCalibrated = calibratableChannels.filter(
      (c) => getCalibrationStatus(c) === 'never',
    ).length;

    return { total, enabled, overdue, due, neverCalibrated };
  }, [calibratableChannels]);

  // Update calibration for a channel
  const updateCalibration = useCallback(
    async (input: CalibrationUpdateInput) => {
      setUpdating(true);
      setUpdateError(null);

      try {
        await graphqlFetch(RECORD_CALIBRATION_MUTATION, {
          input: {
            channelId: input.channelId,
            calibrationEnabled: input.calibrationEnabled,
            calibrationMultiplier: input.calibrationMultiplier,
            calibrationOffset: input.calibrationOffset,
            ...(input.intervalDays != null ? { intervalDays: input.intervalDays } : {}),
          },
        });

        await fetchChannels();
      } catch (err) {
        setUpdateError((err as Error).message);
        throw err;
      } finally {
        setUpdating(false);
      }
    },
    [fetchChannels],
  );

  return {
    channels: calibratableChannels,
    channelsBySensor,
    stats,
    loading,
    error,
    updating,
    updateError,
    updateCalibration,
    refetch: fetchChannels,
  };
}
