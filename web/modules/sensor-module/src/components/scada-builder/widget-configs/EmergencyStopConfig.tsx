import React from 'react';
import { Input } from '@aquaculture/shared-ui';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
}

export const EmergencyStopConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Hold Duration (ms)</label>
        <Input fullWidth type="number" min={500} step={100} value={config.holdDuration ?? 2000} onChange={(e) => onChange({ holdDuration: Number(e.target.value) })} />
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Label</label>
        <Input fullWidth type="text" value={config.label || ''} onChange={(e) => onChange({ label: e.target.value })} placeholder="EMERGENCY STOP" />
      </div>
    </div>
  );
};
