import React from 'react';
import { Input } from '@aquaculture/shared-ui';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
}

export const ProcessViewConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Proses ID</label>
        <Input
          fullWidth
          type="text"
          value={config.processId || ''}
          onChange={(e) => onChange({ processId: e.target.value })}
          placeholder="Enter Process ID"
        />
      </div>
    </div>
  );
};
