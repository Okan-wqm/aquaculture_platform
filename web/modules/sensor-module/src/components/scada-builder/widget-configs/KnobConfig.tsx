/**
 * KnobConfig - Property panel for the Knob (rotary input) widget.
 * Configures tag binding, value range, step size, angular sweep,
 * visual styling, and tick mark display.
 */

import React from 'react';
import { TagBrowser } from '../TagBrowser';

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
        <label className="block text-xs text-gray-500 mb-1">Tag</label>
        <TagBrowser
          deviceId={deviceId || null}
          value={(config.tagName as string) || ''}
          onChange={(tagName) => onChange({ tagName })}
          placeholder="Select tag..."
        />
      </div>

      {/* Label */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={(config.label as string) || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Knob"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>

      {/* Value range */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Min</label>
          <input
            type="number"
            value={(config.min as number) ?? 0}
            onChange={(e) => onChange({ min: Number(e.target.value) })}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Max</label>
          <input
            type="number"
            value={(config.max as number) ?? 100}
            onChange={(e) => onChange({ max: Number(e.target.value) })}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Step</label>
          <input
            type="number"
            value={(config.step as number) ?? 1}
            onChange={(e) => onChange({ step: Number(e.target.value) })}
            min={0.01}
            step={0.1}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
      </div>

      {/* Angular range */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Start Angle</label>
          <input
            type="number"
            value={(config.startAngle as number) ?? 30}
            onChange={(e) => onChange({ startAngle: Number(e.target.value) })}
            min={0}
            max={180}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">End Angle</label>
          <input
            type="number"
            value={(config.endAngle as number) ?? 330}
            onChange={(e) => onChange({ endAngle: Number(e.target.value) })}
            min={180}
            max={360}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
      </div>

      {/* Tick count */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Tick Count</label>
        <input
          type="number"
          value={(config.tickCount as number) ?? 11}
          onChange={(e) => onChange({ tickCount: Number(e.target.value) })}
          min={2}
          max={25}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>

      {/* Display toggles */}
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={(config.showValue as boolean) ?? true}
            onChange={(e) => onChange({ showValue: e.target.checked })}
            className="rounded border-gray-300"
          />
          Show Value
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={(config.showTicks as boolean) ?? true}
            onChange={(e) => onChange({ showTicks: e.target.checked })}
            className="rounded border-gray-300"
          />
          Show Ticks
        </label>
      </div>

      {/* Colors */}
      <div className="pt-2 border-t border-gray-100">
        <label className="text-xs text-gray-500 font-medium mb-2 block">Colors</label>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="block text-[10px] text-gray-400 mb-1">Knob</label>
            <input
              type="color"
              value={(config.knobColor as string) ?? '#374151'}
              onChange={(e) => onChange({ knobColor: e.target.value })}
              className="w-full h-7 border border-gray-300 rounded cursor-pointer"
            />
          </div>
          <div>
            <label className="block text-[10px] text-gray-400 mb-1">Track</label>
            <input
              type="color"
              value={(config.trackColor as string) ?? '#e5e7eb'}
              onChange={(e) => onChange({ trackColor: e.target.value })}
              className="w-full h-7 border border-gray-300 rounded cursor-pointer"
            />
          </div>
          <div>
            <label className="block text-[10px] text-gray-400 mb-1">Indicator</label>
            <input
              type="color"
              value={(config.indicatorColor as string) ?? '#06b6d4'}
              onChange={(e) => onChange({ indicatorColor: e.target.value })}
              className="w-full h-7 border border-gray-300 rounded cursor-pointer"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
