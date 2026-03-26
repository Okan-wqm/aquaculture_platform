/**
 * BarChartConfig - Property panel for the BarChart widget.
 * Manages multi-source tag bindings, orientation, axis settings,
 * and display options for the SVG bar chart.
 */

import React from 'react';
import { TagBrowser } from '../TagBrowser';

interface BarSource {
  tagName: string;
  label: string;
  color: string;
}

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

const DEFAULT_COLORS = [
  '#06b6d4', '#8b5cf6', '#f59e0b', '#ef4444', '#22c55e',
  '#ec4899', '#3b82f6', '#14b8a6',
];

export const BarChartConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const sources: BarSource[] = (config.sources as BarSource[]) || [];

  const addSource = () => {
    const idx = sources.length;
    onChange({
      sources: [
        ...sources,
        { tagName: '', label: `Bar ${idx + 1}`, color: DEFAULT_COLORS[idx % DEFAULT_COLORS.length] },
      ],
    });
  };

  const updateSource = (index: number, field: keyof BarSource, value: string) => {
    const updated = sources.map((s, i) =>
      i === index ? { ...s, [field]: value } : s,
    );
    onChange({ sources: updated });
  };

  const removeSource = (index: number) => {
    onChange({ sources: sources.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-3">
      {/* Label */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={(config.label as string) || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Bar Chart"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>

      {/* Orientation */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Orientation</label>
        <select
          value={(config.orientation as string) || 'vertical'}
          onChange={(e) => onChange({ orientation: e.target.value })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        >
          <option value="vertical">Vertical</option>
          <option value="horizontal">Horizontal</option>
        </select>
      </div>

      {/* Y Axis range */}
      <div>
        <label className="flex items-center gap-2 text-xs text-gray-500 mb-1">
          <input
            type="checkbox"
            checked={(config.autoScale as boolean) ?? true}
            onChange={(e) => onChange({ autoScale: e.target.checked })}
            className="rounded border-gray-300"
          />
          Auto-scale Y Axis
        </label>
      </div>

      {!config.autoScale && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Y Min</label>
            <input
              type="number"
              value={(config.yAxisMin as number) ?? 0}
              onChange={(e) => onChange({ yAxisMin: Number(e.target.value) })}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Y Max</label>
            <input
              type="number"
              value={(config.yAxisMax as number) ?? 100}
              onChange={(e) => onChange({ yAxisMax: Number(e.target.value) })}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
            />
          </div>
        </div>
      )}

      {/* Display toggles */}
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={(config.showGrid as boolean) ?? true}
            onChange={(e) => onChange({ showGrid: e.target.checked })}
            className="rounded border-gray-300"
          />
          Show Grid
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={(config.showLabels as boolean) ?? true}
            onChange={(e) => onChange({ showLabels: e.target.checked })}
            className="rounded border-gray-300"
          />
          Show Labels
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={(config.showValues as boolean) ?? true}
            onChange={(e) => onChange({ showValues: e.target.checked })}
            className="rounded border-gray-300"
          />
          Show Values
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={(config.animate as boolean) ?? true}
            onChange={(e) => onChange({ animate: e.target.checked })}
            className="rounded border-gray-300"
          />
          Animate
        </label>
      </div>

      {/* Bar spacing */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Bar Spacing (px)</label>
        <input
          type="number"
          min={0}
          max={20}
          value={(config.barSpacing as number) ?? 4}
          onChange={(e) => onChange({ barSpacing: Number(e.target.value) })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>

      {/* Data sources */}
      <div className="pt-2 border-t border-gray-100">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-gray-500 font-medium">Data Sources</label>
          <button
            onClick={addSource}
            className="text-xs text-cyan-600 hover:text-cyan-700"
          >
            + Add Source
          </button>
        </div>
        <div className="space-y-2">
          {sources.map((source, i) => (
            <div key={i} className="p-2 border border-gray-200 rounded-md space-y-1.5">
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={source.label}
                  onChange={(e) => updateSource(i, 'label', e.target.value)}
                  placeholder="Label"
                  className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded"
                />
                <input
                  type="color"
                  value={source.color}
                  onChange={(e) => updateSource(i, 'color', e.target.value)}
                  className="w-8 h-7 border border-gray-300 rounded cursor-pointer"
                />
                <button
                  onClick={() => removeSource(i)}
                  className="text-red-400 hover:text-red-600 text-xs px-1"
                >
                  X
                </button>
              </div>
              <TagBrowser
                deviceId={deviceId || null}
                value={source.tagName}
                onChange={(tagName) => updateSource(i, 'tagName', tagName)}
                placeholder="Select tag..."
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
