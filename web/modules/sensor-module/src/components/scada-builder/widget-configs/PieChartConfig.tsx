/**
 * PieChartConfig - Property panel for the PieChart widget.
 * Manages multi-source tag bindings, donut mode (innerRadius),
 * display options, and color assignments for each slice.
 */

import React from 'react';
import { TagBrowser } from '../TagBrowser';
import { colors, Button, Input } from '@aquaculture/shared-ui';

interface PieSource {
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
  colors.primary[400], colors.primary[700], colors.warning[500], colors.error[500], colors.success[500],
  colors.accent[500], colors.info[500], colors.secondary[600],
];

export const PieChartConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const sources: PieSource[] = (config.sources as PieSource[]) || [];

  const addSource = () => {
    const idx = sources.length;
    onChange({
      sources: [
        ...sources,
        { tagName: '', label: `Slice ${idx + 1}`, color: DEFAULT_COLORS[idx % DEFAULT_COLORS.length] },
      ],
    });
  };

  const updateSource = (index: number, field: keyof PieSource, value: string) => {
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
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Label</label>
        <Input fullWidth type="text" value={(config.label as string) || ''} onChange={(e) => onChange({ label: e.target.value })} placeholder="Pie Chart" />
      </div>

      {/* Inner radius (0 = pie, >0 = donut) */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
          Inner Radius (0 = Pie, &gt;0 = Donut)
        </label>
        <Input fullWidth type="number" min={0} max={100} value={(config.innerRadius as number) ?? 0} onChange={(e) => onChange({ innerRadius: Number(e.target.value) })} />
      </div>

      {/* Start angle */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Start Angle (degrees)</label>
        <Input fullWidth type="number" min={-360} max={360} value={(config.startAngle as number) ?? -90} onChange={(e) => onChange({ startAngle: Number(e.target.value) })} />
      </div>

      {/* Display toggles */}
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <input
            type="checkbox"
            checked={(config.showLabels as boolean) ?? true}
            onChange={(e) => onChange({ showLabels: e.target.checked })}
            className="rounded border-gray-300 dark:border-gray-600"
          />
          Show Percentage Labels
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <input
            type="checkbox"
            checked={(config.showLegend as boolean) ?? true}
            onChange={(e) => onChange({ showLegend: e.target.checked })}
            className="rounded border-gray-300 dark:border-gray-600"
          />
          Show Legend
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <input
            type="checkbox"
            checked={(config.showValues as boolean) ?? false}
            onChange={(e) => onChange({ showValues: e.target.checked })}
            className="rounded border-gray-300 dark:border-gray-600"
          />
          Show Values
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <input
            type="checkbox"
            checked={(config.animate as boolean) ?? true}
            onChange={(e) => onChange({ animate: e.target.checked })}
            className="rounded border-gray-300 dark:border-gray-600"
          />
          Animate
        </label>
      </div>

      {/* Data sources */}
      <div className="pt-2 border-t border-gray-100 dark:border-gray-700">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-gray-500 dark:text-gray-400 font-medium">Data Sources (Slices)</label>
          <Button variant="ghost" size="xs" onClick={addSource}>+ Add Slice</Button>
        </div>
        <div className="space-y-2">
          {sources.map((source, i) => (
            <div key={i} className="p-2 border border-gray-200 dark:border-gray-700 rounded-md space-y-1.5">
              <div className="flex items-center gap-1">
                <Input type="text" value={source.label} onChange={(e) => updateSource(i, 'label', e.target.value)} placeholder="Slice label" />
                <input
                  type="color"
                  value={source.color}
                  onChange={(e) => updateSource(i, 'color', e.target.value)}
                  className="w-8 h-7 border border-gray-300 dark:border-gray-600 rounded cursor-pointer"
                />
                <Button variant="ghost" size="xs" onClick={() => removeSource(i)}>X</Button>
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
