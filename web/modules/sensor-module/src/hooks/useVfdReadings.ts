import { useState, useCallback, useEffect, useRef } from 'react';
import {
  VfdReading,
  VfdParameters,
  VfdStatusBits,
  VfdReadingStats,
  VfdReadingFilter,
  VFD_PARAMETER_UNITS,
} from '../types/vfd.types';

// API base URL
const API_URL = 'http://localhost:3000/graphql';

// GraphQL fetch helper
async function graphqlFetch<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = localStorage.getItem('access_token');

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL Error');
  }

  return result.data;
}

// GraphQL Queries
const GET_VFD_READINGS_QUERY = `
  query GetVfdReadings($vfdDeviceId: ID!, $from: DateTime, $to: DateTime, $limit: Int) {
    vfdReadings(vfdDeviceId: $vfdDeviceId, from: $from, to: $to, limit: $limit) {
      id
      vfdDeviceId
      tenantId
      timestamp
      parameters {
        outputFrequency
        motorSpeed
        motorCurrent
        motorVoltage
        motorTorque
        motorPower
        dcBusVoltage
        outputPower
        driveTemperature
        motorTemperature
        energyConsumption
        runningHours
        statusWord
        controlWord
        faultCode
        warningCode
      }
      statusBits {
        ready
        running
        fault
        warning
        atSetpoint
        atReference
        direction
        remoteControl
        localControl
        autoMode
        manualMode
        currentLimit
        voltageLimit
        torqueLimit
        speedLimit
        enabled
        quickStopActive
        switchOnDisabled
      }
      quality {
        overallQuality
        communicationStatus
        dataValidity
        timestamp
      }
    }
  }
`;

const GET_VFD_LATEST_READING_QUERY = `
  query GetVfdLatestReading($vfdDeviceId: ID!) {
    vfdLatestReading(vfdDeviceId: $vfdDeviceId) {
      id
      vfdDeviceId
      timestamp
      parameters {
        outputFrequency
        motorSpeed
        motorCurrent
        motorVoltage
        motorTorque
        motorPower
        dcBusVoltage
        outputPower
        driveTemperature
        motorTemperature
        energyConsumption
        runningHours
        statusWord
        controlWord
        faultCode
        warningCode
      }
      statusBits {
        ready
        running
        fault
        warning
        atSetpoint
        direction
        remoteControl
        enabled
      }
    }
  }
`;

const GET_VFD_READING_STATS_QUERY = `
  query GetVfdReadingStats($vfdDeviceId: ID!, $period: String!) {
    vfdReadingStats(vfdDeviceId: $vfdDeviceId, period: $period) {
      vfdDeviceId
      period
      avgFrequency
      avgCurrent
      avgPower
      maxFrequency
      maxCurrent
      maxPower
      totalEnergy
      runningTime
      faultCount
    }
  }
`;

// GraphQL Mutations
const READ_VFD_PARAMETERS_MUTATION = `
  mutation ReadVfdParameters($vfdDeviceId: ID!, $parameters: [String!]) {
    readVfdParameters(vfdDeviceId: $vfdDeviceId, parameters: $parameters) {
      id
      timestamp
      parameters
      statusBits
      quality {
        overallQuality
        communicationStatus
        dataValidity
      }
    }
  }
`;

/**
 * Hook to fetch VFD readings history
 */
export function useVfdReadings(filter: VfdReadingFilter) {
  const [readings, setReadings] = useState<VfdReading[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    if (!filter.vfdDeviceId) return;

    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{ vfdReadings: VfdReading[] }>(GET_VFD_READINGS_QUERY, {
        vfdDeviceId: filter.vfdDeviceId,
        from: filter.from,
        to: filter.to,
        limit: filter.limit || 100,
      });
      setReadings(data.vfdReadings);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  return {
    readings,
    loading,
    error,
    refetch,
  };
}

/**
 * Hook to fetch latest VFD reading
 */
export function useVfdLatestReading(vfdDeviceId: string | undefined) {
  const [reading, setReading] = useState<VfdReading | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    if (!vfdDeviceId) return;

    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{ vfdLatestReading: VfdReading }>(
        GET_VFD_LATEST_READING_QUERY,
        { vfdDeviceId }
      );
      setReading(data.vfdLatestReading);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [vfdDeviceId]);

  return {
    reading,
    loading,
    error,
    refetch,
  };
}

