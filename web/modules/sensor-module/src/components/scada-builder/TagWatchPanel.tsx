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
import {
  colors as themeColors,
  DataTable,
  type DataTableColumn,
  type SortConfig,
  Button,
  Input,
} from '@aquaculture/shared-ui';

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
const SORT_FIELDS = ['name', 'value', 'lastUpdate'] as const;
type SortField = (typeof SORT_FIELDS)[number];
const isSortField = (key: string): key is SortField =>
  (SORT_FIELDS as readonly string[]).includes(key);

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
        stroke={themeColors.primary[400]}
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

export const TagWatchPanel: React.FC<TagWatchPanelProps> = ({ tagBus, defaultExpanded = true }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [search, setSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const [sortField, setSortField] = useState<SortField>('name');
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
    const result = term ? arr.filter((e) => e.name.toLowerCase().includes(term)) : arr;

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

  // DataTable reports the sort it cycled to (asc, desc, none); the panel keeps
  // its own comparator because tag values are mixed types.
  const handleSort = useCallback((sort: SortConfig | null) => {
    if (sort && isSortField(sort.key)) {
      setSortField(sort.key);
      setSortAsc(sort.direction === 'asc');
    } else {
      setSortField('name');
      setSortAsc(true);
    }
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

  const tagWatchColumns: DataTableColumn<TagEntry>[] = [
    {
      key: 'name',
      header: 'Tag',
      render: (_value, entry) => (
        <span className="block max-w-[200px] truncate font-mono text-gray-900 dark:text-gray-100">
          {entry.name}
        </span>
      ),
    },
    {
      key: 'value',
      header: 'Value',
      render: (_value, entry) => (
        <span className="font-mono text-gray-700 dark:text-gray-300">
          {formatValue(entry.value)}
        </span>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      sortable: false,
      render: (_value, entry) => (
        <span className="text-gray-500 dark:text-gray-400">{entry.type}</span>
      ),
    },
    {
      key: 'history',
      header: 'Sparkline',
      sortable: false,
      align: 'center',
      render: (_value, entry) => <MiniSparkline values={entry.history} />,
    },
    {
      key: 'lastUpdate',
      header: 'Last Update',
      align: 'right',
      render: (_value, entry) => (
        <span className="font-mono text-gray-500 dark:text-gray-400">
          {formatTimestamp(entry.lastUpdate)}
        </span>
      ),
    },
  ];

  return (
    <div
      className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col"
      data-testid="tag-watch-panel"
    >
      {/* Toggle header */}
      <Button variant="ghost" onClick={() => setExpanded((e) => !e)}>
        <div className="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-300">
          <Activity className="w-3.5 h-3.5 text-info-600 dark:text-info-400" />
          Tag Watch
          <span className="text-gray-400 dark:text-gray-500">({entries.size} tags)</span>
          {paused && (
            <span className="text-warning-600 dark:text-warning-400 bg-warning-50 dark:bg-warning-900/20 px-1.5 py-0.5 rounded text-[10px] font-semibold">
              PAUSED
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
        ) : (
          <ChevronUp className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
        )}
      </Button>

      {expanded && (
        <div className="flex flex-col max-h-[280px]">
          {/* Toolbar */}
          <div className="flex items-center gap-2 px-4 py-2 border-t border-gray-100 dark:border-gray-700">
            <div className="flex-1 relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
              <Input
                fullWidth
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tags..."
                data-testid="tag-watch-search"
              />
            </div>
            <button
              onClick={() => setPaused((p) => !p)}
              className={`p-1.5 rounded transition-colors ${
                paused
                  ? 'bg-warning-50 dark:bg-warning-900/20 text-warning-600 dark:text-warning-400'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400'
              }`}
              title={paused ? 'Resume' : 'Pause'}
            >
              {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            </button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Export CSV"
              onClick={handleCsvExport}
              title="Export CSV"
            >
              <Download className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Clear history"
              onClick={handleClearHistory}
              title="Clear history"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-auto">
            <DataTable<TagEntry>
              data={filtered}
              columns={tagWatchColumns}
              keyExtractor={(entry) => entry.name}
              emptyMessage={
                entries.size === 0 ? 'No tag data received yet' : 'No tags match the search filter'
              }
              searchable={false}
              serverSideSort
              defaultSort={{ key: sortField, direction: sortAsc ? 'asc' : 'desc' }}
              onSort={handleSort}
              compact
              className="border-0 rounded-none shadow-none"
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default TagWatchPanel;
