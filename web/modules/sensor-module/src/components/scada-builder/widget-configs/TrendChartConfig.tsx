import React from 'react';
import { Button, Select } from '@aquaculture/shared-ui';
import { TagBrowser } from '../TagBrowser';

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

export const TrendChartConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const tags: string[] = (config.tags as string[]) || [];
  const showGrid = (config.showGrid as boolean) ?? true;
  const showLegend = (config.showLegend as boolean) ?? true;

  const addTag = () => {
    onChange({ tags: [...tags, ''] });
  };

  const updateTag = (index: number, value: string) => {
    const updated = tags.map((t, i) => (i === index ? value : t));
    onChange({ tags: updated });
  };

  const removeTag = (index: number) => {
    onChange({ tags: tags.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-3">
      {/* Tag list */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-gray-500 dark:text-gray-400">Tags</label>
          <Button variant="ghost" size="xs" onClick={addTag}>+ Add Tag</Button>
        </div>
        <div className="space-y-1">
          {tags.map((tag, i) => (
            <div key={i} className="flex items-center gap-1">
              <TagBrowser
                deviceId={deviceId || null}
                value={tag}
                onChange={(val) => updateTag(i, val)}
                placeholder="Select tag..."
              />
              <Button variant="ghost" size="xs" onClick={() => removeTag(i)}>X</Button>
            </div>
          ))}
          {tags.length === 0 && (
            <p className="text-xs text-gray-400 dark:text-gray-500 italic">No tags added yet</p>
          )}
        </div>
      </div>

      {/* Default time range */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Default Time Range</label>
        <Select fullWidth options={[{ value: '1h', label: '1 Hour' }, { value: '6h', label: '6 Hours' }, { value: '24h', label: '24 Hours' }, { value: '7d', label: '7 Days' }, { value: '30d', label: '30 Days' }]} value={(config.defaultRange as string) || '24h'} onChange={(e) => onChange({ defaultRange: e.target.value })} />
      </div>

      {/* Show grid */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="showGrid"
          checked={showGrid}
          onChange={(e) => onChange({ showGrid: e.target.checked })}
          className="text-cyan-600 rounded focus:ring-cyan-500"
        />
        <label htmlFor="showGrid" className="text-sm text-gray-700 dark:text-gray-300">Show grid</label>
      </div>

      {/* Show legend */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="showLegend"
          checked={showLegend}
          onChange={(e) => onChange({ showLegend: e.target.checked })}
          className="text-cyan-600 rounded focus:ring-cyan-500"
        />
        <label htmlFor="showLegend" className="text-sm text-gray-700 dark:text-gray-300">Show legend</label>
      </div>

      {/* Chart height mode */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Chart Height Mode</label>
        <Select fullWidth options={[{ value: 'auto', label: 'Auto' }, { value: 'fixed', label: 'Fixed' }]} value={(config.chartHeightMode as string) || 'auto'} onChange={(e) => onChange({ chartHeightMode: e.target.value })} />
      </div>
    </div>
  );
};
