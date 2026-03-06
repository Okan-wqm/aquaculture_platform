import React from 'react';
import { TagBrowser } from '../TagBrowser';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

export const GaugeConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const zones: { min: number; max: number; color: string }[] = config.zones || [];

  const addZone = () => {
    onChange({ zones: [...zones, { min: 0, max: 100, color: '#22c55e' }] });
  };

  const updateZone = (index: number, field: string, value: any) => {
    const updated = zones.map((z, i) => (i === index ? { ...z, [field]: value } : z));
    onChange({ zones: updated });
  };

  const removeZone = (index: number) => {
    onChange({ zones: zones.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Tag</label>
        <TagBrowser
          deviceId={deviceId || null}
          value={config.tag || ''}
          onChange={(tag) => onChange({ tag })}
          placeholder="Tag secin..."
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Min</label>
          <input
            type="number"
            value={config.min ?? 0}
            onChange={(e) => onChange({ min: Number(e.target.value) })}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Max</label>
          <input
            type="number"
            value={config.max ?? 100}
            onChange={(e) => onChange({ max: Number(e.target.value) })}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Unit</label>
          <input
            type="text"
            value={config.unit || ''}
            onChange={(e) => onChange({ unit: e.target.value })}
            placeholder="°C"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Decimals</label>
          <input
            type="number"
            min={0}
            max={6}
            value={config.decimals ?? 1}
            onChange={(e) => onChange({ decimals: Number(e.target.value) })}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
      </div>

      <div className="pt-2 border-t border-gray-100">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-gray-500 font-medium">Zones</label>
          <button
            onClick={addZone}
            className="text-xs text-cyan-600 hover:text-cyan-700"
          >
            + Zone Ekle
          </button>
        </div>
        <div className="space-y-2">
          {zones.map((zone, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="number"
                value={zone.min}
                onChange={(e) => updateZone(i, 'min', Number(e.target.value))}
                className="w-16 px-2 py-1 text-xs border border-gray-300 rounded"
                placeholder="Min"
              />
              <input
                type="number"
                value={zone.max}
                onChange={(e) => updateZone(i, 'max', Number(e.target.value))}
                className="w-16 px-2 py-1 text-xs border border-gray-300 rounded"
                placeholder="Max"
              />
              <input
                type="color"
                value={zone.color}
                onChange={(e) => updateZone(i, 'color', e.target.value)}
                className="w-8 h-7 border border-gray-300 rounded cursor-pointer"
              />
              <button
                onClick={() => removeZone(i)}
                className="text-red-400 hover:text-red-600 text-xs px-1"
              >
                X
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
