/**
 * Debug panel showing all tag values in real-time.
 * Essential for operators and engineers to verify tag data
 * without switching to a separate monitoring tool.
 *
 * Architecture: Subscribes to TagValueBus wildcard ('*') to receive
 * all tag updates. Displays in a searchable, sortable table with
 * mini sparkline charts for numeric values.
 *
 * Visible in Preview and Simulation modes. Hidden in Edit mode
 * (no live data available). Collapsible bottom panel.
 *
 * Performance considerations:
 *  - Wildcard subscription receives ALL tag updates on the bus.
 *  - Sparkline history is capped at 30 samples per tag to bound memory.
 *  - Rendering is throttled via React 18 automatic batching.
 *  - The panel can be paused to freeze the display without unsubscribing
 *    (subscription stays active so history continues to accumulate).
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Search,
  Pause,
  Play,
  Trash2,
  Download,
  ChevronDown,
  ChevronUp,
  Activity,
} from 'lucide-react';
import { TagValueBus } from '../../engine/tags/TagValueBus';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TagEntry {
  name: string;
  value: unknown;
  type: string;
  lastUpdate: number;
  /** Rolling history of numeric values for sparkline rendering. */
  history: number[];
}

interface TagWatchPanelProps {
  /** The TagValueBus instance to subscribe to. */
  tagBus: TagValueBus;
  /** Whether the panel is initially expanded. */
  defaultExpanded?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of historical values retained per tag for sparkline. */
const MAX_HISTORY = 30;

// ---------------------------------------------------------------------------
// Mini Sparkline Component
// ---------------------------------------------------------------------------

/**
 * Renders an inline SVG sparkline for a numeric tag's recent history.
 * Width is fixed at 80px, height at 24px — designed for table cells.
 * Normalizes values to fit within the chart height regardless of scale.
 */
const MiniSparkline: React.FC<{ values: number[] }> = ({ values }) => {
  if (values.length < 2) return null;

  const w = 80;
  const h = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={w} height={h} className="inline-block">
      <polyline
        points={points}
        fill="none"
        stroke="#06b6d4"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
};

// ---------------------------------------------------------------------------
// CSV Export
// ---------------------------------------------------------------------------

function exportTagsCsv(entries: Map<string, TagEntry>): void {
  const header = 'Tag Name,Value,Type,Last Update\n';
  const rows = Array.from(entries.values())
    .map((e) => {
      const ts = new Date(e.lastUpdate).toISOString();
      const val = typeof e.value === 'object' ? JSON.stringify(e.value) : String(e.value);
      return `"${e.name}","${val}","${e.type}","${ts}"`;
    })
    .join('\n');

  const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `tag-watch-${Date.now()}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TagWatchPanel: React.FC<TagWatchPanelProps> = ({
  tagBus,
  defaultExpanded = true,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [search, setSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const [sortField, setSortField] = useState<'name' | 'value' | 'lastUpdate'>('name');
  const [sortAsc, setSortAsc] = useState(true);

  // Mutable ref for tag entries — avoids re-render per individual tag update.
  // A periodic forceUpdate pulls the latest snapshot into React state.
  const entriesRef = useRef<Map<string, TagEntry>>(new Map());
  const [entries, setEntries] = useState<Map<string, TagEntry>>(new Map());

  // Periodic render refresh (250ms) — balances responsiveness with CPU cost
  useEffect(() => {
    const interval = setInterval(() => {
      if (!paused) {
        setEntries(new Map(entriesRef.current));
      }
    }, 250);
    return () => clearInterval(interval);
  }, [paused]);

  // Wildcard subscription — receives every tag update on the bus
  useEffect(() => {
    const unsub = tagBus.subscribe('*', (value: unknown, tagName: string) => {
      const now = Date.now();
      const existing = entriesRef.current.get(tagName);
      const numericValue = typeof value === 'number' ? value : null;

      const history = existing?.history ?? [];
      if (numericValue !== null) {
        history.push(numericValue);
        if (history.length > MAX_HISTORY) {
          history.shift();
        }
      }

      entriesRef.current.set(tagName, {
        name: tagName,
        value,
        type: typeof value,
        lastUpdate: now,
        history,
      });
    });

    return unsub;
  }, [tagBus]);

  // Search filter + sort
  const filtered = useMemo(() => {
    const arr = Array.from(entries.values());
    const term = search.toLowerCase();
    const result = term
      ? arr.filter((e) => e.name.toLowerCase().includes(term))
      : arr;

    result.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'name') {
        cmp = a.name.localeCompare(b.name);
      } else if (sortField === 'value') {
        cmp = String(a.value).localeCompare(String(b.value));
      } else {
        cmp = a.lastUpdate - b.lastUpdate;
      }
      return sortAsc ? cmp : -cmp;
    });

    return result;
  }, [entries, search, sortField, sortAsc]);

  const handleSort = useCallback((field: 'name' | 'value' | 'lastUpdate') => {
    setSortField((prev) => {
      if (prev === field) {
        setSortAsc((a) => !a);
        return prev;
      }
      setSortAsc(true);
      return field;
    });
  }, []);

  const handleClearHistory = useCallback(() => {
    entriesRef.current.clear();
    setEntries(new Map());
  }, []);

  const handleCsvExport = useCallback(() => {
    exportTagsCsv(entries);
  }, [entries]);

  const formatValue = (value: unknown): string => {
    if (value === null || value === undefined) return '--';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number') return value.toFixed(2);
    return String(value);
  };

  const formatTimestamp = (ts: number): string => {
    if (!ts) return '--';
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  };

  return (
    <div
      className="border-t border-gray-200 bg-white flex flex-col"
      data-testid="tag-watch-panel"
    >
      {/* Toggle header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center justify-between px-4 py-2 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2 text-xs font-medium text-gray-700">
          <Activity className="w-3.5 h-3.5 text-cyan-600" />
          Tag Watch
          <span className="text-gray-400">({entries.size} tags)</span>
          {paused && (
            <span className="text-yellow-600 bg-yellow-50 px-1.5 py-0.5 rounded text-[10px] font-semibold">
              PAUSED
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
        ) : (
          <ChevronUp className="w-3.5 h-3.5 text-gray-400" />
        )}
      </button>

      {expanded && (
        <div className="flex flex-col" style={{ maxHeight: 280 }}>
          {/* Toolbar */}
          <div className="flex items-center gap-2 px-4 py-2 border-t border-gray-100">
            <div className="flex-1 relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tags..."
                className="w-full pl-7 pr-2 py-1 text-xs border border-gray-200 rounded focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500"
                data-testid="tag-watch-search"
              />
            </div>
            <button
              onClick={() => setPaused((p) => !p)}
              className={`p-1.5 rounded transition-colors ${
                paused ? 'bg-yellow-50 text-yellow-600' : 'hover:bg-gray-100 text-gray-500'
              }`}
              title={paused ? 'Resume' : 'Pause'}
            >
              {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={handleCsvExport}
              className="p-1.5 rounded hover:bg-gray-100 text-gray-500"
              title="Export CSV"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleClearHistory}
              className="p-1.5 rounded hover:bg-gray-100 text-gray-500"
              title="Clear history"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-50">
                <tr>
                  <th
                    className="text-left px-4 py-1.5 font-medium text-gray-500 cursor-pointer hover:text-gray-700"
                    onClick={() => handleSort('name')}
                  >
                    Tag {sortField === 'name' && (sortAsc ? '\u25B2' : '\u25BC')}
                  </th>
                  <th
                    className="text-left px-2 py-1.5 font-medium text-gray-500 cursor-pointer hover:text-gray-700"
                    onClick={() => handleSort('value')}
                  >
                    Value {sortField === 'value' && (sortAsc ? '\u25B2' : '\u25BC')}
                  </th>
                  <th className="text-left px-2 py-1.5 font-medium text-gray-500">Type</th>
                  <th className="text-center px-2 py-1.5 font-medium text-gray-500">Sparkline</th>
                  <th
                    className="text-right px-4 py-1.5 font-medium text-gray-500 cursor-pointer hover:text-gray-700"
                    onClick={() => handleSort('lastUpdate')}
                  >
                    Last Update {sortField === 'lastUpdate' && (sortAsc ? '\u25B2' : '\u25BC')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-6 text-gray-400">
                      {entries.size === 0
                        ? 'No tag data received yet'
                        : 'No tags match the search filter'}
                    </td>
                  </tr>
                ) : (
                  filtered.map((entry) => (
                    <tr key={entry.name} className="hover:bg-gray-50 border-t border-gray-50">
                      <td className="px-4 py-1.5 font-mono text-gray-900 truncate max-w-[200px]">
                        {entry.name}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-gray-700">
                        {formatValue(entry.value)}
                      </td>
                      <td className="px-2 py-1.5 text-gray-500">{entry.type}</td>
                      <td className="px-2 py-1.5 text-center">
                        <MiniSparkline values={entry.history} />
                      </td>
                      <td className="px-4 py-1.5 text-right text-gray-500 font-mono">
                        {formatTimestamp(entry.lastUpdate)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default TagWatchPanel;
