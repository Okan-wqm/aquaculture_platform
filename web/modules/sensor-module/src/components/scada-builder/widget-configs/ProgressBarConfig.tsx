/**
 * ProgressBarConfig - Configuration panel for the ProgressBar widget.
 *
 * Provides tag binding via TagBrowser, min/max range, visual styling
 * (colors, border radius, bar height), label positioning, and color
 * zone definitions for value-driven fill color changes.
 *
 * The zone system uses RangeColorMapping: each zone defines a
 * percentage range and color. At runtime, the first matching zone
 * determines the bar's fill color. This enables classic industrial
 * patterns like green=normal, yellow=warning, red=alarm.
 */

import React from 'react';
import { TagBrowser } from '../TagBrowser';
import { ExpressionBindingSection } from './ExpressionBindingSection';

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

interface ColorZone {
  min: number;
  max: number;
  color: string;
}

type LabelPosition = 'inside' | 'above' | 'below';

const LABEL_POSITION_OPTIONS: { value: LabelPosition; label: string }[] = [
  { value: 'inside', label: 'Inside' },
  { value: 'above', label: 'Above' },
  { value: 'below', label: 'Below' },
];

const INPUT_CLS = 'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

export const ProgressBarConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const min = (config.min ?? 0) as number;
  const max = (config.max ?? 100) as number;
  const showLabel = (config.showLabel ?? true) as boolean;
  const showPercentage = (config.showPercentage ?? true) as boolean;
  const barHeight = (config.height ?? 24) as number;
  const backgroundColor = (config.backgroundColor ?? '#e5e7eb') as string;
  const fillColor = (config.fillColor ?? '#3b82f6') as string;
  const zones = (config.zones ?? []) as ColorZone[];
  const borderRadius = (config.borderRadius ?? 4) as number;
  const labelPosition = (config.labelPosition ?? 'inside') as LabelPosition;
  const label = (config.label ?? '') as string;

  /* ---------------------------------------------------------------- */
  /*  Zone CRUD                                                        */
  /* ---------------------------------------------------------------- */

  const addZone = () => {
    onChange({ zones: [...zones, { min: 0, max: 50, color: '#22c55e' }] });
  };

  const updateZone = (index: number, field: keyof ColorZone, value: string | number) => {
    const updated = zones.map((z, i) =>
      i === index ? { ...z, [field]: value } : z,
    );
    onChange({ zones: updated });
  };

  const removeZone = (index: number) => {
    onChange({ zones: zones.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-3">
      {/* Tag binding */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Tag</label>
        <TagBrowser
          deviceId={deviceId || null}
          value={(config.tagName ?? '') as string}
          onChange={(tagName) => onChange({ tagName })}
          placeholder="Select tag..."
        />
      </div>

      {/* Expression binding for computed values */}
      <ExpressionBindingSection
        expression={config.expression as string | undefined}
        onChange={(expr) => onChange({ expression: expr })}
        deviceId={deviceId}
      />

      {/* Label */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Progress"
          className={INPUT_CLS}
        />
      </div>

      {/* Range */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Min</label>
          <input
            type="number"
            value={min}
            onChange={(e) => onChange({ min: Number(e.target.value) })}
            className={INPUT_CLS}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Max</label>
          <input
            type="number"
            value={max}
            onChange={(e) => onChange({ max: Number(e.target.value) })}
            className={INPUT_CLS}
          />
        </div>
      </div>

      {/* Bar dimensions */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Bar Height (px)</label>
          <input
            type="number"
            min={8}
            max={80}
            value={barHeight}
            onChange={(e) => onChange({ height: Number(e.target.value) })}
            className={INPUT_CLS}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Border Radius</label>
          <input
            type="number"
            min={0}
            max={40}
            value={borderRadius}
            onChange={(e) => onChange({ borderRadius: Number(e.target.value) })}
            className={INPUT_CLS}
          />
        </div>
      </div>

      {/* Label position & toggles */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label Position</label>
        <select
          value={labelPosition}
          onChange={(e) => onChange({ labelPosition: e.target.value })}
          className={INPUT_CLS}
        >
          {LABEL_POSITION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={showLabel}
            onChange={(e) => onChange({ showLabel: e.target.checked })}
            className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
          />
          Show Label
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={showPercentage}
            onChange={(e) => onChange({ showPercentage: e.target.checked })}
            className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
          />
          Show Percentage
        </label>
      </div>

      {/* Colors */}
      <div className="pt-2 border-t border-gray-100">
        <label className="text-xs text-gray-500 font-medium mb-2 block">Colors</label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Background</label>
            <input
              type="color"
              value={backgroundColor}
              onChange={(e) => onChange({ backgroundColor: e.target.value })}
              className="w-full h-8 border border-gray-300 rounded cursor-pointer"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Fill Color</label>
            <input
              type="color"
              value={fillColor}
              onChange={(e) => onChange({ fillColor: e.target.value })}
              className="w-full h-8 border border-gray-300 rounded cursor-pointer"
            />
          </div>
        </div>
      </div>

      {/* Color Zones */}
      <div className="pt-2 border-t border-gray-100">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-gray-500 font-medium">Color Zones</label>
          <button onClick={addZone} className="text-xs text-cyan-600 hover:text-cyan-700">
            + Add Zone
          </button>
        </div>
        <p className="text-[10px] text-gray-400 mb-2">
          Zones define color ranges by percentage. First matching zone wins.
        </p>
        <div className="space-y-2">
          {zones.map((zone, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="number"
                value={zone.min}
                onChange={(e) => updateZone(i, 'min', Number(e.target.value))}
                className="w-16 px-2 py-1 text-xs border border-gray-300 rounded"
                placeholder="Min %"
              />
              <input
                type="number"
                value={zone.max}
                onChange={(e) => updateZone(i, 'max', Number(e.target.value))}
                className="w-16 px-2 py-1 text-xs border border-gray-300 rounded"
                placeholder="Max %"
              />
              <input
                type="color"
                value={zone.color}
                onChange={(e) => updateZone(i, 'color', e.target.value)}
                className="w-8 h-7 border border-gray-300 rounded cursor-pointer"
              />
              <button onClick={() => removeZone(i)} className="text-red-400 hover:text-red-600 text-xs px-1">
                X
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
