/**
 * RuntimeChart -- uPlot-based real-time trend chart for operator mode.
 *
 * Follows the RuntimeGauge pattern for props and integration with
 * RuntimeWidgetRenderer. Uses uPlot (like TrendChart) for high-performance
 * time-series rendering.
 *
 * Features:
 *   - Multiple series from tagValues (multi-tag widgets)
 *   - Auto-scaling Y-axis
 *   - Sliding window realtime buffer
 *   - Mini toolbar for time range selection
 *   - ResizeObserver for responsive layout
 *   - requestAnimationFrame batching for updates
 *   - Configurable via widget config
 */

import React, {
  memo,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { RuntimeWidgetProps, TagValueChange } from '../../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const MAX_BUFFER_POINTS = 10_000;
const DEFAULT_WINDOW_MINUTES = 10;

const DEFAULT_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#f97316',
  '#84cc16',
];

const RANGE_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: '1m',  minutes: 1 },
  { label: '5m',  minutes: 5 },
  { label: '10m', minutes: 10 },
  { label: '30m', minutes: 30 },
  { label: '1h',  minutes: 60 },
  { label: '4h',  minutes: 240 },
];

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface SeriesConfig {
  tagId: string;
  label: string;
  color: string;
  lineWidth?: number;
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

const RuntimeChart: React.FC<RuntimeWidgetProps> = ({
  config,
  tagValues,
  isEnabled,
  width = 400,
  height = 200,
}) => {
  /* ---- Config ---- */
  const windowMinutes = (config.windowMinutes ?? DEFAULT_WINDOW_MINUTES) as number;
  const title = (config.title ?? '') as string;
  const showToolbar = (config.showToolbar ?? true) as boolean;

  /** Parse series definitions from config. */
  const seriesList = useMemo<SeriesConfig[]>(() => {
    const raw = config.series as SeriesConfig[] | undefined;
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.map((s, i) => ({
        tagId: s.tagId,
        label: s.label || s.tagId,
        color: s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length],
        lineWidth: s.lineWidth,
      }));
    }

    // Fallback: derive from tagValues keys
    if (tagValues) {
      return Object.keys(tagValues).map((tagId, i) => ({
        tagId,
        label: tagId,
        color: DEFAULT_COLORS[i % DEFAULT_COLORS.length],
      }));
    }

    return [];
  }, [config.series, tagValues]);

  /* ---- State ---- */
  const containerRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const bufferRef = useRef<Map<string, Array<[number, number]>>>(new Map());
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef(false);
  const [rangeMinutes, setRangeMinutes] = useState(windowMinutes);

  /* ---- Build uPlot options ---- */

  const buildOptions = useCallback(
    (w: number, h: number): uPlot.Options => {
      const toolbarHeight = showToolbar ? 28 : 0;
      const chartHeight = Math.max(h - toolbarHeight, 80);

      return {
        width: w,
        height: chartHeight,
        title: title || undefined,
        cursor: { show: true },
        legend: { show: seriesList.length > 1, live: true },
        scales: {
          x: { time: true },
          y: { auto: true },
        },
        axes: [
          {
            scale: 'x',
            stroke: '#9ca3af',
            font: '10px system-ui',
            grid: { stroke: 'rgba(0,0,0,0.06)', width: 1 },
            ticks: { stroke: '#9ca3af', width: 1 },
          },
          {
            scale: 'y',
            stroke: '#9ca3af',
            font: '10px system-ui',
            grid: { stroke: 'rgba(0,0,0,0.06)', width: 1 },
            ticks: { stroke: '#9ca3af', width: 1 },
            size: 50,
          },
        ],
        series: [
          {}, // x-axis placeholder
          ...seriesList.map((s) => ({
            label: s.label,
            stroke: s.color,
            width: s.lineWidth ?? 1.5,
            points: { show: false },
            spanGaps: false,
          })),
        ],
      };
    },
    [seriesList, title, showToolbar],
  );

  /* ---- Create / destroy uPlot ---- */

  useEffect(() => {
    const container = containerRef.current;
    if (!container || seriesList.length === 0) return;

    const w = container.clientWidth || width;
    const h = container.clientHeight || height;

    const opts = buildOptions(w, h);
    const emptyData: uPlot.AlignedData = [
      [],
      ...seriesList.map(() => []),
    ] as uPlot.AlignedData;

    const instance = new uPlot(opts, emptyData, container);
    uplotRef.current = instance;

    return () => {
      instance.destroy();
      uplotRef.current = null;
      bufferRef.current.clear();
    };
  }, [seriesList, buildOptions, width, height]);

  /* ---- ResizeObserver ---- */

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !uplotRef.current) return;
      const { width: w, height: h } = entry.contentRect;
      const toolbarHeight = showToolbar ? 28 : 0;
      const chartH = Math.max(h - toolbarHeight, 80);
      if (w > 0 && chartH > 0) {
        uplotRef.current.setSize({ width: w, height: chartH });
      }
    });

    ro.observe(container);
    return () => ro.disconnect();
  }, [showToolbar]);

  /* ---- Flush buffer to uPlot ---- */

  const flushBuffer = useCallback(() => {
    rafRef.current = null;
    pendingRef.current = false;
    const u = uplotRef.current;
    if (!u || seriesList.length === 0) return;

    const windowSec = rangeMinutes * 60;
    const nowSec = Date.now() / 1000;
    const cutoff = nowSec - windowSec;

    const buf = bufferRef.current;

    // Collect timestamps
    const tsSet = new Set<number>();
    for (const pts of buf.values()) {
      for (const [ts] of pts) tsSet.add(ts);
    }

    const timestamps = [...tsSet].filter((t) => t >= cutoff).sort((a, b) => a - b);
    if (timestamps.length === 0) return;

    const tsIdx = new Map<number, number>();
    timestamps.forEach((t, i) => tsIdx.set(t, i));

    const seriesData: (number | null)[][] = seriesList.map((s) => {
      const pts = buf.get(s.tagId) ?? [];
      const row: (number | null)[] = new Array(timestamps.length).fill(null);
      for (const [ts, val] of pts) {
        if (ts < cutoff) continue;
        const idx = tsIdx.get(ts);
        if (idx != null) row[idx] = val;
      }
      return row;
    });

    u.setData([timestamps, ...seriesData] as uPlot.AlignedData);
  }, [seriesList, rangeMinutes]);

  /* ---- Feed tag values into buffer ---- */

  useEffect(() => {
    if (!tagValues || seriesList.length === 0) return;

    let changed = false;
    const windowSec = rangeMinutes * 60;
    const cutoff = Date.now() / 1000 - windowSec;

    for (const series of seriesList) {
      const change: TagValueChange | undefined = tagValues[series.tagId];
      if (!change) continue;

      const tsSec = change.timestamp / 1000;
      const numVal =
        typeof change.value === 'number'
          ? change.value
          : parseFloat(String(change.value));
      if (isNaN(numVal)) continue;

      if (!bufferRef.current.has(series.tagId)) {
        bufferRef.current.set(series.tagId, []);
      }

      const buf = bufferRef.current.get(series.tagId)!;
      // Append only if newer
      if (buf.length === 0 || buf[buf.length - 1][0] < tsSec) {
        buf.push([tsSec, numVal]);
        changed = true;
      }

      // Evict old data
      while (buf.length > 0 && buf[0][0] < cutoff) {
        buf.shift();
      }
      while (buf.length > MAX_BUFFER_POINTS) {
        buf.shift();
      }
    }

    if (!changed || pendingRef.current) return;
    pendingRef.current = true;
    rafRef.current = requestAnimationFrame(flushBuffer);
  }, [tagValues, seriesList, rangeMinutes, flushBuffer]);

  /* ---- Cleanup RAF on unmount ---- */

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  /* ---- Range change handler ---- */

  const handleRangeChange = useCallback((minutes: number) => {
    setRangeMinutes(minutes);
  }, []);

  /* ---- Render ---- */

  return (
    <div
      className="flex flex-col w-full h-full overflow-hidden"
      style={{ opacity: isEnabled ? 1 : 0.5 }}
    >
      {/* Mini toolbar */}
      {showToolbar && (
        <div className="flex items-center gap-0.5 px-1.5 py-0.5 bg-gray-50 border-b border-gray-200 flex-shrink-0">
          {RANGE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => handleRangeChange(preset.minutes)}
              className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                rangeMinutes === preset.minutes
                  ? 'bg-blue-500 text-white font-semibold'
                  : 'text-gray-600 hover:bg-gray-200'
              }`}
            >
              {preset.label}
            </button>
          ))}
          {title && (
            <span className="ml-auto text-[10px] text-gray-400 truncate max-w-[120px]">
              {title}
            </span>
          )}
        </div>
      )}

      {/* No series warning */}
      {seriesList.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-xs text-gray-400">
          No series configured
        </div>
      )}

      {/* uPlot mount target */}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 overflow-hidden"
      />
    </div>
  );
};

RuntimeChart.displayName = 'RuntimeChart';
export default memo(RuntimeChart);
