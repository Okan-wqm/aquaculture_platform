import React from 'react';
import { Input } from '@aquaculture/shared-ui';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
}

export const AlarmListConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  return (
    <div className="space-y-3">
      <Input
        label="Title"
        fullWidth
        type="text"
        value={config.title || ''}
        onChange={(e) => onChange({ title: e.target.value })}
        placeholder="Alarm List"
      />
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="showActive"
          checked={config.showActive ?? true}
          onChange={(e) => onChange({ showActive: e.target.checked })}
          className="text-info-600 dark:text-info-400 rounded focus:ring-info-500"
        />
        <label htmlFor="showActive" className="text-sm text-gray-700 dark:text-gray-300">
          Show active alarms only
        </label>
      </div>
    </div>
  );
};
