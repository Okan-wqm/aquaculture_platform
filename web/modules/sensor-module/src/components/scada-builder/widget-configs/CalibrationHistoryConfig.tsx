import React from 'react';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
}

export const CalibrationHistoryConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Baslik</label>
        <input
          type="text"
          value={config.title || ''}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="Kalibrasyon Gecmisi"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
    </div>
  );
};
