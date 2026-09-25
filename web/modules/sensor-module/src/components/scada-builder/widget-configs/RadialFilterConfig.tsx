import React from 'react';
import { Input, Select } from '@aquaculture/shared-ui';
import { TagBrowser } from '../TagBrowser';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

export const RadialFilterConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Tag</label>
        <TagBrowser
          deviceId={deviceId || null}
          value={config.tagName || ''}
          onChange={(tagName) => onChange({ tagName })}
          placeholder="Select tag..."
        />
      </div>
      <Input
        label="Label"
        fullWidth
        type="text"
        value={config.label || ''}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Radial Filter"
      />
      <Select
        label="Demo Status"
        fullWidth
        options={[
          { value: 'running', label: 'Running' },
          { value: 'stopped', label: 'Stopped' },
          { value: 'error', label: 'Error' },
        ]}
        value={config.demoStatus || 'running'}
        onChange={(e) => onChange({ demoStatus: e.target.value })}
      />
    </div>
  );
};
