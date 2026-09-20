import React from 'react';
import { Input } from '@aquaculture/shared-ui';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
}

export const EmergencyStopConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  return (
    <div className="space-y-3">
      <Input
        label="Hold Duration (ms)"
        fullWidth
        type="number"
        min={500}
        step={100}
        value={config.holdDuration ?? 2000}
        onChange={(e) => onChange({ holdDuration: Number(e.target.value) })}
      />
      <Input
        label="Label"
        fullWidth
        type="text"
        value={config.label || ''}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="EMERGENCY STOP"
      />
    </div>
  );
};
