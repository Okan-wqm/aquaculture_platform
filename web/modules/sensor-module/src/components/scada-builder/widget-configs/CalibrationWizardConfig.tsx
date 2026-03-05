import React from 'react';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
}

export const CalibrationWizardConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
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
              <input
                type="text"
                value={sensor}
                onChange={(e) => updateSensor(i, e.target.value)}
                placeholder="sensor.ph"
                className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
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
