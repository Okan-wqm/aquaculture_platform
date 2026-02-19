/**
 * Live Sensor Widget
 *
 * Displays real-time sensor readings for a specific sensor.
 * TODO: Wire to sensor-service GraphQL subscription for live data.
 */

import React from 'react';
import { Card } from '@aquaculture/shared-ui';
// PERF-L4: shared icon components — eliminates duplicate inline SVG bytes
import { SensorIcon } from '../components/icons';

export interface LiveSensorWidgetProps {
  sensorId?: string;
  sensorType?: string;
  className?: string;
}

export const LiveSensorWidget: React.FC<LiveSensorWidgetProps> = ({
  sensorId,
  sensorType,
  className = '',
}) => {
  return (
    <Card className={`p-4 ${className}`}>
      <div className="text-center py-6 text-gray-400">
        <SensorIcon className="w-8 h-8 mx-auto mb-2" />
        <p className="text-sm font-medium text-gray-500">
          {sensorType ? `${sensorType} Sensörü` : 'Canlı Sensör'}
        </p>
        {sensorId && (
          <p className="text-xs text-gray-400 mt-1">Sensör ID: {sensorId}</p>
        )}
        <p className="text-xs text-gray-400 mt-2">Veri bağlantısı kurulacak</p>
      </div>
    </Card>
  );
};

export default LiveSensorWidget;
