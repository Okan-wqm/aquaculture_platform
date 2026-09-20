/**
 * BarChartConfig - Property panel for the BarChart widget.
 * Manages multi-source tag bindings, orientation, axis settings,
 * and display options for the SVG bar chart.
 */

import React from 'react';
import { TagBrowser } from '../TagBrowser';
import { Button, ColorInput, Input, Select, colors, useI18n } from '@aquaculture/shared-ui';

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
  colors.primary[400],
  colors.primary[700],
  colors.warning[500],
  colors.error[500],
  colors.success[500],
  colors.accent[500],
  colors.info[500],
  colors.secondary[600],
];

export const BarChartConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const { t } = useI18n();
  const sources: BarSource[] = (config.sources as BarSource[]) || [];

  const addSource = () => {
    const idx = sources.length;
    onChange({
      sources: [
        ...sources,
        {
          tagName: '',
          label: `Bar ${idx + 1}`,
          color: DEFAULT_COLORS[idx % DEFAULT_COLORS.length],
        },
      ],
    });
  };

  const updateSource = (index: number, field: keyof BarSource, value: string) => {
    const updated = sources.map((s, i) => (i === index ? { ...s, [field]: value } : s));
    onChange({ sources: updated });
  };

  const removeSource = (index: number) => {
    onChange({ sources: sources.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-3">
      {/* Label */}
      <Input
        label="Label"
        fullWidth
        type="text"
        value={(config.label as string) || ''}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Bar Chart"
      />

      {/* Orientation */}
      <Select
        label="Orientation"
        fullWidth
        options={[
          { value: 'vertical', label: 'Vertical' },
          { value: 'horizontal', label: 'Horizontal' },
        ]}
        value={(config.orientation as string) || 'vertical'}
        onChange={(e) => onChange({ orientation: e.target.value })}
      />

      {/* Y Axis range */}
      <div>
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 mb-1">
          <input
            type="checkbox"
            checked={(config.autoScale as boolean) ?? true}
            onChange={(e) => onChange({ autoScale: e.target.checked })}
            className="rounded border-gray-300 dark:border-gray-600"
          />
          Auto-scale Y Axis
        </label>
      </div>

      {!config.autoScale && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Input
            label="Y Min"
            fullWidth
            type="number"
            value={(config.yAxisMin as number) ?? 0}
            onChange={(e) => onChange({ yAxisMin: Number(e.target.value) })}
          />
          <Input
            label="Y Max"
            fullWidth
            type="number"
            value={(config.yAxisMax as number) ?? 100}
            onChange={(e) => onChange({ yAxisMax: Number(e.target.value) })}
          />
        </div>
      )}

      {/* Display toggles */}
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <input
            type="checkbox"
            checked={(config.showGrid as boolean) ?? true}
            onChange={(e) => onChange({ showGrid: e.target.checked })}
            className="rounded border-gray-300 dark:border-gray-600"
          />
          Show Grid
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <input
            type="checkbox"
            checked={(config.showLabels as boolean) ?? true}
            onChange={(e) => onChange({ showLabels: e.target.checked })}
            className="rounded border-gray-300 dark:border-gray-600"
          />
          Show Labels
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <input
            type="checkbox"
            checked={(config.showValues as boolean) ?? true}
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

      {/* Bar spacing */}
      <Input
        label="Bar Spacing (px)"
        fullWidth
        type="number"
        min={0}
        max={20}
        value={(config.barSpacing as number) ?? 4}
        onChange={(e) => onChange({ barSpacing: Number(e.target.value) })}
      />

      {/* Data sources */}
      <div className="pt-2 border-t border-gray-100 dark:border-gray-700">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-gray-500 dark:text-gray-400 font-medium">
            Data Sources
          </label>
          <Button variant="ghost" size="xs" onClick={addSource}>
            + Add Source
          </Button>
        </div>
        <div className="space-y-2">
          {sources.map((source, i) => (
            <div
              key={i}
              className="p-2 border border-gray-200 dark:border-gray-700 rounded-md space-y-1.5"
            >
              <div className="flex items-center gap-1">
                <Input
                  type="text"
                  value={source.label}
                  onChange={(e) => updateSource(i, 'label', e.target.value)}
                  placeholder="Label"
                />
                <ColorInput
                  aria-label={t('scada.color.series')}
                  variant="swatch"
                  value={source.color}
                  onChange={(e) => updateSource(i, 'color', e.target.value)}
                />
                <Button variant="ghost" size="xs" onClick={() => removeSource(i)}>
                  X
                </Button>
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
