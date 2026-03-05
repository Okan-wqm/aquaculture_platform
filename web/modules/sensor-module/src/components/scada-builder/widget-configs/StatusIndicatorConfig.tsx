import React from 'react';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
}

export const StatusIndicatorConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Tag</label>
        <input
          type="text"
          value={config.tag || ''}
          onChange={(e) => onChange({ tag: e.target.value })}
          placeholder="pump.running"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={config.label || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Pompa Durumu"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">ON Label</label>
          <input
            type="text"
            value={config.onLabel || ''}
            onChange={(e) => onChange({ onLabel: e.target.value })}
            placeholder="Calisiyor"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">OFF Label</label>
          <input
            type="text"
            value={config.offLabel || ''}
            onChange={(e) => onChange({ offLabel: e.target.value })}
            placeholder="Durdu"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
      </div>
    </div>
  );
};
