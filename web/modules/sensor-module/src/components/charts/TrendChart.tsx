/**
 * TrendChart — uPlot-based high-performance time-series chart for SCADA HMI.
 *
 * Supports three view modes:
 *   realtime  — sliding-window buffer fed by useRealtimeData
 *   history   — range query via useTrendData + ChartToolbar
 *   custom    — caller supplies pre-fetched data
 *
 * Features:
 *   - Multi-Y-axis (up to 4 scales)
 *   - Line interpolation: linear, stepAfter, stepBefore, spline, scatter
 *   - Zone-based gradient fills (value-range coloring)
 *   - Floating tooltip showing all series values at cursor
 *   - ResizeObserver for responsive layout
 *   - Mouse-wheel pan/zoom
 *   - Touch pinch-to-zoom
 *   - requestAnimationFrame batching for realtime updates
 *   - Max 10 000 points per series in realtime mode
 */

import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useRealtimeData } from '../../hooks/useRealtimeData';
import { useTrendData, type TrendTimeRange } from '../../hooks/useTrendData';
import { ChartToolbar } from './ChartToolbar';
import type {
  ChartViewMode,
  ChartLine,
  ChartOptions,
  ChartTimeRange,
  ChartLineZone,
  HistoricalDataPoint,
  LineInterpolation,
} from '../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const MAX_REALTIME_POINTS = 10_000;
const DEFAULT_REALTIME_WINDOW_MINUTES = 10;

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

