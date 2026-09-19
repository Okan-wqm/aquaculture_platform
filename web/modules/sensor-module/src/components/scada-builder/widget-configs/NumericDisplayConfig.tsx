import React from 'react';
import { Input } from '@aquaculture/shared-ui';
import { TagBrowser } from '../TagBrowser';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

export const NumericDisplayConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
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
        <Input fullWidth type="text" value={config.label || ''} onChange={(e) => onChange({ label: e.target.value })} placeholder="Temperature" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Unit</label>
          <Input fullWidth type="text" value={config.unit || ''} onChange={(e) => onChange({ unit: e.target.value })} placeholder="°C" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Decimals</label>
          <Input fullWidth type="number" min={0} max={6} value={config.decimals ?? 1} onChange={(e) => onChange({ decimals: Number(e.target.value) })} />
        </div>
      </div>
    </div>
  );
};
