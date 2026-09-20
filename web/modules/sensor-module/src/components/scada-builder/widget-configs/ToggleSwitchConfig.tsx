import React from 'react';
import { Input, Select } from '@aquaculture/shared-ui';
import { TagBrowser } from '../TagBrowser';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

export const ToggleSwitchConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
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
        placeholder="Pump Control"
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Input
          label="ON Label"
          fullWidth
          type="text"
          value={config.onLabel || ''}
          onChange={(e) => onChange({ onLabel: e.target.value })}
          placeholder="On"
        />
        <Input
          label="OFF Label"
          fullWidth
          type="text"
          value={config.offLabel || ''}
          onChange={(e) => onChange({ offLabel: e.target.value })}
          placeholder="Close"
        />
      </div>
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
