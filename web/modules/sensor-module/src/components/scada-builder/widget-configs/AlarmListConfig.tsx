import React from 'react';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
}

export const AlarmListConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Title</label>
        <input
          type="text"
          value={config.title || ''}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="Alarm List"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="showActive"
          checked={config.showActive ?? true}
          onChange={(e) => onChange({ showActive: e.target.checked })}
          className="text-cyan-600 rounded focus:ring-cyan-500"
        />
        <label htmlFor="showActive" className="text-sm text-gray-700">Show active alarms only</label>
      </div>
    </div>
  );
};