/**
 * Hook for real-time VFD readings with polling
 */
export function useVfdRealtimeReadings(
  vfdDeviceId: string | undefined,
  options: {
    enabled?: boolean;
    pollInterval?: number;
    onUpdate?: (reading: VfdReading) => void;
  } = {}
) {
  const { enabled = true, pollInterval = 2000, onUpdate } = options;
  const [reading, setReading] = useState<VfdReading | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchReading = useCallback(async () => {
    if (!vfdDeviceId) return;

    try {
      const data = await graphqlFetch<{ vfdLatestReading: VfdReading }>(
        GET_VFD_LATEST_READING_QUERY,
        { vfdDeviceId }
      );

      if (data.vfdLatestReading) {
        setReading(data.vfdLatestReading);
        setLastUpdated(new Date());
        setError(null);
        onUpdate?.(data.vfdLatestReading);
      }
    } catch (err) {
      setError(err as Error);
    }
  }, [vfdDeviceId, onUpdate]);

  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    setIsPolling(true);
    fetchReading(); // Initial fetch

    pollIntervalRef.current = setInterval(fetchReading, pollInterval);
  }, [fetchReading, pollInterval]);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setIsPolling(false);
  }, []);

  // Auto-start/stop polling based on enabled flag
  useEffect(() => {
    if (enabled && vfdDeviceId) {
      startPolling();
    } else {
      stopPolling();
    }

    return () => {
      stopPolling();
    };
  }, [enabled, vfdDeviceId, startPolling, stopPolling]);

  return {
    reading,
    isPolling,
    error,
    lastUpdated,
    startPolling,
    stopPolling,
    refetch: fetchReading,
  };
}

/**
 * Hook to fetch VFD reading statistics
 */
export function useVfdReadingStats(
  vfdDeviceId: string | undefined,
  period: 'hour' | 'day' | 'week' | 'month' = 'day'
) {
  const [stats, setStats] = useState<VfdReadingStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    if (!vfdDeviceId) return;

    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{ vfdReadingStats: VfdReadingStats }>(
        GET_VFD_READING_STATS_QUERY,
        { vfdDeviceId, period }
      );
      setStats(data.vfdReadingStats);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [vfdDeviceId, period]);

  return {
    stats,
    loading,
    error,
    refetch,
  };
}

/**
 * Hook to manually trigger parameter reading
 */
