import React from 'react';
import { Input, Select } from '@aquaculture/shared-ui';
import { TagBrowser } from '../TagBrowser';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

export const SliderConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
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
        placeholder="Valve Position"
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        <Input
          label="Min"
          fullWidth
          type="number"
          value={config.min ?? 0}
          onChange={(e) => onChange({ min: Number(e.target.value) })}
        />
        <Input
          label="Max"
          fullWidth
          type="number"
          value={config.max ?? 100}
          onChange={(e) => onChange({ max: Number(e.target.value) })}
        />
        <Input
          label="Step"
          fullWidth
          type="number"
          value={config.step ?? 1}
          onChange={(e) => onChange({ step: Number(e.target.value) })}
        />
      </div>
      <Input
        label="Unit"
        fullWidth
        type="text"
        value={config.unit || ''}
        onChange={(e) => onChange({ unit: e.target.value })}
        placeholder="%"
      />
      <Select
        label="Security Level"
        fullWidth
        options={[
          { value: 'none', label: 'None' },
          { value: 'confirm', label: 'Confirmation Required' },
          { value: 'pin', label: 'PIN Required' },
        ]}
        value={config.security || 'none'}
        onChange={(e) => onChange({ security: e.target.value })}
      />
    </div>
  );
};
