/**
 * Configure data acquisition (logging) settings for tags.
 * Determines which tags are logged to TimescaleDB and at what interval.
 *
 * Architecture: DAQ settings are stored per-tag in the SCADA package.
 * On deploy, the edge device reads these settings and configures
 * its local data collection accordingly.
 *
 * This panel provides a more capable interface than the basic Trends tab,
 * with per-tag intervals, deadband thresholds, and retention policies.
 * It can coexist with PropertiesTrendsTab or replace it in future versions.
 *
 * Design decision: DAQ configuration uses a flat array of DaqTagConfig
 * objects rather than a nested map, because the deployment serializer
 * needs to iterate over all configs linearly, and arrays are more
 * ergonomic for table-based UIs.
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  Database,
  Plus,
  Trash2,
  Upload,
  ToggleLeft,
  ToggleRight,
  Search,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DaqInterval = '1s' | '5s' | '15s' | '30s' | '1m' | '5m' | '15m' | '1h';
export type DaqRetention = '1d' | '7d' | '30d' | '90d' | '1y' | 'forever';

export interface DaqTagConfig {
  tagName: string;
  enabled: boolean;
  interval: DaqInterval;
  /** Absolute value change threshold — values within deadband are not logged. */
  deadband: number;
  retention: DaqRetention;
}

interface DaqConfigPanelProps {
  configs: DaqTagConfig[];
  onConfigsChange: (configs: DaqTagConfig[]) => void;
  /** Available tag names (from the package's bound tags). */
  availableTags?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTERVAL_OPTIONS: { value: DaqInterval; label: string }[] = [
  { value: '1s', label: '1 sec' },
  { value: '5s', label: '5 sec' },
  { value: '15s', label: '15 sec' },
  { value: '30s', label: '30 sec' },
  { value: '1m', label: '1 min' },
  { value: '5m', label: '5 min' },
  { value: '15m', label: '15 min' },
  { value: '1h', label: '1 hour' },
];

const RETENTION_OPTIONS: { value: DaqRetention; label: string }[] = [
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '1y', label: '1 year' },
  { value: 'forever', label: 'Forever' },
];

