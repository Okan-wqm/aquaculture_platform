/**
 * SCADA Builder — Trends tab content
 * Extracted from PropertiesPanel for maintainability (<500 LOC rule).
 */

import React from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrendConfig {
  retentionDays: number;
  sampleIntervalSec: number;
  tags: string[];
}

interface PropertiesTrendsTabProps {
  trendConfig: TrendConfig;
  onTrendConfigChange?: (config: TrendConfig) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PropertiesTrendsTab: React.FC<PropertiesTrendsTabProps> = ({
  trendConfig,
  onTrendConfigChange,
}) => {
  const addTrendTag = () => {
    onTrendConfigChange?.({ ...trendConfig, tags: [...trendConfig.tags, ''] });
  };

  const updateTrendTag = (index: number, value: string) => {
    const updated = trendConfig.tags.map((t, i) => (i === index ? value : t));
    onTrendConfigChange?.({ ...trendConfig, tags: updated });
  };

  const removeTrendTag = (index: number) => {
    onTrendConfigChange?.({
      ...trendConfig,
      tags: trendConfig.tags.filter((_, i) => i !== index),
    });
  };

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium text-gray-700">Trend Settings</h4>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Retention Period (days)</label>
        <input
          type="number"
          min={1}
          value={trendConfig.retentionDays}
          onChange={(e) => onTrendConfigChange?.({ ...trendConfig, retentionDays: Number(e.target.value) })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Sampling Interval (sec)</label>
        <input
          type="number"
          min={1}
          value={trendConfig.sampleIntervalSec}
          onChange={(e) => onTrendConfigChange?.({ ...trendConfig, sampleIntervalSec: Number(e.target.value) })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-gray-500">Tags</label>
          <button onClick={addTrendTag} className="text-xs text-cyan-600 hover:text-cyan-700">
            + Add Tag
          </button>
        </div>
        <div className="space-y-1">
          {trendConfig.tags.map((tag, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="text"
                value={tag}
                onChange={(e) => updateTrendTag(i, e.target.value)}
                placeholder="sensor.temperature"
                className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              />
              <button
                onClick={() => removeTrendTag(i)}
                aria-label="Remove trend tag"
                className="text-red-400 hover:text-red-600 text-xs px-1"
              >
                X
              </button>
            </div>
          ))}
          {trendConfig.tags.length === 0 && (
            <p className="text-xs text-gray-500 text-center py-2">No tags added yet</p>
          )}
        </div>
      </div>
    </div>
  );
};
