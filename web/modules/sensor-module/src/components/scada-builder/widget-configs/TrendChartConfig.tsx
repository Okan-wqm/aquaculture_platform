import React from 'react';
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
          <label className="text-xs text-gray-500">Tags</label>
          <button onClick={addTag} className="text-xs text-cyan-600 hover:text-cyan-700">
            + Add Tag
          </button>
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
              <button
                onClick={() => removeTag(i)}
                className="text-red-400 hover:text-red-600 text-xs px-1"
              >
                X
              </button>
            </div>
          ))}
          {tags.length === 0 && (
            <p className="text-xs text-gray-400 italic">No tags added yet</p>
          )}
        </div>
      </div>

      {/* Default time range */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Default Time Range</label>
        <select
          value={(config.defaultRange as string) || '24h'}
          onChange={(e) => onChange({ defaultRange: e.target.value })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        >
          <option value="1h">1 Hour</option>
          <option value="6h">6 Hours</option>
          <option value="24h">24 Hours</option>
          <option value="7d">7 Days</option>
          <option value="30d">30 Days</option>
        </select>
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
        <label htmlFor="showGrid" className="text-sm text-gray-700">Show grid</label>
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
        <label htmlFor="showLegend" className="text-sm text-gray-700">Show legend</label>
      </div>

      {/* Chart height mode */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Chart Height Mode</label>
        <select
          value={(config.chartHeightMode as string) || 'auto'}
          onChange={(e) => onChange({ chartHeightMode: e.target.value })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        >
          <option value="auto">Auto</option>
          <option value="fixed">Fixed</option>
        </select>
      </div>
    </div>
  );
};
