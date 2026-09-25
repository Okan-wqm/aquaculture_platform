import React from 'react';
import { Input, Select } from '@aquaculture/shared-ui';
import { TagBrowser } from '../TagBrowser';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

export const DirtyWaterTankConfig: React.FC<WidgetConfigProps> = ({
  config,
  onChange,
  deviceId,
}) => {
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
        placeholder="Dirty Water Tank"
      />
      <Input
        label="Demo Level (%)"
        fullWidth
        type="number"
        min={0}
        max={100}
        value={config.demoLevel ?? 55}
        onChange={(e) => onChange({ demoLevel: Number(e.target.value) })}
      />
      <Select
        label="Demo Status"
        fullWidth
        options={[
          { value: 'running', label: 'Running' },
          { value: 'stopped', label: 'Stopped' },
        ]}
        value={config.demoStatus || 'running'}
        onChange={(e) => onChange({ demoStatus: e.target.value })}
      />
    </div>
  );
};
