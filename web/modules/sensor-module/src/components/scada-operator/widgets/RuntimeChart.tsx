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
import { useTrendData } from '../../../hooks/useTrendData';

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const MAX_BUFFER_POINTS = 10_000;
const DEFAULT_WINDOW_MINUTES = 10;

/* ------------------------------------------------------------------ */
/*  RingBuffer — O(1) push with automatic eviction                     */
/* ------------------------------------------------------------------ */

class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private _size = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    if (this._size < this.capacity) this._size++;
    else this.head = (this.head + 1) % this.capacity;
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this._size; i++) {
      result.push(this.buffer[(this.head + i) % this.capacity]!);
    }
    return result;
  }

  get size(): number { return this._size; }
  clear(): void { this.head = 0; this.tail = 0; this._size = 0; }
}

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

  /**
   * Stabilized tag-ID key: only changes when the SET of tag IDs changes,
   * not when their values update. Prevents unnecessary uPlot recreation.
   */
  const tagIdKey = useMemo(
    () => (tagValues ? Object.keys(tagValues).sort().join(',') : ''),
    [tagValues],
  );

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

    // Fallback: derive from tagValues keys (stabilized via tagIdKey)
    if (tagIdKey) {
      return tagIdKey.split(',').map((tagId, i) => ({
        tagId,
        label: tagId,
        color: DEFAULT_COLORS[i % DEFAULT_COLORS.length],
      }));
    }

    return [];
  }, [config.series, tagIdKey]);

  /* ---- State ---- */
  const containerRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const bufferRef = useRef<Map<string, RingBuffer<[number, number]>>>(new Map());
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef(false);
  const [rangeMinutes, setRangeMinutes] = useState(windowMinutes);

  /* ---- Historical backfill (T8) ---- */
  // Seed the ring buffer with persisted history so the chart opens with
  // context instead of waiting for new live samples. Only runs when the
  // widget has REAL tag bindings (series derived from tags/pens).
  const backfillTagIds = useMemo(
    () => (seriesList.length > 0 ? seriesList.map((s) => s.tagId) : []),
    [seriesList],
  );
  const backfillRange = useMemo(
    () => ({ from: new Date(Date.now() - rangeMinutes * 60_000), to: new Date() }),
    // Recompute only when the window size changes; the refresh button
    // re-queries via refresh().
    [rangeMinutes],
  );
  const { data: backfillData, refresh: refreshBackfill } = useTrendData(
    backfillTagIds,
    backfillRange,
  );

  // Feed backfilled history into the ring buffers (once per data change).
  useEffect(() => {
    if (backfillTagIds.length === 0) return;
    for (const series of seriesList) {
      const points = backfillData[series.tagId];
      if (!points || points.length === 0) continue;
      if (!bufferRef.current.has(series.tagId)) {
        bufferRef.current.set(series.tagId, new RingBuffer<[number, number]>(MAX_BUFFER_POINTS));
      }
      const ring = bufferRef.current.get(series.tagId)!;
      const arr = ring.toArray();
      const oldest = arr.length > 0 ? arr[0][0] : Infinity;
      for (const pt of points) {
        const tsSec = pt.timestamp / 1000;
        const numVal = typeof pt.value === 'number' ? pt.value : parseFloat(String(pt.value));
        if (isNaN(numVal) || tsSec >= oldest) continue; // live buffer is newer
        ring.push([tsSec, numVal]);
      }
    }
    // Flush through the shared rAF path so uPlot redraws once.
    if (!pendingRef.current) {
      pendingRef.current = true;
      rafRef.current = requestAnimationFrame(() => {
        pendingRef.current = false;
        // Reuse flushBuffer via a custom event: simplest is to call the
        // instance directly below (setData with merged buffers).
        const u = uplotRef.current;
        if (!u) return;
        flushBufferRef.current?.();
      });
    }
  }, [backfillData, backfillTagIds, seriesList]);

  // flushBuffer is defined below; keep a stable ref for the backfill effect.
  const flushBufferRef = useRef<(() => void) | null>(null);

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
    for (const ring of buf.values()) {
      for (const [ts] of ring.toArray()) tsSet.add(ts);
    }

    const timestamps = [...tsSet].filter((t) => t >= cutoff).sort((a, b) => a - b);
    if (timestamps.length === 0) return;

    const tsIdx = new Map<number, number>();
    timestamps.forEach((t, i) => tsIdx.set(t, i));

    const seriesData: (number | null)[][] = seriesList.map((s) => {
      const ring = buf.get(s.tagId);
      const pts = ring ? ring.toArray() : [];
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

  // Expose flushBuffer to the backfill effect via a stable ref.
  flushBufferRef.current = flushBuffer;

  /* ---- Feed tag values into buffer ---- */

  useEffect(() => {
    if (!tagValues || seriesList.length === 0) return;

    let changed = false;

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
        bufferRef.current.set(series.tagId, new RingBuffer<[number, number]>(MAX_BUFFER_POINTS));
      }

      const ring = bufferRef.current.get(series.tagId)!;
      // Append only if newer (check last element via toArray peek)
      const arr = ring.toArray();
      if (arr.length === 0 || arr[arr.length - 1][0] < tsSec) {
        ring.push([tsSec, numVal]);
        changed = true;
      }
    }

    if (!changed || pendingRef.current) return;
    pendingRef.current = true;
    rafRef.current = requestAnimationFrame(flushBuffer);
  }, [tagValues, seriesList, flushBuffer]);

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

  /* ---- CSV export (T8: keep the trendChart CSV feature) ---- */

  const handleExportCsv = useCallback(() => {
    const headers = ['timestamp', ...seriesList.map((s) => s.label)];
    const rows: string[] = [headers.join(',')];
    // Merge all buffered series into rows keyed by timestamp.
    const tsSet = new Set<number>();
    for (const ring of bufferRef.current.values()) {
      for (const [ts] of ring.toArray()) tsSet.add(ts);
    }
    const timestamps = [...tsSet].sort((a, b) => a - b);
    for (const ts of timestamps) {
      const cols = seriesList.map((s) => {
        const pts = bufferRef.current.get(s.tagId)?.toArray() ?? [];
        const hit = pts.find(([t]) => t === ts);
        return hit ? String(hit[1]) : '';
      });
      rows.push([new Date(ts * 1000).toISOString(), ...cols].join(','));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trend-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [seriesList]);

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
          {/* History backfill refresh */}
          <button
            type="button"
            onClick={refreshBackfill}
            title="Re-query history"
            aria-label="Re-query history"
            className="px-1.5 py-0.5 text-[10px] rounded text-gray-600 hover:bg-gray-200 transition-colors"
          >
            ⟳
          </button>
          {/* CSV export */}
          <button
            type="button"
            onClick={handleExportCsv}
            title="Export CSV"
            aria-label="Export CSV"
            className="px-1.5 py-0.5 text-[10px] rounded text-gray-600 hover:bg-gray-200 transition-colors"
          >
            CSV
          </button>
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
          No series configured — bind tags to plot trend data
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