export function useVfdParameterReader() {
  const [loading, setLoading] = useState(false);

  const readParameters = useCallback(
    async (
      vfdDeviceId: string,
      parameters?: string[]
    ): Promise<VfdReading | null> => {
      setLoading(true);

      try {
        const data = await graphqlFetch<{ readVfdParameters: VfdReading }>(
          READ_VFD_PARAMETERS_MUTATION,
          { vfdDeviceId, parameters }
        );
        return data.readVfdParameters;
      } catch {
        return null;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  return {
    readParameters,
    loading,
  };
}

/**
 * Helper to format parameter values with units
 */
export function formatParameterValue(
  parameterName: string,
  value: number | undefined,
  decimals: number = 2
): string {
  if (value === undefined || value === null) {
    return '-';
  }

  const unit = VFD_PARAMETER_UNITS[parameterName] || '';
  const formattedValue = value.toFixed(decimals);

  return unit ? `${formattedValue} ${unit}` : formattedValue;
}

/**
 * Helper to get status from status bits
 */
export function getVfdStatus(statusBits: VfdStatusBits | undefined): {
  status: 'running' | 'ready' | 'fault' | 'warning' | 'stopped';
  label: string;
  color: 'green' | 'blue' | 'red' | 'yellow' | 'gray';
} {
  if (!statusBits) {
    return { status: 'stopped', label: 'Bilinmiyor', color: 'gray' };
  }

  if (statusBits.fault) {
    return { status: 'fault', label: 'Arıza', color: 'red' };
  }

  if (statusBits.warning) {
    return { status: 'warning', label: 'Uyarı', color: 'yellow' };
  }

  if (statusBits.running) {
    return { status: 'running', label: 'Çalışıyor', color: 'green' };
  }

  if (statusBits.ready) {
    return { status: 'ready', label: 'Hazır', color: 'blue' };
  }

  return { status: 'stopped', label: 'Durdu', color: 'gray' };
}

/**
 * Helper to parse status word into human-readable bits
 */
export function parseVfdStatusWord(
  statusWord: number | undefined,
  bitDefinitions?: Record<string, string>
): { bit: number; name: string; active: boolean }[] {
  if (statusWord === undefined) {
    return [];
  }

  const defaultBitDefs: Record<string, string> = {
    '0': 'Ready to switch on',
    '1': 'Switched on',
    '2': 'Operation enabled',
    '3': 'Fault',
    '4': 'Voltage enabled',
    '5': 'Quick stop',
    '6': 'Switch on disabled',
    '7': 'Warning',
    '8': 'Reserved',
    '9': 'Remote',
    '10': 'Target reached',
    '11': 'Internal limit active',
    '12': 'Reserved',
    '13': 'Reserved',
    '14': 'Reserved',
    '15': 'Reserved',
  };

  const defs = bitDefinitions || defaultBitDefs;

  return Object.entries(defs).map(([bit, name]) => ({
    bit: parseInt(bit, 10),
    name,
    active: ((statusWord >> parseInt(bit, 10)) & 1) === 1,
  }));
}

/**
 * Parameter display configuration
 */
export interface ParameterDisplayConfig {
  name: string;
  displayName: string;
  unit: string;
  decimals: number;
  category: 'motor' | 'electrical' | 'thermal' | 'energy' | 'status';
  icon?: string;
  warningThreshold?: number;
  criticalThreshold?: number;
}

export const DEFAULT_PARAMETER_DISPLAY_CONFIG: Record<string, ParameterDisplayConfig> = {
  outputFrequency: {
    name: 'outputFrequency',
    displayName: 'Çıkış Frekansı',
    unit: 'Hz',
    decimals: 1,
    category: 'motor',
  },
  motorSpeed: {
    name: 'motorSpeed',
    displayName: 'Motor Hızı',
    unit: 'RPM',
    decimals: 0,
    category: 'motor',
  },
  motorCurrent: {
    name: 'motorCurrent',
    displayName: 'Motor Akımı',
    unit: 'A',
    decimals: 2,
    category: 'electrical',
    warningThreshold: 80,
    criticalThreshold: 100,
  },
  motorVoltage: {
    name: 'motorVoltage',
    displayName: 'Motor Gerilimi',
    unit: 'V',
    decimals: 1,
    category: 'electrical',
  },
  motorTorque: {
    name: 'motorTorque',
    displayName: 'Motor Torku',
    unit: '%',
    decimals: 1,
    category: 'motor',
    warningThreshold: 90,
    criticalThreshold: 100,
  },
  dcBusVoltage: {
    name: 'dcBusVoltage',
    displayName: 'DC Bus Gerilimi',
    unit: 'V',
    decimals: 1,
    category: 'electrical',
  },
  outputPower: {
    name: 'outputPower',
    displayName: 'Çıkış Gücü',
    unit: 'kW',
    decimals: 2,
    category: 'electrical',
  },
  driveTemperature: {
    name: 'driveTemperature',
    displayName: 'Sürücü Sıcaklığı',
    unit: '°C',
    decimals: 1,
    category: 'thermal',
    warningThreshold: 70,
    criticalThreshold: 85,
  },
  motorTemperature: {
    name: 'motorTemperature',
    displayName: 'Motor Sıcaklığı',
    unit: '°C',
    decimals: 1,
    category: 'thermal',
    warningThreshold: 80,
    criticalThreshold: 100,
  },
  energyConsumption: {
    name: 'energyConsumption',
    displayName: 'Enerji Tüketimi',
    unit: 'kWh',
    decimals: 2,
    category: 'energy',
  },
  runningHours: {
    name: 'runningHours',
    displayName: 'Çalışma Saati',
    unit: 'h',
    decimals: 0,
    category: 'energy',
  },
};
