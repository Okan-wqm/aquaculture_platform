/**
 * PieChartRenderer - SVG pie/donut chart for proportional data visualization.
 * Computes arc paths from tag values using trigonometric functions.
 *
 * Architecture: Each slice is an SVG <path> with arc commands.
 * Slice angles are proportional to tag values relative to total.
 * Supports donut mode via configurable innerRadius.
 *
 * All geometry is computed in pure SVG -- no external chart library.
 */

import React, { memo, useMemo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface PieSource {
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
 * Convert polar coordinates to cartesian for SVG path commands.
 * centerX/Y define the origin, radius the distance, angle in radians.
 */
function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleRad: number,
): { x: number; y: number } {
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad),
  };
}

/**
 * Build an SVG arc path for a pie/donut slice.
 * Uses the large-arc-flag to handle slices > 180 degrees.
 * For donut mode, the path traces outer arc forward and inner arc backward,
 * creating a closed ring segment.
 */
function describeArc(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngle: number,
  endAngle: number,
): string {
  const outerStart = polarToCartesian(cx, cy, outerR, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerR, endAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

  if (innerR <= 0) {
    // Full pie slice: line from center to arc start, arc, line back to center
    return [
      `M ${cx} ${cy}`,
      `L ${outerStart.x} ${outerStart.y}`,
      `A ${outerR} ${outerR} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
      'Z',
    ].join(' ');
  }

  // Donut slice: outer arc forward, inner arc backward
  const innerStart = polarToCartesian(cx, cy, innerR, endAngle);
  const innerEnd = polarToCartesian(cx, cy, innerR, startAngle);

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerStart.x} ${innerStart.y}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${innerEnd.x} ${innerEnd.y}`,
    'Z',
  ].join(' ');
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const PieChartRenderer: React.FC<WidgetRendererProps> = ({
  config,
  value,
  width,
  height,
  isEditing,
}) => {
  /* ---- Config extraction ---- */
  const label = (config.label as string) ?? 'Pie Chart';
  const showLabels = (config.showLabels as boolean) ?? true;
  const showLegend = (config.showLegend as boolean) ?? true;
  const showValues = (config.showValues as boolean) ?? false;
  const innerRadius = (config.innerRadius as number) ?? 0; // 0 = pie, >0 = donut
  const startAngle = ((config.startAngle as number) ?? -90) * (Math.PI / 180);
  const animate = (config.animate as boolean) ?? true;

  const sources: PieSource[] = useMemo(() => {
    const raw = config.sources as PieSource[] | undefined;
    if (raw && raw.length > 0) return raw;
    return [
      { tagName: 'Oxygen', label: 'Oxygen', color: DEFAULT_COLORS[0] },
      { tagName: 'Nitrogen', label: 'Nitrogen', color: DEFAULT_COLORS[1] },
      { tagName: 'CO2', label: 'CO2', color: DEFAULT_COLORS[2] },
      { tagName: 'Other', label: 'Other', color: DEFAULT_COLORS[3] },
    ];
  }, [config.sources]);

  /* ---- Value resolution ---- */
  const sliceValues = useMemo(() => {
    if (isEditing) {
      // Deterministic demo data with varied proportions
      return sources.map((_, i) => [35, 25, 22, 18, 15, 12, 10, 8][i % 8]);
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as Record<string, number>;
        return sources.map((s) => {
          const v = parsed[s.tagName];
          return typeof v === 'number' && !isNaN(v) && v >= 0 ? v : 0;
        });
      } catch {
        return sources.map(() => 0);
      }
    }
    if (typeof value === 'number') {
      return sources.map((_, i) => (i === 0 ? value : 0));
    }
    return sources.map(() => 0);
  }, [isEditing, value, sources]);

  /* ---- Compute slice angles ---- */
  const total = useMemo(
    () => sliceValues.reduce((acc, v) => acc + v, 0),
    [sliceValues],
  );

  const slices = useMemo(() => {
    if (total <= 0) return [];
    let currentAngle = startAngle;
    return sources.map((source, i) => {
      const fraction = sliceValues[i] / total;
      // Clamp to avoid floating point issues for very small slices
      const sweep = fraction * Math.PI * 2;
      const sliceStart = currentAngle;
      const sliceEnd = currentAngle + sweep;
      currentAngle = sliceEnd;
      return {
        source,
        value: sliceValues[i],
        fraction,
        startAngle: sliceStart,
        endAngle: sliceEnd,
        color: source.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length],
      };
    });
  }, [sources, sliceValues, total, startAngle]);

  /* ---- Layout ---- */
  const PAD = 8;
  const TITLE_H = 16;
  const LEGEND_H = showLegend ? Math.min(sources.length * 14 + 4, 60) : 0;
  const availW = width - PAD * 2;
  const availH = height - PAD * 2 - TITLE_H - LEGEND_H;
  const radius = Math.max(10, Math.min(availW, availH) / 2 - 4);
  const cx = availW / 2;
  const cy = TITLE_H + availH / 2;
  const innerR = innerRadius > 0 ? Math.min(innerRadius, radius - 4) : 0;

  return (
    <div style={{ width, height, padding: PAD, boxSizing: 'border-box' }}>
      <svg
        width={availW}
        height={height - PAD * 2}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* Title */}
        <text
          x={availW / 2}
          y={12}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="#374151"
        >
          {label}
        </text>

        {/* Slices */}
        {slices.map((slice, i) => {
          // Handle the edge case where one slice is 100%
          if (slice.fraction >= 0.9999) {
            return (
              <g key={slice.source.tagName + i}>
                {innerR > 0 ? (
                  <>
                    <circle cx={cx} cy={cy} r={radius} fill={slice.color} />
                    <circle cx={cx} cy={cy} r={innerR} fill="white" />
                  </>
                ) : (
                  <circle cx={cx} cy={cy} r={radius} fill={slice.color} />
                )}
              </g>
            );
          }

          // Skip zero-value slices to avoid degenerate paths
          if (slice.fraction <= 0.001) return null;

          const d = describeArc(
            cx,
            cy,
            radius,
            innerR,
            slice.startAngle,
            slice.endAngle,
          );

          // Label position: midpoint of the slice, at 65% of radius
          const midAngle = (slice.startAngle + slice.endAngle) / 2;
          const labelR = innerR > 0 ? (radius + innerR) / 2 : radius * 0.65;
          const labelPos = polarToCartesian(cx, cy, labelR, midAngle);

          return (
            <g key={slice.source.tagName + i}>
              <path
                d={d}
                fill={slice.color}
                stroke="white"
                strokeWidth={1.5}
                style={
                  animate
                    ? { transition: 'd 300ms ease-out' }
                    : undefined
                }
              />
              {/* Percentage label inside slice */}
              {showLabels && slice.fraction > 0.05 && (
                <text
                  x={labelPos.x}
                  y={labelPos.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={Math.min(9, radius * 0.15)}
                  fontWeight={600}
                  fill="white"
                  style={{ pointerEvents: 'none' }}
                >
                  {(slice.fraction * 100).toFixed(0)}%
                </text>
              )}
            </g>
          );
        })}

        {/* No data placeholder */}
        {total <= 0 && (
          <>
            <circle
              cx={cx}
              cy={cy}
              r={radius}
              fill="#f3f4f6"
              stroke="#e5e7eb"
              strokeWidth={1}
            />
            <text
              x={cx}
              y={cy}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={10}
              fill="#9ca3af"
            >
              No data
            </text>
          </>
        )}

        {/* Center label for donut mode */}
        {innerR > 0 && total > 0 && showValues && (
          <text
            x={cx}
            y={cy}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={Math.min(14, innerR * 0.5)}
            fontWeight={700}
            fill="#374151"
          >
            {total.toFixed(0)}
          </text>
        )}

        {/* Legend */}
        {showLegend && (
          <foreignObject
            x={0}
            y={height - PAD * 2 - LEGEND_H}
            width={availW}
            height={LEGEND_H}
          >
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                fontSize: 8,
                color: '#6b7280',
                justifyContent: 'center',
                padding: '2px 0',
              }}
            >
              {sources.map((source, i) => (
                <span
                  key={source.tagName + i}
                  style={{ display: 'flex', alignItems: 'center', gap: 2 }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background:
                        source.color ||
                        DEFAULT_COLORS[i % DEFAULT_COLORS.length],
                      display: 'inline-block',
                      flexShrink: 0,
                    }}
                  />
                  {source.label}
                  {showValues && sliceValues[i] > 0 && (
                    <span style={{ color: '#9ca3af', marginLeft: 2 }}>
                      ({sliceValues[i].toFixed(1)})
                    </span>
                  )}
                </span>
              ))}
            </div>
          </foreignObject>
        )}

        {/* Edit mode indicator */}
        {isEditing && (
          <text
            x={availW - 4}
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

PieChartRenderer.displayName = 'PieChartRenderer';
export default memo(PieChartRenderer);
