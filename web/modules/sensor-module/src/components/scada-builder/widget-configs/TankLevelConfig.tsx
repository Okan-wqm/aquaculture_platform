import React from 'react';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
}

export const TankLevelConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Tag</label>
        <input
          type="text"
          value={config.tag || ''}
          onChange={(e) => onChange({ tag: e.target.value })}
          placeholder="tank.level"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={config.label || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Tank Seviye"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
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
      <div>
        <label className="block text-xs text-gray-500 mb-1">Unit</label>
        <input
          type="text"
          value={config.unit || ''}
          onChange={(e) => onChange({ unit: e.target.value })}
          placeholder="L"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
    </div>
  );
};
