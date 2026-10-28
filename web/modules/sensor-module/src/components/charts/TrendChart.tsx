/**
 * TrendChart — uPlot-based high-performance time-series chart for SCADA HMI.
 *
 * A pure PRESENTATION chart: the caller supplies pre-fetched series data
 * (customData + breaks). It deliberately has NO data subscription of its own —
 * the 2026-10 /sensor/readings outage root cause was this component calling
 * the SCADA DataProvider hooks (useRealtimeData/useTrendData) that throw
 * outside <DataProviderRoot> (providers/DataProviderContext.tsx), while its
 * only consumer (MultiParameterTrendCard) mounts it provider-less. Provider-
 * fed modes belong to the SCADA widget renderers, which own their
 * DataProviderRoot (OperatorShell / StableModeProvider), not to the shared
 * chart. Removing the dead modes makes that misuse impossible.
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

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { colors, useI18n } from '@aquaculture/shared-ui';
import { type LineBreaks, toUPlotData } from './trendChartData';
import type {
  ChartLine,
  ChartOptions,
  ChartLineZone,
  HistoricalDataPoint,
  LineInterpolation,
} from '../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

/**
 * Stable default for the `options` prop. A destructuring default (`= {}`)
 * creates a NEW object identity per render, which flows into
 * buildUPlotOptions' memo deps and destroys+recreates the uPlot instance on
 * EVERY parent re-render — ReadingsPage re-renders once per second (useNow),
 * so the chart was rebuilt ~60×/min. A module-level constant gives the
 * default a single identity and lets the memo actually memoize.
 */
const DEFAULT_CHART_OPTIONS: Partial<ChartOptions> = {};

export interface TrendChartProps {
  lines: ChartLine[];
  options?: Partial<ChartOptions>;
  /**
   * Tailwind classes for the chart's box. The caller owns the size: pass a
   * height utility ("h-64", "h-full" inside a definite-height panel, …).
   * Without one the box has no height to draw into.
   */
  className?: string;
  /** Pre-fetched series data keyed by tagId — the chart's data contract. */
  customData?: Record<string, HistoricalDataPoint[]>;
  /**
   * IANA zone the time axis is drawn in (a site's zone). Without it uPlot
   * draws the browser's zone, which is not the site's.
   */
  timeZone?: string;
  /**
   * Custom mode: per line (by tagId), the instants (ms) where its data stops —
   * the series' reported gaps. Lines listed here are drawn through other
   * lines' timestamps and broken only at these instants.
   */
  breaks?: LineBreaks;
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
    points:
      line.interpolation === 'scatter'
        ? { show: true, size: 6, fill: line.color }
        : line.showIsolatedPoints
          ? { show: true, size: 5, fill: line.color, filter: isolatedPointIndices }
          : { show: false },
  };
}

/**
 * The indices of values with no value on either side: a lone bucket between
 * two gaps, which a line cannot draw. uPlot draws a point only at these.
 */
const isolatedPointIndices: uPlot.Series.Points.Filter = (u, seriesIdx) => {
  const values = u.data[seriesIdx] ?? [];
  const isolated: number[] = [];
  // The nearest defined neighbour on each side: `undefined` is another line's
  // timestamp, drawn through; `null` is a break.
  const neighbour = (from: number, step: 1 | -1): number | null | undefined => {
    for (let index = from + step; index >= 0 && index < values.length; index += step) {
      if (values[index] !== undefined) return values[index];
    }
    return null;
  };
  for (let index = 0; index < values.length; index++) {
    if (values[index] == null) continue;
    if (neighbour(index, -1) == null && neighbour(index, 1) == null) isolated.push(index);
  }
  return isolated;
};

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
function buildAxes(lines: ChartLine[], opts: Partial<ChartOptions>): uPlot.Axis[] {
  const axisColor = opts.axisLabelColor ?? colors.neutral[500];
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

/* ------------------------------------------------------------------ */
/*  Tooltip plugin                                                      */
/* ------------------------------------------------------------------ */

interface TooltipState {
  left: number;
  top: number;
  visible: boolean;
  /** The instant under the cursor, in the chart's zone. */
  time?: string;
  values: Array<{ label: string; color: string; value: string }>;
}

function buildTooltipPlugin(
  lines: ChartLine[],
  decimalsPrecision: number,
  setTooltip: React.Dispatch<React.SetStateAction<TooltipState>>,
  format: { readonly time: Intl.DateTimeFormat; readonly number: Intl.NumberFormat },
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
          const formatted = raw == null ? '—' : format.number.format(raw);
          return { label: line.label, color: line.color, value: formatted };
        });
        const seconds = u.data[0]?.[idx];
        const time = seconds == null ? undefined : format.time.format(seconds * 1000);

        setTooltip({ left, top, visible: true, time, values });
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Wheel plugin (pan + zoom)                                           */
/* ------------------------------------------------------------------ */