const DEFAULT_CONFIG: Omit<DaqTagConfig, 'tagName'> = {
  enabled: true,
  interval: '15s',
  deadband: 0,
  retention: '30d',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const DaqConfigPanel: React.FC<DaqConfigPanelProps> = ({
  configs,
  onConfigsChange,
  availableTags = [],
}) => {
  const [search, setSearch] = useState('');
  const [newTagName, setNewTagName] = useState('');

  // Tags that are configured but don't have a DAQ entry yet
  const unconfiguredTags = useMemo(
    () => availableTags.filter((t) => !configs.some((c) => c.tagName === t)),
    [availableTags, configs],
  );

  // Filtered configs for search
  const filtered = useMemo(() => {
    const term = search.toLowerCase();
    return term ? configs.filter((c) => c.tagName.toLowerCase().includes(term)) : configs;
  }, [configs, search]);

  // Add a new tag configuration
  const handleAddTag = useCallback(
    (tagName: string) => {
      if (!tagName.trim() || configs.some((c) => c.tagName === tagName)) return;
      onConfigsChange([...configs, { tagName: tagName.trim(), ...DEFAULT_CONFIG }]);
      setNewTagName('');
    },
    [configs, onConfigsChange],
  );

  // Remove a tag configuration
  const handleRemoveTag = useCallback(
    (tagName: string) => {
      onConfigsChange(configs.filter((c) => c.tagName !== tagName));
    },
    [configs, onConfigsChange],
  );

  // Update a single tag's configuration field
  const handleUpdate = useCallback(
    (tagName: string, updates: Partial<DaqTagConfig>) => {
      onConfigsChange(
        configs.map((c) => (c.tagName === tagName ? { ...c, ...updates } : c)),
      );
    },
    [configs, onConfigsChange],
  );

  // Bulk enable/disable all visible tags
  const handleBulkToggle = useCallback(
    (enabled: boolean) => {
      const visibleTags = new Set(filtered.map((c) => c.tagName));
      onConfigsChange(
        configs.map((c) => (visibleTags.has(c.tagName) ? { ...c, enabled } : c)),
      );
    },
    [configs, filtered, onConfigsChange],
  );

  // CSV import
  const handleCsvImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const lines = text.trim().split('\n').slice(1); // Skip header
        const imported: DaqTagConfig[] = [];

        for (const line of lines) {
          const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
          if (cols.length >= 1 && cols[0]) {
            imported.push({
              tagName: cols[0],
              enabled: cols[1]?.toLowerCase() !== 'false',
              interval: (cols[2] as DaqInterval) || '15s',
              deadband: parseFloat(cols[3]) || 0,
              retention: (cols[4] as DaqRetention) || '30d',
            });
          }
        }

        if (imported.length > 0) {
          // Merge: update existing, add new
          const existingMap = new Map(configs.map((c) => [c.tagName, c]));
          for (const item of imported) {
            existingMap.set(item.tagName, item);
          }
          onConfigsChange(Array.from(existingMap.values()));
        }
      } catch {
        // Silently ignore malformed CSV
      }
    };
    input.click();
  }, [configs, onConfigsChange]);

  const enabledCount = filtered.filter((c) => c.enabled).length;

  return (
    <div className="space-y-3" data-testid="daq-config-panel">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-cyan-600" />
          <h4 className="text-sm font-medium text-gray-700">DAQ Configuration</h4>
          <span className="text-[11px] text-gray-400">
            ({enabledCount}/{filtered.length} enabled)
          </span>
        </div>
        <button
          onClick={handleCsvImport}
          className="p-1.5 rounded hover:bg-gray-100 text-gray-500"
          title="Import from CSV"
        >
          <Upload className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Search + bulk actions */}
      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tags..."
            className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-200 rounded focus:ring-1 focus:ring-cyan-500"
          />
        </div>
        <button
          onClick={() => handleBulkToggle(true)}
          className="px-2 py-1.5 text-[10px] font-medium text-green-700 bg-green-50 border border-green-200 rounded hover:bg-green-100"
          title="Enable all visible"
        >
          All On
        </button>
        <button
          onClick={() => handleBulkToggle(false)}
          className="px-2 py-1.5 text-[10px] font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded hover:bg-gray-100"
          title="Disable all visible"
        >
          All Off
        </button>
      </div>

      {/* Add tag */}
      <div className="flex items-center gap-2">
        {unconfiguredTags.length > 0 ? (
          <select
            value={newTagName}
            onChange={(e) => {
              setNewTagName(e.target.value);
              if (e.target.value) handleAddTag(e.target.value);
            }}
            className="flex-1 px-2 py-1.5 text-xs border border-gray-200 rounded focus:ring-1 focus:ring-cyan-500"
          >
            <option value="">Add tag...</option>
            {unconfiguredTags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddTag(newTagName);
            }}
            placeholder="Tag name"
            className="flex-1 px-2 py-1.5 text-xs border border-gray-200 rounded focus:ring-1 focus:ring-cyan-500"
          />
        )}
        <button
          onClick={() => handleAddTag(newTagName)}
          disabled={!newTagName.trim()}
          className="p-1.5 rounded bg-cyan-600 text-white hover:bg-cyan-700 disabled:bg-gray-200 disabled:text-gray-400"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tag table */}
      {filtered.length === 0 ? (
        <div className="text-center py-6 text-xs text-gray-400">
          {configs.length === 0
            ? 'No DAQ tags configured. Add tags above.'
            : 'No tags match the search filter.'}
        </div>
      ) : (
        <div className="space-y-1 max-h-[400px] overflow-auto">
          {filtered.map((config) => (
            <div
              key={config.tagName}
              className={`border rounded-lg p-2.5 space-y-2 transition-colors ${
                config.enabled ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'
              }`}
              data-testid={`daq-tag-${config.tagName}`}
            >
              {/* Tag header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleUpdate(config.tagName, { enabled: !config.enabled })}
                    className={config.enabled ? 'text-green-500' : 'text-gray-300'}
                    title={config.enabled ? 'Disable logging' : 'Enable logging'}
                  >
                    {config.enabled ? (
                      <ToggleRight className="w-5 h-5" />
                    ) : (
                      <ToggleLeft className="w-5 h-5" />
                    )}
                  </button>
                  <span className="text-xs font-mono font-medium text-gray-800 truncate max-w-[150px]">
                    {config.tagName}
                  </span>
                </div>
                <button
                  onClick={() => handleRemoveTag(config.tagName)}
                  className="p-1 rounded hover:bg-red-100 text-red-400"
                  title="Remove"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>

              {/* Settings row */}
              {config.enabled && (
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-0.5">Interval</label>
                    <select
                      value={config.interval}
                      onChange={(e) =>
                        handleUpdate(config.tagName, { interval: e.target.value as DaqInterval })
                      }
                      className="w-full px-1.5 py-1 text-[11px] border border-gray-200 rounded"
                      data-testid={`daq-interval-${config.tagName}`}
                    >
                      {INTERVAL_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-0.5">Deadband</label>
                    <input
                      type="number"
                      value={config.deadband}
                      onChange={(e) =>
                        handleUpdate(config.tagName, { deadband: parseFloat(e.target.value) || 0 })
                      }
                      min={0}
                      step={0.1}
                      className="w-full px-1.5 py-1 text-[11px] border border-gray-200 rounded"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-0.5">Retention</label>
                    <select
                      value={config.retention}
                      onChange={(e) =>
                        handleUpdate(config.tagName, { retention: e.target.value as DaqRetention })
                      }
                      className="w-full px-1.5 py-1 text-[11px] border border-gray-200 rounded"
                    >
                      {RETENTION_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default DaqConfigPanel;
