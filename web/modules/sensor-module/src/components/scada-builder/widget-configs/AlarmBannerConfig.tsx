import React from 'react';
import { Input } from '@aquaculture/shared-ui';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
}

export const AlarmBannerConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  return (
    <div className="space-y-3">
      <Input
        label="Scroll Interval (s)"
        fullWidth
        type="number"
        min={1}
        value={config.scrollInterval ?? 5}
        onChange={(e) => onChange({ scrollInterval: Number(e.target.value) })}
      />
    </div>
  );
};
