/**
 * RAS Flow Diagram Widget
 *
 * Displays the Recirculating Aquaculture System (RAS) flow diagram
 * with real-time component status indicators from sensor-service.
 */

import React, { useMemo } from 'react';
import { Card } from '@aquaculture/shared-ui';
import { useSensorsList, useLatestSensorReadings } from '../hooks/useDashboardData';
import type { SensorSummary, SensorReadingData } from '../hooks/useDashboardData';

export interface RASFlowDiagramProps {
  farmId?: string;
  systemId?: string;
  className?: string;
}

/** Status badge color mapping */
function getStatusColor(status: string): string {
  switch (status.toUpperCase()) {
    case 'ACTIVE':
      return 'bg-green-500';
    case 'INACTIVE':
    case 'OFFLINE':
      return 'bg-gray-400';
    case 'MAINTENANCE':
      return 'bg-yellow-500';
    case 'ERROR':
    case 'FAULT':
      return 'bg-red-500';
    default:
      return 'bg-gray-300';
  }
}

/** Determine reading health based on value ranges */
function getReadingHealth(readings: SensorReadingData['readings']): 'normal' | 'warning' | 'critical' {
  const { ph, dissolvedOxygen, temperature } = readings;

  if (ph !== undefined && ph !== null) {
    if (ph < 6.0 || ph > 9.0) return 'critical';
    if (ph < 6.5 || ph > 8.5) return 'warning';
  }

  if (dissolvedOxygen !== undefined && dissolvedOxygen !== null) {
    if (dissolvedOxygen < 3.0) return 'critical';
    if (dissolvedOxygen < 5.0) return 'warning';
  }

  if (temperature !== undefined && temperature !== null) {
    if (temperature < 15 || temperature > 32) return 'critical';
    if (temperature < 18 || temperature > 28) return 'warning';
  }

  return 'normal';
}

const healthColorMap = {
  normal: 'text-green-600 bg-green-50 border-green-200',
  warning: 'text-yellow-600 bg-yellow-50 border-yellow-200',
  critical: 'text-red-600 bg-red-50 border-red-200',
};

/** Sensor card within the RAS diagram */
const SensorNode: React.FC<{
  sensor: SensorSummary;
  reading?: SensorReadingData;
}> = ({ sensor, reading }) => {
  const health = reading ? getReadingHealth(reading.readings) : 'normal';
  const colorClass = healthColorMap[health];

  return (
    <div className={`border rounded-lg p-2 text-xs ${colorClass}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium truncate max-w-[100px]">{sensor.name}</span>
        <span className={`w-2 h-2 rounded-full ${getStatusColor(sensor.status)}`} />
      </div>
      {reading ? (
        <div className="space-y-0.5">
          {reading.readings.temperature != null && (
            <div className="flex justify-between">
              <span className="text-gray-500">Sic:</span>
              <span>{reading.readings.temperature.toFixed(1)}C</span>
            </div>
          )}
          {reading.readings.ph != null && (
            <div className="flex justify-between">
              <span className="text-gray-500">pH:</span>
              <span>{reading.readings.ph.toFixed(1)}</span>
            </div>
          )}
          {reading.readings.dissolvedOxygen != null && (
            <div className="flex justify-between">
              <span className="text-gray-500">O2:</span>
              <span>{reading.readings.dissolvedOxygen.toFixed(1)}</span>
            </div>
          )}
        </div>
      ) : (
        <p className="text-gray-400">Okuma yok</p>
      )}
    </div>
  );
};

export const RASFlowDiagram: React.FC<RASFlowDiagramProps> = ({
  farmId,
  systemId,
  className = '',
}) => {
  // Fetch sensors for this farm (or all sensors if no farmId)
  const sensorsQuery = useSensorsList();

  // Filter sensors for the given farm
  const farmSensors = useMemo(() => {
    if (!sensorsQuery.data) return [];
    if (farmId) {
      return sensorsQuery.data.filter((s) => s.farmId === farmId).slice(0, 12);
    }
    return sensorsQuery.data.slice(0, 12); // Limit to 12 for layout
  }, [sensorsQuery.data, farmId]);

  const sensorIds = useMemo(() => farmSensors.map((s) => s.id), [farmSensors]);
  const readingsQuery = useLatestSensorReadings(sensorIds);

  // Map readings by sensorId for quick lookup
  const readingsMap = useMemo(() => {
    const map = new Map<string, SensorReadingData>();
    if (readingsQuery.data) {
      for (const r of readingsQuery.data) {
        map.set(r.sensorId, r);
      }
    }
    return map;
  }, [readingsQuery.data]);

  // Loading state
  if (sensorsQuery.isLoading) {
    return (
      <Card className={`p-4 ${className}`}>
        <div className="animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/3 mb-3" />
          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="h-16 bg-gray-200 rounded" />
            ))}
          </div>
        </div>
      </Card>
    );
  }

  // No sensors state
  if (farmSensors.length === 0) {
    return (
      <Card className={`p-4 ${className}`}>
        <div className="text-center py-6 text-gray-500">
          <svg className="w-8 h-8 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <p className="text-sm font-medium">RAS Akis Diyagrami</p>
          {farmId && <p className="text-xs mt-1">Ciftlik: {farmId.slice(0, 8)}</p>}
          <p className="text-xs mt-2">Bu ciftlikte kayitli sensor bulunamadi</p>
        </div>
      </Card>
    );
  }

  // Active sensor count
  const activeSensors = farmSensors.filter(
    (s) => s.status === 'ACTIVE' || s.status === 'active',
  ).length;

  return (
    <Card className={`p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">RAS Akis Diyagrami</h3>
          {farmId && <p className="text-xs text-gray-500">Ciftlik: {farmId.slice(0, 8)}</p>}
        </div>
        <span className="text-xs text-gray-500">
          {activeSensors}/{farmSensors.length} aktif
        </span>
      </div>

      {/* Sensor grid -- represents RAS flow components */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {farmSensors.map((sensor) => (
          <SensorNode
            key={sensor.id}
            sensor={sensor}
            reading={readingsMap.get(sensor.id)}
          />
        ))}
      </div>

      {/* Flow arrows (simplified) */}
      {farmSensors.length > 1 && (
        <div className="flex items-center justify-center mt-3 space-x-1 text-gray-400">
          <span className="text-xs">Tank</span>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
          <span className="text-xs">Filtre</span>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
          <span className="text-xs">Pompa</span>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
          <span className="text-xs">Tank</span>
        </div>
      )}
    </Card>
  );
};

export default RASFlowDiagram;
