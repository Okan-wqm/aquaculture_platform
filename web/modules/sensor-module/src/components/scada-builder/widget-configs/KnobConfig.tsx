/**
 * KnobConfig - Property panel for the Knob (rotary input) widget.
 * Configures tag binding, value range, step size, angular sweep,
 * visual styling, and tick mark display.
 */

import React from 'react';
import { TagBrowser } from '../TagBrowser';
import { Checkbox, ColorInput, colors, Input } from '@aquaculture/shared-ui';

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

export const KnobConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  return (
    <div className="space-y-3">
      {/* Tag binding */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Tag</label>
        <TagBrowser
          deviceId={deviceId || null}
          value={(config.tagName as string) || ''}
          onChange={(tagName) => onChange({ tagName })}
          placeholder="Select tag..."
        />
      </div>

      {/* Label */}
      <Input
        label="Label"
        fullWidth
        type="text"
        value={(config.label as string) || ''}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Knob"
      />

      {/* Value range */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        <Input
          label="Min"
          fullWidth
          type="number"
          value={(config.min as number) ?? 0}
          onChange={(e) => onChange({ min: Number(e.target.value) })}
        />
        <Input
          label="Max"
          fullWidth
          type="number"
          value={(config.max as number) ?? 100}
          onChange={(e) => onChange({ max: Number(e.target.value) })}
        />
        <Input
          label="Step"
          fullWidth
          type="number"
          value={(config.step as number) ?? 1}
          onChange={(e) => onChange({ step: Number(e.target.value) })}
          min={0.01}
          step={0.1}
        />
      </div>

      {/* Angular range */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Input
          label="Start Angle"
          fullWidth
          type="number"
          value={(config.startAngle as number) ?? 30}
          onChange={(e) => onChange({ startAngle: Number(e.target.value) })}
          min={0}
          max={180}
        />
        <Input
          label="End Angle"
          fullWidth
          type="number"
          value={(config.endAngle as number) ?? 330}
          onChange={(e) => onChange({ endAngle: Number(e.target.value) })}
          min={180}
          max={360}
        />
      </div>

      {/* Tick count */}
      <Input
        label="Tick Count"
        fullWidth
        type="number"
        value={(config.tickCount as number) ?? 11}
        onChange={(e) => onChange({ tickCount: Number(e.target.value) })}
        min={2}
        max={25}
      />

      {/* Display toggles */}
      <div className="space-y-1">
        <Checkbox
          label="Show Value"
          checked={(config.showValue as boolean) ?? true}
          onChange={(e) => onChange({ showValue: e.target.checked })}
        />
        <Checkbox
          label="Show Ticks"
          checked={(config.showTicks as boolean) ?? true}
          onChange={(e) => onChange({ showTicks: e.target.checked })}
        />
      </div>

      {/* Colors */}
      <div className="pt-2 border-t border-gray-100 dark:border-gray-700">
        <label className="text-xs text-gray-500 dark:text-gray-400 font-medium mb-2 block">
          Colors
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          <ColorInput
            label="Knob"
            value={(config.knobColor as string) ?? colors.neutral[700]}
            onChange={(e) => onChange({ knobColor: e.target.value })}
          />
          <ColorInput
            label="Track"
            value={(config.trackColor as string) ?? colors.neutral[200]}
            onChange={(e) => onChange({ trackColor: e.target.value })}
          />
          <ColorInput
            label="Indicator"
            value={(config.indicatorColor as string) ?? colors.primary[400]}
            onChange={(e) => onChange({ indicatorColor: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
};
