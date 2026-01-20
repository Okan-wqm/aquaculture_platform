/**
 * Hook for fetching linkable sensors for Process Editor
 * Enhances sensors with linking status for canvas node binding
 */

import { useMemo } from 'react';
import { useSensorList, RegisteredSensor } from './useSensorList';
import { useProcessStore } from '../store/processStore';

/**
 * Extended sensor interface with linking status
 */
export interface LinkableSensor extends RegisteredSensor {
  isLinked: boolean;
  linkedNodeId?: string;
  displayName: string; // Combined name with parent info
}

/**
 * Sensor type category labels
 */
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
  voltage: 'Voltaj',
  current: 'Akım',
  power: 'Güç',
  multi: 'Çoklu Sensör',
  array: 'Sensör Dizisi',
  other: 'Diğer',
};

/**
 * Get label for sensor type
 */
export function getSensorTypeLabel(type?: string): string {
  if (!type) return 'Bilinmeyen';
  const normalized = type.toLowerCase().replace(/-/g, '_');
  return SENSOR_TYPE_LABELS[normalized] || type;
}

/**
 * Hook to fetch sensors that can be linked to process nodes
 * Filters to only ACTIVE sensors and enhances with linking status
 */
export function useLinkableSensors(searchTerm?: string) {
  const sensorNodeMap = useProcessStore((state) => state.sensorNodeMap);

  // Fetch all sensors
  const { sensors, loading, error, refetch } = useSensorList();

  // Filter to active sensors and enhance with linking status
  const enhancedSensors = useMemo(() => {
    if (!sensors) return [];

    return sensors
      .filter((s) => s.registrationStatus === 'ACTIVE')
      .map((sensor): LinkableSensor => {
        // Create display name with parent info if child sensor
        let displayName = sensor.name;
        if (sensor.parentId && sensor.dataPath) {
          displayName = `${sensor.name} (${sensor.dataPath})`;
        }

        return {
          ...sensor,
          isLinked: !!sensorNodeMap[sensor.id],
          linkedNodeId: sensorNodeMap[sensor.id],
          displayName,
        };
      });
  }, [sensors, sensorNodeMap]);

  // Filter by search term
  const filtered = useMemo(() => {
    if (!searchTerm) return enhancedSensors;
    const term = searchTerm.toLowerCase();
    return enhancedSensors.filter(
      (sensor) =>
        sensor.name.toLowerCase().includes(term) ||
        sensor.serialNumber?.toLowerCase().includes(term) ||
        sensor.type?.toLowerCase().includes(term) ||
        sensor.protocolCode?.toLowerCase().includes(term) ||
        sensor.location?.toLowerCase().includes(term)
    );
  }, [enhancedSensors, searchTerm]);

  // Group by sensor type
  const groupedByType = useMemo(() => {
    const groups: Record<string, LinkableSensor[]> = {};

    filtered.forEach((sensor) => {
      const type = sensor.type?.toLowerCase() || 'other';
      if (!groups[type]) {
        groups[type] = [];
      }
      groups[type].push(sensor);
    });

    return groups;
  }, [filtered]);

  // Get linked and unlinked sensors
  const linkedSensors = useMemo(() => {
    return enhancedSensors.filter((s) => s.isLinked);
  }, [enhancedSensors]);

  const unlinkedSensors = useMemo(() => {
    return enhancedSensors.filter((s) => !s.isLinked);
  }, [enhancedSensors]);

  // Statistics
  const linkedCount = linkedSensors.length;
  const unlinkedCount = unlinkedSensors.length;
  const totalCount = enhancedSensors.length;

  return {
    sensors: filtered,
    linkedSensors,
    unlinkedSensors,
    groupedByType,
    isLoading: loading,
    error,
    refetch,
    totalCount,
    linkedCount,
    unlinkedCount,
  };
}

/**
 * Hook to get a single sensor by ID with linking status
 */
export function useLinkableSensor(sensorId: string | undefined) {
  const sensorNodeMap = useProcessStore((state) => state.sensorNodeMap);
  const { sensors, loading, error } = useSensorList();

  const sensor = useMemo(() => {
    if (!sensorId || !sensors) return null;

    const found = sensors.find((s) => s.id === sensorId);
    if (!found) return null;

    let displayName = found.name;
    if (found.parentId && found.dataPath) {
      displayName = `${found.name} (${found.dataPath})`;
    }

    return {
      ...found,
      isLinked: !!sensorNodeMap[found.id],
      linkedNodeId: sensorNodeMap[found.id],
      displayName,
    } as LinkableSensor;
  }, [sensorId, sensors, sensorNodeMap]);

  return {
    sensor,
    isLoading: loading,
    error,
  };
}

export type { RegisteredSensor };
