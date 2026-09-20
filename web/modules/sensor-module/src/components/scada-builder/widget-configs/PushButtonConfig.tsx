import React from 'react';
import { Input, Select } from '@aquaculture/shared-ui';
import { TagBrowser } from '../TagBrowser';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

export const PushButtonConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
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
        placeholder="Start"
      />
      <Select
        label="Button Mode"
        fullWidth
        options={[
          { value: 'momentary', label: 'Momentary - press &amp; release' },
          { value: 'toggle', label: 'Toggle - on/off persistent' },
        ]}
        value={config.mode || 'momentary'}
        onChange={(e) => onChange({ mode: e.target.value })}
      />
      <Input
        label="Value to Send"
        fullWidth
        type="text"
        value={config.value ?? ''}
        onChange={(e) => onChange({ value: e.target.value })}
        placeholder="1"
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
