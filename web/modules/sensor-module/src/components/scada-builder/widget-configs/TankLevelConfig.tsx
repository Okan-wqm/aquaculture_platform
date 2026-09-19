import React from 'react';
import { Input } from '@aquaculture/shared-ui';
import { TagBrowser } from '../TagBrowser';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

export const TankLevelConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
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
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Label</label>
        <Input fullWidth type="text" value={config.label || ''} onChange={(e) => onChange({ label: e.target.value })} placeholder="Tank Level" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Min</label>
          <Input fullWidth type="number" value={config.min ?? 0} onChange={(e) => onChange({ min: Number(e.target.value) })} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Max</label>
          <Input fullWidth type="number" value={config.max ?? 100} onChange={(e) => onChange({ max: Number(e.target.value) })} />
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Unit</label>
        <Input fullWidth type="text" value={config.unit || ''} onChange={(e) => onChange({ unit: e.target.value })} placeholder="L" />
      </div>
    </div>
  );
};
