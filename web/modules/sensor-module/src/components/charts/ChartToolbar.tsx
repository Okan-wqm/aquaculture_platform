/**
 * ChartToolbar -- Time range selector, aggregation selector, and controls
 * for history-mode charts.
 *
 * Layout:
 *   [< Back] [Preset v] [Forward >]  [Custom from/to]  [Aggregation v]
 *   [Refresh] [Auto-refresh v]  [Export v]
 *
 * Preset ranges: 1h, 8h, 1d, 3d, 1w, 1m
 * Aggregation: raw, 5min, 10min, 30min, 1h, 1d
 * Navigation: back / forward by the current range width
 * Auto-refresh: off | 30s | 1min | 5min | 10min | 30min
 * Export: delegates to ChartExport (CSV + PNG)
 */

import React, { useState, useCallback, useRef } from 'react';
import { ChartExport } from './ChartExport';
import type {
  ChartLine,
  ChartTimeRange,
  DaqAggregation,
  DaqAggregationInterval,
  HistoricalDataPoint,
} from '../../types/scada-runtime.types';
import type { TrendTimeRange } from '../../hooks/useTrendData';

/* ------------------------------------------------------------------ */
/*  Types & constants                                                   */
/* ------------------------------------------------------------------ */

interface PresetOption {
  label: string;
  value: ChartTimeRange;
  ms: number;
}

const PRESETS: PresetOption[] = [
  { label: 'Last 1h',  value: 'last1h',  ms: 60 * 60 * 1000 },
  { label: 'Last 8h',  value: 'last8h',  ms: 8 * 60 * 60 * 1000 },
  { label: 'Last 1d',  value: 'last1d',  ms: 24 * 60 * 60 * 1000 },
  { label: 'Last 3d',  value: 'last3d',  ms: 3 * 24 * 60 * 60 * 1000 },
  { label: 'Last 1w',  value: 'last1w',  ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'Last 1m',  value: 'last1m',  ms: 30 * 24 * 60 * 60 * 1000 },
];

interface AggregationOption {
  label: string;
  value: DaqAggregationInterval | 'raw';
}

const AGGREGATION_OPTIONS: AggregationOption[] = [
  { label: 'Raw',    value: 'raw' },
  { label: '5 min',  value: '5min' },
  { label: '10 min', value: '10min' },
  { label: '30 min', value: '30min' },
  { label: '1 hour', value: '1h' },
  { label: '1 day',  value: '1d' },
];

interface AutoRefreshOption {
  label: string;
  ms: number | undefined;
}

