/**
 * BarChartRenderer - SVG-based bar chart for comparing multiple tag values.
 * Renders pure SVG bars -- no external chart library dependency.
 *
 * Architecture: Each bar source binds to a tag. Values are fetched
 * from TagValueBus and mapped to bar heights relative to the Y axis.
 * Auto-scaling adjusts the Y axis range to fit the data.
 *
 * Supports vertical and horizontal orientation, grouped mode,
 * and smooth CSS transitions for live value updates.
 */

import React, { memo, useMemo, useCallback } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface BarSource {
  tagName: string;
  label: string;
  color: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_COLORS = [
  '#06b6d4', '#8b5cf6', '#f59e0b', '#ef4444', '#22c55e',
  '#ec4899', '#3b82f6', '#14b8a6',
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Compute a "nice" max value for the Y axis that rounds up to a clean number.
 * Prevents axis labels like 73.2 — instead we get 80 or 100.
 */
function niceMax(value: number): number {
  if (value <= 0) return 10;
  const order = Math.pow(10, Math.floor(Math.log10(value)));
  const factor = value / order;
  if (factor <= 1) return order;
  if (factor <= 2) return 2 * order;
  if (factor <= 5) return 5 * order;
  return 10 * order;
}

/**
 * Generate evenly spaced tick values for the Y axis.
 * Aims for 4-6 ticks depending on available height.
 */
function generateTicks(min: number, max: number, count: number): number[] {
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => {
    const v = min + i * step;
    return Math.round(v * 100) / 100;
  });
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const BarChartRenderer: React.FC<WidgetRendererProps> = ({
  config,
  value,
  width,
  height,
  isEditing,
}) => {
  /* ---- Config extraction ---- */
  const label = (config.label as string) ?? 'Bar Chart';
  const orientation = (config.orientation as 'vertical' | 'horizontal') ?? 'vertical';
  const showGrid = (config.showGrid as boolean) ?? true;
  const showLabels = (config.showLabels as boolean) ?? true;
  const showValues = (config.showValues as boolean) ?? true;
  const yAxisMin = (config.yAxisMin as number) ?? 0;
  const yAxisMax = config.yAxisMax as number | undefined;
  const autoScale = (config.autoScale as boolean) ?? true;
  const barSpacing = (config.barSpacing as number) ?? 4;
  const animate = (config.animate as boolean) ?? true;

  const sources: BarSource[] = useMemo(() => {
    const raw = config.sources as BarSource[] | undefined;
    if (raw && raw.length > 0) return raw;
    // Default demo sources for edit mode preview
    return [
      { tagName: 'Temperature', label: 'Temperature', color: DEFAULT_COLORS[0] },
      { tagName: 'Pressure', label: 'Pressure', color: DEFAULT_COLORS[1] },
      { tagName: 'Flow', label: 'Flow', color: DEFAULT_COLORS[2] },
      { tagName: 'Level', label: 'Level', color: DEFAULT_COLORS[3] },
    ];
  }, [config.sources]);

  /* ---- Value resolution ---- */
  const barValues = useMemo(() => {
    if (isEditing) {
      // Deterministic demo data for consistent editor preview
      return sources.map((_, i) => 20 + ((i * 37 + 13) % 60));
    }
    // Runtime: value may be a JSON-encoded map from TagValueBus
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as Record<string, number>;
        return sources.map((s) => {
          const v = parsed[s.tagName];
          return typeof v === 'number' && !isNaN(v) ? v : 0;
        });
      } catch {
        return sources.map(() => 0);
      }
    }
    // Single numeric value: distribute to first bar only
    if (typeof value === 'number') {
      return sources.map((_, i) => (i === 0 ? value : 0));
    }
    return sources.map(() => 0);
  }, [isEditing, value, sources]);

  /* ---- Y axis domain ---- */
  const { yMin, yMax } = useMemo(() => {
    const dataMax = Math.max(...barValues, 0);
    const computedMax = autoScale ? niceMax(dataMax * 1.1) : (yAxisMax ?? 100);
    return { yMin: yAxisMin, yMax: Math.max(computedMax, yAxisMin + 1) };
  }, [barValues, autoScale, yAxisMin, yAxisMax]);

  /* ---- Layout constants ---- */
  const PAD = 8;
  const LABEL_H = 16;
  const MARGIN_LEFT = 36;
  const MARGIN_BOTTOM = showLabels ? 20 : 8;
  const MARGIN_TOP = LABEL_H + 4;
  const MARGIN_RIGHT = 8;

  const chartW = Math.max(width - PAD * 2 - MARGIN_LEFT - MARGIN_RIGHT, 10);
  const chartH = Math.max(height - PAD * 2 - MARGIN_TOP - MARGIN_BOTTOM, 10);

  /* ---- Scale functions ---- */
  const scaleY = useCallback(
    (v: number) => MARGIN_TOP + chartH - ((v - yMin) / (yMax - yMin)) * chartH,
    [chartH, yMin, yMax],
  );

  const scaleX = useCallback(
    (v: number) => MARGIN_LEFT + ((v - yMin) / (yMax - yMin)) * chartW,
    [chartW, yMin, yMax],
  );

  /* ---- Ticks ---- */
  const yTicks = useMemo(() => generateTicks(yMin, yMax, 5), [yMin, yMax]);

  /* ---- Bar geometry ---- */
  const isVertical = orientation === 'vertical';
  const barCount = sources.length;
  const totalSpace = isVertical ? chartW : chartH;
  const totalGap = barSpacing * (barCount + 1);
  const barThickness = Math.max(4, (totalSpace - totalGap) / barCount);

  /* ---- Transition style for smooth value updates ---- */
  const transitionStyle = animate
    ? { transition: 'height 300ms ease-out, width 300ms ease-out, y 300ms ease-out, x 300ms ease-out' }
    : {};

  const innerW = width - PAD * 2;
  const innerH = height - PAD * 2;

  return (
    <div style={{ width, height, padding: PAD, boxSizing: 'border-box' }}>
      <svg
        width={innerW}
        height={innerH}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* Title label */}
        <text
          x={innerW / 2}
          y={12}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="#374151"
        >
          {label}
        </text>

        {/* Grid lines */}
        {showGrid &&
          yTicks.map((tick) => {
            if (isVertical) {
              const y = scaleY(tick);
              return (
                <line
                  key={`grid-${tick}`}
                  x1={MARGIN_LEFT}
                  y1={y}
                  x2={MARGIN_LEFT + chartW}
                  y2={y}
                  stroke="#f3f4f6"
                  strokeWidth={1}
                />
              );
            }
            const x = scaleX(tick);
            return (
              <line
                key={`grid-${tick}`}
                x1={x}
                y1={MARGIN_TOP}
                x2={x}
                y2={MARGIN_TOP + chartH}
                stroke="#f3f4f6"
                strokeWidth={1}
              />
            );
          })}

        {/* Axes */}
        {isVertical ? (
          <>
            <line
              x1={MARGIN_LEFT}
              y1={MARGIN_TOP}
              x2={MARGIN_LEFT}
              y2={MARGIN_TOP + chartH}
              stroke="#d1d5db"
              strokeWidth={1}
            />
            <line
              x1={MARGIN_LEFT}
              y1={MARGIN_TOP + chartH}
              x2={MARGIN_LEFT + chartW}
              y2={MARGIN_TOP + chartH}
              stroke="#d1d5db"
              strokeWidth={1}
            />
          </>
        ) : (
          <>
            <line
              x1={MARGIN_LEFT}
              y1={MARGIN_TOP}
              x2={MARGIN_LEFT}
              y2={MARGIN_TOP + chartH}
              stroke="#d1d5db"
              strokeWidth={1}
            />
            <line
              x1={MARGIN_LEFT}
              y1={MARGIN_TOP + chartH}
              x2={MARGIN_LEFT + chartW}
              y2={MARGIN_TOP + chartH}
              stroke="#d1d5db"
              strokeWidth={1}
            />
          </>
        )}

        {/* Axis labels */}
        {yTicks.map((tick) => {
          if (isVertical) {
            return (
              <text
                key={`label-${tick}`}
                x={MARGIN_LEFT - 4}
                y={scaleY(tick) + 3}
                textAnchor="end"
                fontSize={8}
                fill="#9ca3af"
              >
                {tick % 1 === 0 ? tick : tick.toFixed(1)}
              </text>
            );
          }
          return (
            <text
              key={`label-${tick}`}
              x={scaleX(tick)}
              y={MARGIN_TOP + chartH + 14}
              textAnchor="middle"
              fontSize={8}
              fill="#9ca3af"
            >
              {tick % 1 === 0 ? tick : tick.toFixed(1)}
            </text>
          );
        })}

        {/* Bars */}
        {sources.map((source, i) => {
          const val = Math.max(yMin, Math.min(yMax, barValues[i]));
          const pct = (val - yMin) / (yMax - yMin);
          const color = source.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length];

          if (isVertical) {
            const barH = pct * chartH;
            const x = MARGIN_LEFT + barSpacing + i * (barThickness + barSpacing);
            const y = MARGIN_TOP + chartH - barH;

            return (
              <g key={source.tagName + i}>
                <rect
                  x={x}
                  y={y}
                  width={barThickness}
                  height={barH}
                  fill={color}
                  rx={2}
                  style={transitionStyle}
                />
                {/* Value label above bar */}
                {showValues && (
                  <text
                    x={x + barThickness / 2}
                    y={y - 3}
                    textAnchor="middle"
                    fontSize={8}
                    fontWeight={600}
                    fill="#374151"
                  >
                    {barValues[i].toFixed(1)}
                  </text>
                )}
                {/* Category label below axis */}
                {showLabels && (
                  <text
                    x={x + barThickness / 2}
                    y={MARGIN_TOP + chartH + 12}
                    textAnchor="middle"
                    fontSize={7}
                    fill="#6b7280"
                  >
                    {source.label.length > 8
                      ? source.label.slice(0, 7) + '...'
                      : source.label}
                  </text>
                )}
              </g>
            );
          }

          // Horizontal bars
          const barW = pct * chartW;
          const y = MARGIN_TOP + barSpacing + i * (barThickness + barSpacing);

          return (
            <g key={source.tagName + i}>
              <rect
                x={MARGIN_LEFT}
                y={y}
                width={barW}
                height={barThickness}
                fill={color}
                rx={2}
                style={transitionStyle}
              />
              {/* Value label at end of bar */}
              {showValues && (
                <text
                  x={MARGIN_LEFT + barW + 4}
                  y={y + barThickness / 2 + 3}
                  textAnchor="start"
                  fontSize={8}
                  fontWeight={600}
                  fill="#374151"
                >
                  {barValues[i].toFixed(1)}
                </text>
              )}
              {/* Category label on Y axis */}
              {showLabels && (
                <text
                  x={MARGIN_LEFT - 4}
                  y={y + barThickness / 2 + 3}
                  textAnchor="end"
                  fontSize={7}
                  fill="#6b7280"
                >
                  {source.label.length > 8
                    ? source.label.slice(0, 7) + '...'
                    : source.label}
                </text>
              )}
            </g>
          );
        })}

        {/* Edit mode indicator */}
        {isEditing && (
          <text
            x={innerW - 4}
            y={12}
            textAnchor="end"
            fontSize={8}
            fill="#9ca3af"
            fontStyle="italic"
          >
            demo
          </text>
        )}
      </svg>
    </div>
  );
};

BarChartRenderer.displayName = 'BarChartRenderer';
export default memo(BarChartRenderer);
