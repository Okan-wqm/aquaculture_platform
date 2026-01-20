/**
 * Hook for fetching and managing sensor readings
 * Uses real API data via useSensorList hook and latestReading endpoint
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import { useScadaStore, SensorReading, SensorType, SensorStatus, ScadaProcess } from '../store/scadaStore';
import { EquipmentNodeData, ScadaNode, ScadaEdge } from '../types/scada-types';
import { useSensorList, RegisteredSensor } from './useSensorList';

// GraphQL API for fetching real readings
const API_URL = 'http://localhost:3000/graphql';

interface SensorReadings {
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

interface LatestReadingResponse {
  latestReading: {
    id: string;
    sensorId: string;
    timestamp: string;
    readings: SensorReadings;
  } | null;
}

async function fetchLatestReading(sensorId: string): Promise<LatestReadingResponse['latestReading']> {
  try {
    const token = localStorage.getItem('access_token');
    const tenantId = localStorage.getItem('tenant_id');

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(tenantId && { 'X-Tenant-Id': tenantId }),
      },
      body: JSON.stringify({
        query: `
          query GetLatestReading($sensorId: ID!) {
            latestReading(sensorId: $sensorId) {
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
        `,
        variables: { sensorId },
      }),
    });

    const result = await response.json();
    if (result.errors) {
      console.warn(`Error fetching reading for sensor ${sensorId}:`, result.errors[0]?.message);
      return null;
    }
    return result.data?.latestReading || null;
  } catch (error) {
    console.warn(`Failed to fetch reading for sensor ${sensorId}:`, error);
    return null;
  }
}

// Type mapping from API sensor types to SCADA types
const TYPE_MAP: Record<string, SensorType> = {
  'PH': 'ph',
  'TEMPERATURE': 'temperature',
  'DISSOLVED_OXYGEN': 'dissolved_oxygen',
  'SALINITY': 'salinity',
  'AMMONIA': 'ammonia',
  'NITRITE': 'nitrite',
  'NITRATE': 'nitrate',
  'TURBIDITY': 'turbidity',
  'WATER_LEVEL': 'water_level',
};

// Unit mapping
const UNIT_MAP: Record<string, string> = {
  'PH': 'pH',
  'TEMPERATURE': '°C',
  'DISSOLVED_OXYGEN': 'mg/L',
  'SALINITY': 'ppt',
  'AMMONIA': 'mg/L',
  'NITRITE': 'mg/L',
  'NITRATE': 'mg/L',
  'TURBIDITY': 'NTU',
  'WATER_LEVEL': 'm',
};

// Default ranges for sensor types
const DEFAULT_RANGES: Record<string, { min: number; max: number; warningLow?: number; warningHigh?: number; criticalLow?: number; criticalHigh?: number }> = {
  'ph': { min: 0, max: 14, warningLow: 6.5, warningHigh: 8.5, criticalLow: 6, criticalHigh: 9 },
  'temperature': { min: 0, max: 40, warningLow: 18, warningHigh: 28, criticalLow: 15, criticalHigh: 32 },
  'dissolved_oxygen': { min: 0, max: 15, warningLow: 5, warningHigh: 12, criticalLow: 3, criticalHigh: 14 },
  'salinity': { min: 0, max: 50, warningLow: 25, warningHigh: 40, criticalLow: 20, criticalHigh: 45 },
  'ammonia': { min: 0, max: 5, warningHigh: 1, criticalHigh: 2 },
  'nitrite': { min: 0, max: 5, warningHigh: 0.5, criticalHigh: 1 },
  'nitrate': { min: 0, max: 100, warningHigh: 50, criticalHigh: 80 },
  'turbidity': { min: 0, max: 100, warningHigh: 20, criticalHigh: 50 },
  'water_level': { min: 0, max: 10, warningLow: 1, warningHigh: 8, criticalLow: 0.5, criticalHigh: 9 },
};

// Convert RegisteredSensor to SensorReading
function sensorToReading(sensor: RegisteredSensor): SensorReading {
  const typeKey = sensor.type?.toUpperCase() || 'TEMPERATURE';
  const scadaType = TYPE_MAP[typeKey] || 'temperature';
  const ranges = DEFAULT_RANGES[scadaType] || DEFAULT_RANGES['temperature'];

  // Generate initial value based on sensor type
  const baseValue = (ranges.min + ranges.max) / 2;
  const value = Math.round(baseValue * 100) / 100;

  // Determine status based on connection
  let status: SensorStatus = 'normal';
  if (!sensor.connectionStatus?.isConnected) {
    status = 'offline';
  }

  return {
    id: sensor.id,
    sensorId: sensor.id,
    sensorName: sensor.name,
    type: scadaType,
    value,
    unit: UNIT_MAP[typeKey] || '°C',
    status,
    minValue: ranges.min,
    maxValue: ranges.max,
    warningLow: ranges.warningLow,
    warningHigh: ranges.warningHigh,
    criticalLow: ranges.criticalLow,
    criticalHigh: ranges.criticalHigh,
    timestamp: new Date(sensor.updatedAt || sensor.createdAt),
    trend: 'stable' as const,
    history: generateInitialHistory(value, ranges.min, ranges.max),
  };
}

// Generate initial history data
function generateInitialHistory(baseValue: number, min: number, max: number, count: number = 30): { timestamp: Date; value: number }[] {
  const history: { timestamp: Date; value: number }[] = [];
  let value = baseValue;

  for (let i = count; i > 0; i--) {
    const timestamp = new Date(Date.now() - i * 60000);
    const variance = 0.05;
    const change = (Math.random() - 0.5) * 2 * variance * value;
    value = Math.max(min, Math.min(max, value + change));
    value = Math.round(value * 100) / 100;
    history.push({ timestamp, value });
  }

  return history;
}

// Create dynamic process from sensors
function createProcessFromSensors(sensors: RegisteredSensor[]): ScadaProcess {
  const nodes: ScadaNode<EquipmentNodeData>[] = [];
  const edges: ScadaEdge[] = [];

  // Position sensors in a grid
  const columns = 3;
  const spacing = { x: 250, y: 200 };
  const offset = { x: 100, y: 100 };

  sensors.forEach((sensor, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);

    nodes.push({
      id: sensor.id,
      type: 'scadaEquipment',
      position: {
        x: offset.x + col * spacing.x,
        y: offset.y + row * spacing.y,
      },
      data: {
        equipmentId: sensor.id,
        equipmentName: sensor.name,
        equipmentCode: sensor.serialNumber || `SNS-${index + 1}`,
        equipmentType: 'sensor',
        equipmentCategory: 'monitoring',
        status: sensor.connectionStatus?.isConnected ? 'operational' : 'offline',
      },
    });

    // Connect sequential sensors with edges
    if (index > 0 && col === 0) {
      // Connect to previous row
      edges.push({
        id: `edge-${sensors[index - 1].id}-${sensor.id}`,
        source: sensors[index - 1].id,
        target: sensor.id,
        type: 'smoothstep',
        animated: sensor.connectionStatus?.isConnected,
      });
    } else if (index > 0) {
      edges.push({
        id: `edge-${sensors[index - 1].id}-${sensor.id}`,
        source: sensors[index - 1].id,
        target: sensor.id,
        type: 'smoothstep',
        animated: sensor.connectionStatus?.isConnected,
      });
    }
  });

  return {
    id: 'real-sensors-process',
    name: 'Kayıtlı Sensörler',
    description: 'Sistemde kayıtlı tüm sensörler',
    status: 'active',
    nodes,
    edges,
  };
}

export function useSensorReadings(refreshInterval: number = 10000) {
  const {
    selectedProcess,
    sensorReadings,
    isLiveMode,
    setProcesses,
    setSensorReadings,
    updateSensorReading,
    loadProcess,
  } = useScadaStore();

  // Fetch real sensors from API
  const { sensors, loading, error, refetch } = useSensorList();

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize processes from real sensors
  useEffect(() => {
    if (sensors.length === 0 || loading) return;

    // Create process from real sensors
    const realProcess = createProcessFromSensors(sensors);
    setProcesses([realProcess]);

    // Auto-select the process if none selected
    if (!selectedProcess) {
      loadProcess(realProcess);
    }

    setIsInitialized(true);
  }, [sensors, loading, setProcesses, loadProcess, selectedProcess]);

  // Initialize sensor readings
  useEffect(() => {
    if (!isInitialized || sensors.length === 0) return;

    sensors.forEach((sensor) => {
      const reading = sensorToReading(sensor);
      setSensorReadings(sensor.id, [reading]);
    });
  }, [isInitialized, sensors, setSensorReadings]);

  // Fetch real readings from API
  const fetchRealReadings = useCallback(async () => {
    if (sensors.length === 0) return;

    // Map sensor type to readings property key
    const typeToReadingsKey: Record<string, keyof SensorReadings> = {
      'TEMPERATURE': 'temperature',
      'PH': 'ph',
      'DISSOLVED_OXYGEN': 'dissolvedOxygen',
      'SALINITY': 'salinity',
      'AMMONIA': 'ammonia',
      'NITRITE': 'nitrite',
      'NITRATE': 'nitrate',
      'TURBIDITY': 'turbidity',
      'WATER_LEVEL': 'waterLevel',
    };

    // Fetch latest readings for all sensors in parallel
    const readingPromises = sensors.map(async (sensor) => {
      const latestReading = await fetchLatestReading(sensor.id);
      if (latestReading?.readings) {
        const existingReadings = sensorReadings.get(sensor.id);
        if (existingReadings && existingReadings.length > 0) {
          // Get the correct value based on sensor type
          const typeKey = sensor.type?.toUpperCase() || 'TEMPERATURE';
          const readingsKey = typeToReadingsKey[typeKey] || 'temperature';
          const value = latestReading.readings[readingsKey];

          if (value !== undefined && value !== null) {
            // Update with real value from API
            updateSensorReading(sensor.id, sensor.id, value);
          }
        }
      }
    });

    await Promise.all(readingPromises);
  }, [sensors, sensorReadings, updateSensorReading]);

  // Live updates with configurable refresh interval
  useEffect(() => {
    if (!isLiveMode || !isInitialized) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Initial fetch of real readings
    fetchRealReadings();

    // Refetch sensor data periodically from real API
    intervalRef.current = setInterval(() => {
      refetch();
      fetchRealReadings();
    }, refreshInterval);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isLiveMode, isInitialized, sensors, fetchRealReadings, refetch, refreshInterval]);

  // Get readings for specific equipment/sensor
  const getEquipmentReadings = useCallback(
    (equipmentId: string): SensorReading[] => {
      return sensorReadings.get(equipmentId) || [];
    },
    [sensorReadings]
  );

  // Get all readings as flat array
  const getAllReadings = useCallback((): SensorReading[] => {
    const allReadings: SensorReading[] = [];
    sensorReadings.forEach((readings) => {
      allReadings.push(...readings);
    });
    return allReadings;
  }, [sensorReadings]);

  // Get stats
  const getStats = useCallback(() => {
    const allReadings = getAllReadings();
    const total = allReadings.length;
    const normal = allReadings.filter((r) => r.status === 'normal').length;
    const warning = allReadings.filter((r) => r.status === 'warning').length;
    const critical = allReadings.filter((r) => r.status === 'critical').length;
    const offline = allReadings.filter((r) => r.status === 'offline').length;

    return { total, normal, warning, critical, offline };
  }, [getAllReadings]);

  // Get process list
  const processes = sensors.length > 0 ? [createProcessFromSensors(sensors)] : [];

  return {
    processes,
    getEquipmentReadings,
    getAllReadings,
    getStats,
    sensorReadings,
    loading,
    error,
    refetch,
    sensors,
  };
}

// Re-export for backward compatibility
export { useSensorList };
