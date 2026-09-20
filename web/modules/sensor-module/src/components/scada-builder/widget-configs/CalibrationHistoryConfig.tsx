import React from 'react';
import { Input } from '@aquaculture/shared-ui';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
}

export const CalibrationHistoryConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  return (
    <div className="space-y-3">
      <Input
        label="Title"
        fullWidth
        type="text"
        value={config.title || ''}
        onChange={(e) => onChange({ title: e.target.value })}
        placeholder="Calibration History"
      />
    </div>
  );
};
