import React from 'react';
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
        <label className="block text-xs text-gray-500 mb-1">Tag</label>
        <TagBrowser
          deviceId={deviceId || null}
          value={config.tagName || ''}
          onChange={(tagName) => onChange({ tagName })}
          placeholder="Select tag..."
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={config.label || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Start"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Button Mode</label>
        <select
          value={config.mode || 'momentary'}
          onChange={(e) => onChange({ mode: e.target.value })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        >
          <option value="momentary">Momentary - press &amp; release</option>
          <option value="toggle">Toggle - on/off persistent</option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Value to Send</label>
        <input
          type="text"
          value={config.value ?? ''}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder="1"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Security Level</label>
        <select
          value={config.security || 'none'}
          onChange={(e) => onChange({ security: e.target.value })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        >
          <option value="none">None</option>
          <option value="confirm">Confirmation Required</option>
          <option value="pin">PIN Required</option>
        </select>
      </div>
    </div>
  );
};
