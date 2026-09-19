import React from 'react';
import { TagBrowser } from '../TagBrowser';
import { RangeColorMapping } from './RangeColorMapping';
import type { ColorRange } from '../../../engine/animation/types';
import { colors, Button, Input } from '@aquaculture/shared-ui';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

export const StatusIndicatorConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
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
        <Input fullWidth type="text" value={config.label || ''} onChange={(e) => onChange({ label: e.target.value })} placeholder="Pump Status" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Active Color</label>
          <div className="flex gap-1">
            {[
              { label: 'Green', value: colors.success[500] },
              { label: 'Red', value: colors.error[500] },
              { label: 'Yellow', value: colors.warning[500] },
              { label: 'Blue', value: colors.info[500] },
              { label: 'Orange', value: colors.accent[600] },
            ].map((c) => (
              <Button variant="ghost" key={c.value} type="button" title={c.label} onClick={() => onChange({ activeColor: c.value })} style={{
                  width: 24, height: 24, borderRadius: '50%', background: c.value, border: config.activeColor === c.value ? '2px solid #111' : '2px solid transparent',
                  cursor: 'pointer',
                }}></Button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Inactive Color</label>
          <div className="flex gap-1">
            {[
              { label: 'Gray', value: colors.neutral[400] },
              { label: 'Dark Gray', value: colors.neutral[600] },
              { label: 'Red', value: colors.error[500] },
            ].map((c) => (
              <Button variant="ghost" key={c.value} type="button" title={c.label} onClick={() => onChange({ inactiveColor: c.value })} style={{
                  width: 24, height: 24, borderRadius: '50%', background: c.value, border: config.inactiveColor === c.value ? '2px solid #111' : '2px solid transparent',
                  cursor: 'pointer',
                }}></Button>
            ))}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">ON Label</label>
          <Input fullWidth type="text" value={config.onLabel || ''} onChange={(e) => onChange({ onLabel: e.target.value })} placeholder="Running" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">OFF Label</label>
          <Input fullWidth type="text" value={config.offLabel || ''} onChange={(e) => onChange({ offLabel: e.target.value })} placeholder="Stopped" />
        </div>
      </div>

      {/* Value-driven color ranges for analog tag values */}
      <div className="pt-2 border-t border-gray-100 dark:border-gray-700">
        <RangeColorMapping
          ranges={(config.colorRanges as ColorRange[]) || []}
          onChange={(colorRanges) => onChange({ colorRanges })}
          showLabel
          maxRanges={8}
        />
      </div>
    </div>
  );
};
