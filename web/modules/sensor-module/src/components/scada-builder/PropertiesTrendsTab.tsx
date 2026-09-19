/**
 * SCADA Builder — Trends tab content
 * Extracted from PropertiesPanel for maintainability (<500 LOC rule).
 */

import React from 'react';
import { Button, Input } from '@aquaculture/shared-ui';

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
  const tags = trendConfig.tags ?? [];

  const addTrendTag = () => {
    onTrendConfigChange?.({ ...trendConfig, tags: [...tags, ''] });
  };

  const updateTrendTag = (index: number, value: string) => {
    const updated = tags.map((t, i) => (i === index ? value : t));
    onTrendConfigChange?.({ ...trendConfig, tags: updated });
  };

  const removeTrendTag = (index: number) => {
    onTrendConfigChange?.({
      ...trendConfig,
      tags: tags.filter((_, i) => i !== index),
    });
  };

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Trend Settings</h4>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Retention Period (days)</label>
        <Input fullWidth type="number" min={1} value={trendConfig.retentionDays} onChange={(e) => onTrendConfigChange?.({ ...trendConfig, retentionDays: Number(e.target.value) })} />
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Sampling Interval (sec)</label>
        <Input fullWidth type="number" min={1} value={trendConfig.sampleIntervalSec} onChange={(e) => onTrendConfigChange?.({ ...trendConfig, sampleIntervalSec: Number(e.target.value) })} />
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-gray-500 dark:text-gray-400">Tags</label>
          <Button variant="ghost" size="xs" onClick={addTrendTag}>+ Add Tag</Button>
        </div>
        <div className="space-y-1">
          {tags.map((tag, i) => (
            <div key={i} className="flex items-center gap-1">
              <Input type="text" value={tag} onChange={(e) => updateTrendTag(i, e.target.value)} placeholder="sensor.temperature" />
              <Button variant="ghost" size="xs" onClick={() => removeTrendTag(i)} aria-label="Remove trend tag">X</Button>
            </div>
          ))}
          {tags.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400 text-center py-2">No tags added yet</p>
          )}
        </div>
      </div>
    </div>
  );
};
