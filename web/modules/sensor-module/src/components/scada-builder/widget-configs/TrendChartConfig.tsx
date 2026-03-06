import React from 'react';
import { TagBrowser } from '../TagBrowser';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

export const TrendChartConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const tags: string[] = config.tags || [];

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
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-gray-500">Tags</label>
          <button onClick={addTag} className="text-xs text-cyan-600 hover:text-cyan-700">
            + Tag Ekle
          </button>
        </div>
        <div className="space-y-1">
          {tags.map((tag, i) => (
            <div key={i} className="flex items-center gap-1">
              <TagBrowser
                deviceId={deviceId || null}
                value={tag}
                onChange={(val) => updateTag(i, val)}
                placeholder="Tag secin..."
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
            <p className="text-xs text-gray-400">Henuz tag eklenmedi</p>
          )}
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Varsayilan Aralik</label>
        <select
          value={config.defaultRange || '1h'}
          onChange={(e) => onChange({ defaultRange: e.target.value })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        >
          <option value="15m">15 Dakika</option>
          <option value="1h">1 Saat</option>
          <option value="6h">6 Saat</option>
          <option value="24h">24 Saat</option>
          <option value="7d">7 Gun</option>
          <option value="30d">30 Gun</option>
        </select>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="showLegend"
          checked={config.showLegend ?? true}
          onChange={(e) => onChange({ showLegend: e.target.checked })}
          className="text-cyan-600 rounded focus:ring-cyan-500"
        />
        <label htmlFor="showLegend" className="text-sm text-gray-700">Legend goster</label>
      </div>
    </div>
  );
};