function buildWheelPlugin(enableScroll: boolean, enableZoom: boolean): uPlot.Plugin {
  return {
    hooks: {
      ready: (u: uPlot) => {
        const el = u.over;
        if (!el) return;

        el.addEventListener(
          'wheel',
          (e: WheelEvent) => {
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
          },
          { passive: false },
        );
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

        const dist = (a: Touch, b: Touch) => Math.abs(a.clientX - b.clientX);

        el.addEventListener(
          'touchstart',
          (e: TouchEvent) => {
            if (e.touches.length !== 2) return;
            touches = e.touches;
            initialDist = dist(touches[0], touches[1]);
            const xScale = u.scales.x;
            if (xScale.min == null || xScale.max == null) return;
            initialRange = xScale.max - xScale.min;
            const midX = (touches[0].clientX + touches[1].clientX) / 2;
            const rect = el.getBoundingClientRect();
            initialMid = u.posToVal(midX - rect.left, 'x');
          },
          { passive: true },
        );

        el.addEventListener(
          'touchmove',
          (e: TouchEvent) => {
            if (e.touches.length !== 2 || !touches || initialDist === 0) return;
            e.preventDefault();
            const newDist = dist(e.touches[0], e.touches[1]);
            const scale = initialDist / newDist;
            const newRange = initialRange * scale;
            u.setScale('x', {
              min: initialMid - newRange * 0.5,
              max: initialMid + newRange * 0.5,
            });
          },
          { passive: false },
        );

        el.addEventListener(
          'touchend',
          () => {
            touches = null;
            initialDist = 0;
          },
          { passive: true },
        );
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export const TrendChart: React.FC<TrendChartProps> = ({
  lines,
  options = DEFAULT_CHART_OPTIONS,
  className,
  customData,
  timeZone,
  breaks,
}) => {
  const { locale } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);

  // Tooltip state
  const [tooltip, setTooltip] = useState<TooltipState>({
    left: 0,
    top: 0,
    visible: false,
    values: [],
  });

  /* ---- uPlot instance construction ---- */

  const buildUPlotOptions = useCallback(
    (width: number, height: number): uPlot.Options => {
      const decimalsPrecision = options.decimalsPrecision ?? 2;

      const plugins: uPlot.Plugin[] = [
        buildTooltipPlugin(lines, decimalsPrecision, setTooltip, {
          time: new Intl.DateTimeFormat(locale, {
            ...(timeZone === undefined ? {} : { timeZone }),
            dateStyle: 'short',
            timeStyle: 'short',
          }),
          number: new Intl.NumberFormat(locale, {
            minimumFractionDigits: decimalsPrecision,
            maximumFractionDigits: decimalsPrecision,
          }),
        }),
        buildTouchPlugin(),
      ];

      if (options.mouseWheelScroll !== false || options.mouseWheelZoom) {
        plugins.push(
          buildWheelPlugin(options.mouseWheelScroll !== false, options.mouseWheelZoom === true),
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
        ...(timeZone === undefined
          ? {}
          : { tzDate: (seconds: number) => uPlot.tzDate(new Date(seconds * 1000), timeZone) }),
        series: [
          {}, // x-axis placeholder
          ...lines.map((line) => buildSeries(line, line.zones)),
        ],
      };
    },

    [lines, options, timeZone, locale],
  );

  /* ---- Create / recreate uPlot on STRUCTURAL change only ---- */

  /**
   * What forces a uPlot REBUILD rather than a data update: the series set
   * (count, identity, scale, appearance) or the frame around it (time zone,
   * locale, options). A refresh that only carries new points keeps the
   * instance — the chart stays on screen and the data lands at its right
   * edge, heartbeat-monitor style, instead of flashing away and being
   * rebuilt. On /sensor/readings every latest-values poll produced new
   * `lines` array identities with identical content, and the identity-based
   * deps below tore the chart down on each one.
   */
  const structureKey = useMemo(
    () =>
      JSON.stringify([
        lines.map((line) => [
          line.id,
          line.tagId,
          line.label,
          line.yAxis,
          line.color,
          line.lineWidth ?? null,
          line.interpolation,
          line.spanGaps ?? null,
          line.showIsolatedPoints ?? null,
          (line.zones ?? []).map((zone) => [zone.min, zone.max, zone.stroke, zone.fill]),
        ]),
        timeZone ?? null,
        locale,
        options,
      ]),
    [lines, timeZone, locale, options],
  );

  // Read by the create/recreate effect without being its dependency, so a
  // data-only change cannot destroy the instance through the builder's or
  // the lines' identity churn.
  const buildOptionsRef = useRef(buildUPlotOptions);
  buildOptionsRef.current = buildUPlotOptions;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const dataRef = useRef({ customData, breaks });
  dataRef.current = { customData, breaks };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 600;
    const height = options.panelHeight ?? (container.clientHeight || 300);

    const uplotOpts = buildOptionsRef.current(width, height);
    const emptyData: uPlot.AlignedData = [
      [],
      ...linesRef.current.map(() => []),
    ] as uPlot.AlignedData;

    const instance = new uPlot(uplotOpts, emptyData, container);
    uplotRef.current = instance;
    // A rebuild must not wait for the data effect's deps to also change
    // (e.g. a time-zone change with identical data): seed the fresh
    // instance with the data on screen right away.
    instance.setData(
      toUPlotData(linesRef.current, dataRef.current.customData ?? {}, dataRef.current.breaks),
    );

    return () => {
      instance.destroy();
      uplotRef.current = null;
    };
    // Recreate only when the chart's structure changes (see structureKey);
    // data flows in through setData, never through a rebuild.
  }, [structureKey, options.panelHeight]);

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

  /* ---- Feed the caller's pre-fetched data into uPlot ---- */

  useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;

    const uData = toUPlotData(lines, customData ?? {}, breaks);
    u.setData(uData);
  }, [customData, lines, breaks]);

  /* ---- Render ---- */

  return (
    // The root is the caller's box: `className` sizes it (e.g. "h-64" or
    // "h-full" inside a definite-height panel). It must NOT carry `h-full`
    // itself — in the compiled Tailwind order `.h-full` lands after any
    // caller height utility, silently overriding it and leaving the box
    // content-sized against an auto-height parent.
    <div className={`relative w-full ${className ?? ''}`}>
      {/* uPlot mount target. Box-positioned (absolute inset-0), so its
          contentRect is the assigned box and can never depend on the uPlot
          root it hosts. A flow-positioned mount made the ResizeObserver read
          back the chart's own height PLUS the legend and feed that sum in as
          the next chart height — the chart grew by one legend row per
          notification, stretching the page downward without end. */}
      <div
        ref={containerRef}
        className="absolute inset-0 overflow-hidden"
        style={{ background: options.colorBackground ?? undefined }}
      >
        {/* Floating tooltip */}
        {tooltip.visible && (
          <div
            className="pointer-events-none absolute z-10 rounded border border-gray-200 dark:border-gray-700 bg-white/90 dark:bg-gray-900/90 px-2 py-1.5 shadow-(--shadow-sd-md) text-xs backdrop-blur-sm"
            style={{ left: tooltip.left + 12, top: tooltip.top - 8 }}
          >
            {tooltip.time && (
              <div className="mb-0.5 font-medium text-gray-700 dark:text-gray-300">
                {tooltip.time}
              </div>
            )}
            {tooltip.values.map((v) => (
              <div key={v.label} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                  style={{ background: v.color }}
                />
                <span className="text-gray-600 dark:text-gray-400">{v.label}:</span>
                <span className="tabular-nums font-medium text-gray-900 dark:text-gray-100">
                  {v.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