export interface TrendChartProps {
  mode: ChartViewMode;
  lines: ChartLine[];
  options?: Partial<ChartOptions>;
  className?: string;
  /** Realtime mode: rolling window width in minutes. Default 10. */
  realtimeWindowMinutes?: number;
  /** History mode: initial preset or custom range. */
  initialRange?: ChartTimeRange;
  /** Custom mode: pre-fetched series data keyed by tagId. */
  customData?: Record<string, HistoricalDataPoint[]>;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Build the uPlot series config for a ChartLine.
 * Handles paths, zone-gradient fills, and scatter mode.
 */
function buildSeries(line: ChartLine, zones: ChartLineZone[] | undefined): uPlot.Series {
  const pathBuilder = buildPathBuilder(line.interpolation);
  const fillFn = zones && zones.length > 0 ? buildZoneFill(zones) : undefined;

  return {
    label: line.label,
    scale: String(line.yAxis),
    stroke: line.color,
    width: line.lineWidth ?? 1.5,
    fill: fillFn ?? (line.fill ? line.fill : undefined),
    spanGaps: line.spanGaps ?? false,
    paths: line.interpolation === 'scatter' ? drawScatterPaths : pathBuilder,
    points: line.interpolation === 'scatter' ? { show: true, size: 6, fill: line.color } : { show: false },
  };
}

function buildPathBuilder(interpolation: LineInterpolation): uPlot.Series['paths'] | undefined {
  switch (interpolation) {
    case 'stepAfter':
      return uPlot.paths.stepped!({ align: 1 });
    case 'stepBefore':
      return uPlot.paths.stepped!({ align: -1 });
    case 'spline':
      return uPlot.paths.spline!();
    case 'scatter':
      return () => null;
    case 'linear':
    default:
      return undefined; // uPlot default
  }
}

/**
 * Scatter path renderer: draws nothing (points are drawn by uPlot's
 * per-series points config). Returning null opts out of line drawing.
 *
 * Signature matches uPlot.Series.PathBuilder for type safety.
 */
const drawScatterPaths: uPlot.Series.PathBuilder = (u, seriesIdx, idx0, idx1) => {
  return null; // suppress line drawing, only draw points
};

/**
 * Build a zone-based fill function using a canvas linear gradient.
 * The gradient maps value ranges to colours along the Y axis.
 */
function buildZoneFill(
  zones: ChartLineZone[],
): (self: uPlot, seriesIdx: number) => string | CanvasGradient | CanvasPattern {
  return (self: uPlot, seriesIdx: number): string | CanvasGradient | CanvasPattern => {
    const ctx = self.ctx;
    const plotTop = self.bbox.top;
    const plotHeight = self.bbox.height;

    const scale = self.series[seriesIdx]?.scale ?? '1';
    const minVal = self.scales[scale]?.min;
    const maxVal = self.scales[scale]?.max;
    if (minVal == null || maxVal == null || plotHeight === 0) return 'transparent';

    const range = maxVal - minVal;
    if (range === 0) return 'transparent';

    const grad = ctx.createLinearGradient(0, plotTop, 0, plotTop + plotHeight);
    const sortedZones = [...zones].sort((a, b) => b.min - a.min);

    for (const zone of sortedZones) {
      const topStop = Math.max(0, Math.min(1, (maxVal - zone.max) / range));
      const btmStop = Math.max(0, Math.min(1, (maxVal - zone.min) / range));
      grad.addColorStop(topStop, zone.fill);
      grad.addColorStop(btmStop, zone.fill);
    }

    return grad;
  };
}

/**
 * Build uPlot scale configs for up to 4 Y axes.
 */
function buildScales(opts: Partial<ChartOptions>): Record<string, uPlot.Scale> {
  const scales: Record<string, uPlot.Scale> = {
    x: { time: true },
  };

  const axisKeys = ['scaleY1', 'scaleY2', 'scaleY3', 'scaleY4'] as const;
  axisKeys.forEach((key, i) => {
    const cfg = opts[key];
    scales[String(i + 1)] = {
      auto: true,
      ...(cfg?.min != null ? { min: cfg.min } : {}),
      ...(cfg?.max != null ? { max: cfg.max } : {}),
    };
  });

  return scales;
}

/**
 * Build uPlot axis configs for all active Y axes.
 */
function buildAxes(
  lines: ChartLine[],
  opts: Partial<ChartOptions>,
): uPlot.Axis[] {
  const axisColor = opts.axisLabelColor ?? '#666';
  const gridColor = opts.gridLineColor ?? 'rgba(0,0,0,0.1)';
  const font = opts.fontFamily ? `12px ${opts.fontFamily}` : '12px system-ui';

  const xAxis: uPlot.Axis = {
    scale: 'x',
    stroke: axisColor,
    font,
    grid: { stroke: gridColor, width: 1 },
    ticks: { stroke: axisColor, width: 1 },
  };

  const activeYAxes = new Set(lines.map((l) => l.yAxis));
  const axisKeys = ['scaleY1', 'scaleY2', 'scaleY3', 'scaleY4'] as const;
  const sides = [3, 1, 3, 1]; // left, right, left, right

  const yAxes: uPlot.Axis[] = [];
  axisKeys.forEach((key, i) => {
    const axisNum = (i + 1) as 1 | 2 | 3 | 4;
    if (!activeYAxes.has(axisNum)) return;
    const cfg = opts[key];
    yAxes.push({
      scale: String(axisNum),
      side: sides[i],
      stroke: axisColor,
      font,
      label: cfg?.label,
      labelFont: font,
      grid: { stroke: gridColor, width: 1 },
      ticks: { stroke: axisColor, width: 1 },
    });
  });

  return [xAxis, ...yAxes];
}

/**
 * Convert HistoricalDataPoint arrays into the flat uPlot data format.
 * uPlot expects [timestamps, series1Values, series2Values, …]
 * where each array has the same length and timestamps are ascending.
 */
function toUPlotData(
  lines: ChartLine[],
  data: Record<string, HistoricalDataPoint[]>,
): uPlot.AlignedData {
  if (lines.length === 0) return [[], ...lines.map(() => [])];

  // Collect and sort all unique timestamps
  const tsSet = new Set<number>();
  for (const line of lines) {
    const pts = data[line.tagId] ?? [];
    for (const pt of pts) tsSet.add(pt.timestamp / 1000); // uPlot uses seconds
  }

  const timestamps = [...tsSet].sort((a, b) => a - b);
  if (timestamps.length === 0) return [[], ...lines.map(() => [])];

  const tsIndex = new Map<number, number>();
  timestamps.forEach((t, i) => tsIndex.set(t, i));

  const series: (number | null)[][] = lines.map((line) => {
    const row: (number | null)[] = new Array(timestamps.length).fill(null);
    const pts = data[line.tagId] ?? [];
    for (const pt of pts) {
      const ts = pt.timestamp / 1000;
      const idx = tsIndex.get(ts);
      if (idx == null) continue;
      const v = typeof pt.value === 'number' ? pt.value : parseFloat(String(pt.value));
      row[idx] = isNaN(v) ? null : v;
    }
    return row;
  });

  return [timestamps as number[], ...series] as uPlot.AlignedData;
}

/* ------------------------------------------------------------------ */
/*  Tooltip plugin                                                      */
/* ------------------------------------------------------------------ */

interface TooltipState {
  left: number;
  top: number;
  visible: boolean;
  values: Array<{ label: string; color: string; value: string }>;
}

function buildTooltipPlugin(
  lines: ChartLine[],
  decimalsPrecision: number,
  setTooltip: React.Dispatch<React.SetStateAction<TooltipState>>,
): uPlot.Plugin {
  return {
    hooks: {
      setCursor: (u: uPlot) => {
        const { left, top, idx } = u.cursor;
        if (idx == null || left == null || top == null || left < 0) {
          setTooltip((prev) => ({ ...prev, visible: false }));
          return;
        }

        const values: TooltipState['values'] = lines.map((line, i) => {
          const raw = u.data[i + 1]?.[idx];
          const formatted =
            raw == null ? '—' : raw.toFixed(decimalsPrecision);
          return { label: line.label, color: line.color, value: formatted };
        });

        setTooltip({ left, top, visible: true, values });
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Wheel plugin (pan + zoom)                                           */
/* ------------------------------------------------------------------ */

function buildWheelPlugin(
  enableScroll: boolean,
  enableZoom: boolean,
): uPlot.Plugin {
  return {
    hooks: {
      ready: (u: uPlot) => {
        const el = u.over;
        if (!el) return;

        el.addEventListener('wheel', (e: WheelEvent) => {
          e.preventDefault();
          const xScale = u.scales.x;
          if (xScale.min == null || xScale.max == null) return;
          const range = xScale.max - xScale.min;

          if (enableZoom && e.ctrlKey) {
            const factor = e.deltaY > 0 ? 1.1 : 0.9;
            const pivot = u.posToVal(e.offsetX, 'x');
            const newMin = pivot - (pivot - xScale.min) * factor;
            const newMax = pivot + (xScale.max - pivot) * factor;
            u.setScale('x', { min: newMin, max: newMax });
          } else if (enableScroll) {
            const delta = (e.deltaY / 200) * range;
            u.setScale('x', {
              min: xScale.min + delta,
              max: xScale.max + delta,
            });
          }
        }, { passive: false });
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Touch pinch-to-zoom plugin                                         */
/* ------------------------------------------------------------------ */

function buildTouchPlugin(): uPlot.Plugin {
  return {
    hooks: {
      ready: (u: uPlot) => {
        const el = u.over;
        if (!el) return;

        let touches: TouchList | null = null;
        let initialDist = 0;
        let initialRange = 0;
        let initialMid = 0;

        const dist = (a: Touch, b: Touch) =>
          Math.abs(a.clientX - b.clientX);

        el.addEventListener('touchstart', (e: TouchEvent) => {
          if (e.touches.length !== 2) return;
          touches = e.touches;
          initialDist = dist(touches[0], touches[1]);
          const xScale = u.scales.x;
          if (xScale.min == null || xScale.max == null) return;
          initialRange = xScale.max - xScale.min;
          const midX = (touches[0].clientX + touches[1].clientX) / 2;
          const rect = el.getBoundingClientRect();
          initialMid = u.posToVal(midX - rect.left, 'x');
        }, { passive: true });

        el.addEventListener('touchmove', (e: TouchEvent) => {
          if (e.touches.length !== 2 || !touches || initialDist === 0) return;
          e.preventDefault();
          const newDist = dist(e.touches[0], e.touches[1]);
          const scale = initialDist / newDist;
          const newRange = initialRange * scale;
          u.setScale('x', {
            min: initialMid - newRange * 0.5,
            max: initialMid + newRange * 0.5,
          });
        }, { passive: false });

        el.addEventListener('touchend', () => {
          touches = null;
          initialDist = 0;
        }, { passive: true });
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export const TrendChart: React.FC<TrendChartProps> = ({
  mode,
  lines,
  options = {},
  className,
  realtimeWindowMinutes = DEFAULT_REALTIME_WINDOW_MINUTES,
  initialRange = 'last1h',
  customData,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);

  // Realtime buffer: tagId → [timestamp(s), value, …] interleaved tuples
  const realtimeBufferRef = useRef<Map<string, Array<[number, number]>>>(new Map());
  const rafHandleRef = useRef<number | null>(null);
  const pendingRealtimeRef = useRef(false);

  // History/custom time range state
  const [historyRange, setHistoryRange] = useState<TrendTimeRange>(
    (initialRange === 'custom' ? 'last1h' : initialRange) as TrendTimeRange,
  );
  const [autoRefreshMs, setAutoRefreshMs] = useState<number | undefined>(undefined);

  // Tooltip state
  const [tooltip, setTooltip] = useState<TooltipState>({
    left: 0,
    top: 0,
    visible: false,
    values: [],
  });

  // Tag IDs needed by this chart
  const tagIds = useMemo(() => lines.map((l) => l.tagId), [lines]);

  /* ---- Data subscriptions ---- */

  const realtimeResult = useRealtimeData(mode === 'realtime' ? tagIds : []);

  const historyResult = useTrendData(
    mode === 'history' ? tagIds : [],
    historyRange,
    {
      refreshIntervalMs: autoRefreshMs,
    },
  );

  /* ---- uPlot instance construction ---- */

  const buildUPlotOptions = useCallback(
    (width: number, height: number): uPlot.Options => {
      const decimalsPrecision = options.decimalsPrecision ?? 2;

      const plugins: uPlot.Plugin[] = [
        buildTooltipPlugin(lines, decimalsPrecision, setTooltip),
        buildTouchPlugin(),
      ];

      if (options.mouseWheelScroll !== false || options.mouseWheelZoom) {
        plugins.push(
          buildWheelPlugin(
            options.mouseWheelScroll !== false,
            options.mouseWheelZoom === true,
          ),
        );
      }

      const legendOpts: uPlot.Options['legend'] = (() => {
        switch (options.legendMode) {
          case 'never':
            return { show: false };
          case 'bottom':
            return { show: true, live: false };
          case 'follow':
            return { show: true, live: true };
          case 'always':
          default:
            return { show: true, live: false };
        }
      })();

      return {
        width,
        height,
        title: options.title,
        plugins,
        legend: legendOpts,
        cursor: {
          sync: { key: 'trend-cursor' },
        },
        scales: buildScales(options),
        axes: buildAxes(lines, options),
        series: [
          {}, // x-axis placeholder
          ...lines.map((line) => buildSeries(line, line.zones)),
        ],
      };
    },
     
    [lines, options],
  );

  /* ---- Create / recreate uPlot on mount and option changes ---- */

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 600;
    const height = options.panelHeight ?? (container.clientHeight || 300);

    const uplotOpts = buildUPlotOptions(width, height);
    const emptyData: uPlot.AlignedData = [
      [],
      ...lines.map(() => []),
    ] as uPlot.AlignedData;

    const instance = new uPlot(uplotOpts, emptyData, container);
    uplotRef.current = instance;

    return () => {
      instance.destroy();
      uplotRef.current = null;
      realtimeBufferRef.current.clear();
    };
    // Recreate on lines or options change
     
  }, [lines, options, buildUPlotOptions]);

  /* ---- ResizeObserver ---- */

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !uplotRef.current) return;
      const { width } = entry.contentRect;
      const height = options.panelHeight ?? entry.contentRect.height;
      if (width > 0 && height > 0) {
        uplotRef.current.setSize({ width, height });
      }
    });

    ro.observe(container);
    return () => ro.disconnect();
  }, [options.panelHeight]);

  /* ---- Feed history / custom data into uPlot ---- */

  useEffect(() => {
    if (mode !== 'history' && mode !== 'custom') return;
    const u = uplotRef.current;
    if (!u) return;

    const source = mode === 'custom' ? (customData ?? {}) : historyResult.data;
    const uData = toUPlotData(lines, source);
    u.setData(uData);
  }, [
    mode,
    historyResult.data,
    customData,
    lines,
  ]);

  /* ---- Realtime buffer management ---- */

  const flushRealtimeBuffer = useCallback(() => {
    rafHandleRef.current = null;
    pendingRealtimeRef.current = false;
    const u = uplotRef.current;
    if (!u) return;

    const windowSec = realtimeWindowMinutes * 60;
    const nowSec = Date.now() / 1000;
    const cutoff = nowSec - windowSec;

    const buf = realtimeBufferRef.current;

    // Build flat sorted timestamp set across all series
    const tsSet = new Set<number>();
    for (const pts of buf.values()) {
      for (const [ts] of pts) tsSet.add(ts);
    }
    const timestamps = [...tsSet].filter((t) => t >= cutoff).sort((a, b) => a - b);
    if (timestamps.length === 0) return;

    const tsIdx = new Map<number, number>();
    timestamps.forEach((t, i) => tsIdx.set(t, i));

    const seriesData: (number | null)[][] = lines.map((line) => {
      const pts = buf.get(line.tagId) ?? [];
      const row: (number | null)[] = new Array(timestamps.length).fill(null);
      for (const [ts, val] of pts) {
        if (ts < cutoff) continue;
        const i = tsIdx.get(ts);
        if (i != null) row[i] = val;
      }
      return row;
    });

    u.setData([timestamps, ...seriesData] as uPlot.AlignedData);
  }, [lines, realtimeWindowMinutes]);

  useEffect(() => {
    if (mode !== 'realtime') return;
    const { values } = realtimeResult;

    let changed = false;
    const windowSec = realtimeWindowMinutes * 60;
    const cutoff = Date.now() / 1000 - windowSec;

    for (const line of lines) {
      const change = values[line.tagId];
      if (!change) continue;

      const tsSec = change.timestamp / 1000;
      const numVal =
        typeof change.value === 'number'
          ? change.value
          : parseFloat(String(change.value));
      if (isNaN(numVal)) continue;

      if (!realtimeBufferRef.current.has(line.tagId)) {
        realtimeBufferRef.current.set(line.tagId, []);
      }

      const buf = realtimeBufferRef.current.get(line.tagId)!;
      // Append only if newer
      if (buf.length === 0 || buf[buf.length - 1][0] < tsSec) {
        buf.push([tsSec, numVal]);
        changed = true;
      }

      // Evict old data beyond window + enforce max cap
      while (buf.length > 0 && buf[0][0] < cutoff) {
        buf.shift();
      }
      while (buf.length > MAX_REALTIME_POINTS) {
        buf.shift();
      }
    }

    if (!changed || pendingRealtimeRef.current) return;
    pendingRealtimeRef.current = true;
    rafHandleRef.current = requestAnimationFrame(flushRealtimeBuffer);
  }, [realtimeResult.values, mode, lines, realtimeWindowMinutes, flushRealtimeBuffer]);

  /* ---- Cleanup RAF on unmount ---- */

  useEffect(() => {
    return () => {
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
      }
    };
  }, []);

  /* ---- Toolbar range change handler ---- */

  const handleRangeChange = useCallback((range: TrendTimeRange) => {
    setHistoryRange(range);
  }, []);

  const handleAutoRefreshChange = useCallback((intervalMs: number | undefined) => {
    setAutoRefreshMs(intervalMs);
  }, []);

  /* ---- Render ---- */

  const showToolbar = mode === 'history' && options.hideToolbar !== true;

  return (
    <div className={`flex flex-col w-full h-full ${className ?? ''}`}>
      {showToolbar && (
        <ChartToolbar
          currentRange={historyRange}
          isLoading={historyResult.isLoading}
          autoRefreshMs={autoRefreshMs}
          lines={lines}
          data={historyResult.data}
          chartTitle={options.title}
          onRangeChange={handleRangeChange}
          onAutoRefreshChange={handleAutoRefreshChange}
          onRefresh={historyResult.refresh}
        />
      )}
      {mode === 'realtime' && !realtimeResult.isConnected && (
        <div className="px-3 py-1 text-xs text-amber-600 bg-amber-50 border-b border-amber-200">
          Data source disconnected — showing last known values
        </div>
      )}
      {historyResult.error && (
        <div className="px-3 py-1 text-xs text-red-600 bg-red-50 border-b border-red-200">
          {historyResult.error}
        </div>
      )}

      {/* uPlot mount target */}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 overflow-hidden"
        style={{ background: options.colorBackground ?? undefined }}
      >
        {/* Floating tooltip */}
        {tooltip.visible && (
          <div
            className="pointer-events-none absolute z-10 rounded border border-gray-200 bg-white/90 px-2 py-1.5 shadow-md text-xs backdrop-blur-sm"
            style={{ left: tooltip.left + 12, top: tooltip.top - 8 }}
          >
            {tooltip.values.map((v) => (
              <div key={v.label} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                  style={{ background: v.color }}
                />
                <span className="text-gray-600">{v.label}:</span>
                <span className="font-mono font-medium text-gray-900">{v.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
