import React from 'react';
import { TagBrowser } from '../TagBrowser';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

export const CalibrationStatusConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const sensors: string[] = config.sensors || [];

  const addSensor = () => {
    onChange({ sensors: [...sensors, ''] });
  };

  const updateSensor = (index: number, value: string) => {
    const updated = sensors.map((s, i) => (i === index ? value : s));
    onChange({ sensors: updated });
  };

  const removeSensor = (index: number) => {
    onChange({ sensors: sensors.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-gray-500">Sensorler</label>
          <button onClick={addSensor} className="text-xs text-cyan-600 hover:text-cyan-700">
            + Sensor Ekle
          </button>
        </div>
        <div className="space-y-1">
          {sensors.map((sensor, i) => (
            <div key={i} className="flex items-center gap-1">
              <TagBrowser
                deviceId={deviceId || null}
                value={sensor}
                onChange={(val) => updateSensor(i, val)}
                placeholder="Tag secin..."
              />
              <button
                onClick={() => removeSensor(i)}
                className="text-red-400 hover:text-red-600 text-xs px-1"
              >
                X
              </button>
            </div>
          ))}
          {sensors.length === 0 && (
            <p className="text-xs text-gray-400">Henuz sensor eklenmedi</p>
          )}
        </div>
      </div>
    </div>
  );
};