const AUTO_REFRESH_OPTIONS: AutoRefreshOption[] = [
  { label: 'Off',    ms: undefined },
  { label: '30s',    ms: 30_000 },
  { label: '1 min',  ms: 60_000 },
  { label: '5 min',  ms: 300_000 },
  { label: '10 min', ms: 600_000 },
  { label: '30 min', ms: 1_800_000 },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function toLocalDatetimeInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Resolve a TrendTimeRange to an absolute {from, to} pair. */
function resolveRange(range: TrendTimeRange): { from: Date; to: Date } {
  if (typeof range === 'object' && 'from' in range) return range;

  const preset = PRESETS.find((p) => p.value === range);
  const ms = preset?.ms ?? 60 * 60 * 1000;
  const to = new Date();
  return { from: new Date(to.getTime() - ms), to };
}

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

export interface ChartToolbarProps {
  currentRange: TrendTimeRange;
  isLoading: boolean;
  autoRefreshMs: number | undefined;
  /** Series metadata (for export). */
  lines: ChartLine[];
  /** Current chart data (for export). */
  data: Record<string, HistoricalDataPoint[]>;
  chartTitle?: string;
  /** Current aggregation interval. */
  aggregationInterval?: DaqAggregationInterval | 'raw';
  /** Ref to a chart canvas / container element for PNG export. */
  chartRef?: React.RefObject<HTMLElement | null>;
  onRangeChange: (range: TrendTimeRange) => void;
  onAutoRefreshChange: (ms: number | undefined) => void;
  onRefresh: () => void;
  /** Called when aggregation interval changes. */
  onAggregationChange?: (interval: DaqAggregationInterval | 'raw') => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export const ChartToolbar: React.FC<ChartToolbarProps> = ({
  currentRange,
  isLoading,
  autoRefreshMs,
  lines,
  data,
  chartTitle,
  aggregationInterval = 'raw',
  chartRef,
  onRangeChange,
  onAutoRefreshChange,
  onRefresh,
  onAggregationChange,
}) => {
  const [showCustom, setShowCustom] = useState(false);
  const [showPresetMenu, setShowPresetMenu] = useState(false);
  const [showRefreshMenu, setShowRefreshMenu] = useState(false);
  const [showAggMenu, setShowAggMenu] = useState(false);
  const [showExport, setShowExport] = useState(false);

  // Custom range input state
  const [customFrom, setCustomFrom] = useState<string>(() => {
    const resolved = resolveRange(currentRange);
    return toLocalDatetimeInput(resolved.from);
  });
  const [customTo, setCustomTo] = useState<string>(() => {
    return toLocalDatetimeInput(new Date());
  });

  /* ---- Resolved values ---- */

  const currentPreset =
    typeof currentRange === 'string' && currentRange !== 'custom'
      ? PRESETS.find((p) => p.value === currentRange)
      : null;

  const currentPresetLabel = currentPreset?.label ?? 'Custom';

  const currentRefreshLabel =
    AUTO_REFRESH_OPTIONS.find((o) => o.ms === autoRefreshMs)?.label ?? 'Off';

  const currentAggLabel =
    AGGREGATION_OPTIONS.find((o) => o.value === aggregationInterval)?.label ?? 'Raw';

  /* ---- Navigation ---- */

  const navigate = useCallback(
    (direction: 'back' | 'forward') => {
      const { from, to } = resolveRange(currentRange);
      const rangeMs = to.getTime() - from.getTime();
      const offset = direction === 'back' ? -rangeMs : rangeMs;
      onRangeChange({
        from: new Date(from.getTime() + offset),
        to: new Date(to.getTime() + offset),
      });
    },
    [currentRange, onRangeChange],
  );

  /* ---- Custom range apply ---- */

  const applyCustomRange = useCallback(() => {
    const from = new Date(customFrom);
    const to = new Date(customTo);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return;
    if (from >= to) return;
    onRangeChange({ from, to });
    setShowCustom(false);
  }, [customFrom, customTo, onRangeChange]);

  /* ---- Close menus on outside click ---- */

  const closeMenus = useCallback(() => {
    setShowPresetMenu(false);
    setShowRefreshMenu(false);
    setShowAggMenu(false);
  }, []);

  /* ---- Render ---- */

  return (
     
    <div
      className="flex flex-wrap items-center gap-1 px-2 py-1.5 bg-gray-50 border-b border-gray-200 text-xs"
      onClick={closeMenus}
      role="toolbar"
      aria-label="Chart controls"
    >
      {/* Back */}
      <button
        type="button"
        aria-label="Navigate backward"
        onClick={(e) => { e.stopPropagation(); navigate('back'); }}
        className="inline-flex items-center px-2 py-1 rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40 transition-colors"
        disabled={isLoading}
      >
        &#9664;
      </button>

      {/* Preset dropdown */}
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => { setShowPresetMenu((v) => !v); setShowRefreshMenu(false); setShowAggMenu(false); }}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 transition-colors min-w-[80px]"
          disabled={isLoading}
        >
          {currentPresetLabel}
          <span className="ml-auto text-gray-400">&#9662;</span>
        </button>
        {showPresetMenu && (
          <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded shadow-lg py-1 min-w-[110px]">
            {PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                onClick={() => {
                  onRangeChange(preset.value);
                  setShowPresetMenu(false);
                  setShowCustom(false);
                }}
                className={`block w-full text-left px-3 py-1.5 hover:bg-blue-50 transition-colors ${
                  currentPreset?.value === preset.value ? 'font-semibold text-blue-600' : 'text-gray-700'
                }`}
              >
                {preset.label}
              </button>
            ))}
            <hr className="my-1 border-gray-100" />
            <button
              type="button"
              onClick={() => { setShowCustom((v) => !v); setShowPresetMenu(false); }}
              className="block w-full text-left px-3 py-1.5 hover:bg-blue-50 text-gray-700 transition-colors"
            >
              Custom range...
            </button>
          </div>
        )}
      </div>

      {/* Forward */}
      <button
        type="button"
        aria-label="Navigate forward"
        onClick={(e) => { e.stopPropagation(); navigate('forward'); }}
        className="inline-flex items-center px-2 py-1 rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40 transition-colors"
        disabled={isLoading}
      >
        &#9654;
      </button>

      {/* Custom date range inputs */}
      {showCustom && (
        <div
          className="flex items-center gap-1 px-2 py-1 bg-white border border-gray-200 rounded shadow-sm"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="text-gray-500">From:</span>
          <input
            type="datetime-local"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="rounded border border-gray-300 px-1.5 py-0.5 text-xs focus:outline-hidden focus:ring-1 focus:ring-blue-400"
          />
          <span className="text-gray-500">To:</span>
          <input
            type="datetime-local"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="rounded border border-gray-300 px-1.5 py-0.5 text-xs focus:outline-hidden focus:ring-1 focus:ring-blue-400"
          />
          <button
            type="button"
            onClick={applyCustomRange}
            className="px-2 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 transition-colors"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => setShowCustom(false)}
            className="px-2 py-1 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-100 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Aggregation selector */}
      {onAggregationChange && (
        <div className="relative" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => { setShowAggMenu((v) => !v); setShowPresetMenu(false); setShowRefreshMenu(false); }}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <span className="text-gray-500">Agg:</span>
            {currentAggLabel}
            <span className="ml-1 text-gray-400">&#9662;</span>
          </button>
          {showAggMenu && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded shadow-lg py-1 min-w-[100px]">
              {AGGREGATION_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onAggregationChange(opt.value);
                    setShowAggMenu(false);
                  }}
                  className={`block w-full text-left px-3 py-1.5 hover:bg-blue-50 transition-colors ${
                    opt.value === aggregationInterval ? 'font-semibold text-blue-600' : 'text-gray-700'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex-1" />

      {/* Manual refresh */}
      <button
        type="button"
        aria-label="Refresh"
        onClick={(e) => { e.stopPropagation(); onRefresh(); }}
        disabled={isLoading}
        className={`inline-flex items-center px-2 py-1 rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40 transition-colors ${
          isLoading ? 'animate-spin' : ''
        }`}
      >
        &#8635;
      </button>

      {/* Auto-refresh dropdown */}
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => { setShowRefreshMenu((v) => !v); setShowPresetMenu(false); setShowAggMenu(false); }}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 transition-colors"
        >
          <span className="text-gray-500">Auto:</span>
          {currentRefreshLabel}
          <span className="ml-1 text-gray-400">&#9662;</span>
        </button>
        {showRefreshMenu && (
          <div className="absolute top-full right-0 mt-1 z-50 bg-white border border-gray-200 rounded shadow-lg py-1 min-w-[90px]">
            {AUTO_REFRESH_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => {
                  onAutoRefreshChange(opt.ms);
                  setShowRefreshMenu(false);
                }}
                className={`block w-full text-left px-3 py-1.5 hover:bg-blue-50 transition-colors ${
                  opt.ms === autoRefreshMs ? 'font-semibold text-blue-600' : 'text-gray-700'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Export button */}
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          aria-label="Export data"
          onClick={() => setShowExport((v) => !v)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 transition-colors"
        >
          Export &#9662;
        </button>
        {showExport && (
          <div className="absolute top-full right-0 mt-1 z-50">
            <ChartExport
              lines={lines}
              data={data}
              chartTitle={chartTitle}
              currentRange={currentRange}
              chartRef={chartRef}
              onClose={() => setShowExport(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
};
