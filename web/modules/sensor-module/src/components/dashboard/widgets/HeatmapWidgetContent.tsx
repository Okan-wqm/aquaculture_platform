/**
 * Heatmap Widget Content
 *
 * Canvas-based heatmap that renders sensor readings as a 2D color grid.
 * X-axis: time buckets (auto-sized to widget's timeRange)
 * Y-axis: sensors / data channels
 * Color scale: blue (low) → green (normal) → red (high)
 */

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { WidgetConfig, TimeRange } from '../types';
import { useWidgetData, HistoryPoint } from '../../../hooks/useWidgetData';

interface HeatmapWidgetContentProps {
  config: WidgetConfig;
}

// ============================================================================
// Color scale helpers
// ============================================================================

type ColorScale = 'blues' | 'greens' | 'reds' | 'viridis';

/**
 * Clamp t to [0, 1] and interpolate between two RGB colors.
 */
function lerp(a: [number, number, number], b: [number, number, number], t: number): string {
  const c = (i: number) => Math.round(a[i] + (b[i] - a[i]) * t);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}

/**
 * Map a normalized value (0-1) to a color string using the chosen scale.
 */
function colorFromScale(t: number, scale: ColorScale): string {
  const v = Math.max(0, Math.min(1, t));

  switch (scale) {
    case 'blues':
      return lerp([219, 234, 254], [29, 78, 216], v);   // blue-100 → blue-700
    case 'greens':
      return lerp([220, 252, 231], [21, 128, 61], v);   // green-100 → green-700
    case 'reds':
      return lerp([254, 226, 226], [185, 28, 28], v);   // red-100 → red-700
    case 'viridis':
    default: {
      // Three-stop viridis-like: blue → green → yellow-red
      if (v < 0.5) {
        const t2 = v * 2;
        return lerp([68, 1, 84], [33, 145, 140], t2);   // purple → teal
      }
      const t2 = (v - 0.5) * 2;
      return lerp([33, 145, 140], [253, 231, 37], t2);  // teal → yellow
    }
  }
}

// ============================================================================
// Time range helpers
// ============================================================================

function getTimeRangeMs(timeRange: TimeRange): number {
  const ranges: Record<TimeRange, number> = {
    live: 5 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  return ranges[timeRange] || ranges['1h'];
}

/** Choose a sensible number of time buckets based on the time range. */
function getBucketCount(timeRange: TimeRange): number {
  const counts: Record<TimeRange, number> = {
    live: 10,
    '1h': 12,
    '6h': 18,
    '24h': 24,
    '7d': 28,
    '30d': 30,
  };
  return counts[timeRange] || 12;
}

// ============================================================================
// Data grouping
// ============================================================================

interface HeatmapCell {
  sensorId: string;
  sensorLabel: string;
  bucketIndex: number;
  value: number;
  timestamp: Date;
}

interface HeatmapGrid {
  sensors: string[];         // ordered list of sensor labels (Y-axis)
  buckets: Date[];           // ordered list of bucket start times (X-axis)
  cells: HeatmapCell[];
  minValue: number;
  maxValue: number;
}

function buildGrid(history: HistoryPoint[], timeRange: TimeRange): HeatmapGrid {
  const now = new Date();
  const rangeMs = getTimeRangeMs(timeRange);
  const startTime = new Date(now.getTime() - rangeMs);
  const bucketCount = getBucketCount(timeRange);
  const bucketMs = rangeMs / bucketCount;

  // Build bucket start times
  const buckets: Date[] = Array.from({ length: bucketCount }, (_, i) =>
    new Date(startTime.getTime() + i * bucketMs)
  );

  // Collect unique sensor labels
  const sensorOrder = new Map<string, string>(); // sensorId → display label
  for (const pt of history) {
    const label = pt.channelLabel
      ? `${pt.sensorName} - ${pt.channelLabel}`
      : pt.sensorName;
    if (!sensorOrder.has(pt.sensorId)) {
      sensorOrder.set(pt.sensorId, label);
    }
  }
  const sensors = Array.from(sensorOrder.values());

  // Accumulate average value per (sensor, bucket)
  const accumulator = new Map<string, { sum: number; count: number }>();

  for (const pt of history) {
    const bucketIdx = Math.floor(
      (pt.timestamp.getTime() - startTime.getTime()) / bucketMs
    );
    if (bucketIdx < 0 || bucketIdx >= bucketCount) continue;

    const label = sensorOrder.get(pt.sensorId) || pt.sensorName;
    const key = `${label}::${bucketIdx}`;
    const existing = accumulator.get(key) || { sum: 0, count: 0 };
    existing.sum += pt.value;
    existing.count += 1;
    accumulator.set(key, existing);
  }

  // Build cells
  const cells: HeatmapCell[] = [];
  let minValue = Infinity;
  let maxValue = -Infinity;

  for (const [key, { sum, count }] of accumulator) {
    const separatorIdx = key.lastIndexOf('::');
    const sensorLabel = key.slice(0, separatorIdx);
    const bucketIndex = parseInt(key.slice(separatorIdx + 2), 10);
    const value = sum / count;

    if (value < minValue) minValue = value;
    if (value > maxValue) maxValue = value;

    cells.push({
      sensorId: sensorLabel,
      sensorLabel,
      bucketIndex,
      value,
      timestamp: buckets[bucketIndex],
    });
  }

  if (!isFinite(minValue)) minValue = 0;
  if (!isFinite(maxValue)) maxValue = 1;
  if (minValue === maxValue) maxValue = minValue + 1;

  return { sensors, buckets, cells, minValue, maxValue };
}

// ============================================================================
// Tooltip
// ============================================================================

interface TooltipState {
  x: number;
  y: number;
  label: string;
  value: number;
  unit: string;
  timestamp: Date;
}

// ============================================================================
// Fallback table view (when canvas is unsupported)
// ============================================================================

const FallbackTable: React.FC<{ grid: HeatmapGrid; scale: ColorScale }> = ({ grid, scale }) => (
  <div className="overflow-auto h-full text-xs">
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className="text-left p-1 font-medium text-gray-600 sticky left-0 bg-white">Sensor</th>
          {grid.buckets.slice(0, 8).map((b, i) => (
            <th key={i} className="p-1 font-medium text-gray-500 text-center">
              {b.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {grid.sensors.map((sensor) => (
          <tr key={sensor}>
            <td className="p-1 font-medium text-gray-700 sticky left-0 bg-white truncate max-w-[80px]" title={sensor}>
              {sensor}
            </td>
            {grid.buckets.slice(0, 8).map((_, bucketIdx) => {
              const cell = grid.cells.find(
                (c) => c.sensorLabel === sensor && c.bucketIndex === bucketIdx
              );
              const normalized = cell
                ? (cell.value - grid.minValue) / (grid.maxValue - grid.minValue)
                : null;
              return (
                <td
                  key={bucketIdx}
                  className="p-1 text-center"
                  style={{
                    backgroundColor: normalized !== null ? colorFromScale(normalized, scale) : '#f3f4f6',
                    color: normalized !== null && normalized > 0.6 ? '#fff' : '#374151',
                  }}
                >
                  {cell ? cell.value.toFixed(1) : '—'}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

// ============================================================================
// Canvas heatmap
// ============================================================================

const LABEL_WIDTH = 90;    // px reserved for Y-axis labels
const HEADER_HEIGHT = 24;  // px reserved for X-axis labels
const MIN_CELL_HEIGHT = 16;

interface CanvasHeatmapProps {
  grid: HeatmapGrid;
  scale: ColorScale;
  onTooltip: (tt: TooltipState | null) => void;
  unit: string;
}

const CanvasHeatmap: React.FC<CanvasHeatmapProps> = ({ grid, scale, onTooltip, unit }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const cellMapRef = useRef<Map<string, HeatmapCell>>(new Map());

  const draw = useCallback((width: number, height: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const { sensors, buckets, cells, minValue, maxValue } = grid;
    if (sensors.length === 0 || buckets.length === 0) {
      ctx.fillStyle = '#f3f4f6';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#9ca3af';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data in selected range', width / 2, height / 2);
      return;
    }

    const gridWidth = width - LABEL_WIDTH;
    const gridHeight = height - HEADER_HEIGHT;
    const cellWidth = gridWidth / buckets.length;
    const cellHeight = Math.max(MIN_CELL_HEIGHT, gridHeight / sensors.length);

    // Background
    ctx.fillStyle = '#f9fafb';
    ctx.fillRect(0, 0, width, height);

    // Build lookup for quick access (also stored in ref for mouse handler)
    const cellMap = new Map<string, HeatmapCell>();
    for (const cell of cells) {
      cellMap.set(`${cell.sensorLabel}::${cell.bucketIndex}`, cell);
    }
    cellMapRef.current = cellMap;

    // Draw cells
    for (let si = 0; si < sensors.length; si++) {
      for (let bi = 0; bi < buckets.length; bi++) {
        const cell = cellMap.get(`${sensors[si]}::${bi}`);
        const x = LABEL_WIDTH + bi * cellWidth;
        const y = HEADER_HEIGHT + si * cellHeight;

        if (cell) {
          const normalized = (cell.value - minValue) / (maxValue - minValue);
          ctx.fillStyle = colorFromScale(normalized, scale);
        } else {
          ctx.fillStyle = '#e5e7eb'; // empty bucket
        }

        ctx.fillRect(x + 0.5, y + 0.5, cellWidth - 1, cellHeight - 1);
      }
    }

    // Y-axis labels
    ctx.fillStyle = '#374151';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let si = 0; si < sensors.length; si++) {
      const y = HEADER_HEIGHT + si * cellHeight + cellHeight / 2;
      const label = sensors[si].length > 14 ? sensors[si].slice(0, 13) + '…' : sensors[si];
      ctx.fillText(label, LABEL_WIDTH - 4, y);
    }

    // X-axis labels (show ~6 evenly spaced)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#6b7280';
    ctx.font = '9px sans-serif';
    const labelStep = Math.max(1, Math.floor(buckets.length / 6));
    for (let bi = 0; bi < buckets.length; bi += labelStep) {
      const x = LABEL_WIDTH + bi * cellWidth + cellWidth / 2;
      const label = buckets[bi].toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(label, x, 4);
    }
  }, [grid, scale]);

  // ResizeObserver for responsive canvas
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => draw(Math.floor(width), Math.floor(height)));
    });

    observer.observe(container);
    // Initial draw
    draw(container.clientWidth, container.clientHeight);

    return () => {
      observer.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [draw]);

  // Mouse move handler for tooltip — uses O(1) cellMap lookup instead of O(N) cells.find()
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const { sensors, buckets } = grid;
    if (sensors.length === 0 || buckets.length === 0) return;

    // Use CSS dimensions (rect) for hit-testing, not canvas.width which includes DPR scaling
    const cssWidth = rect.width;
    const cssHeight = rect.height;
    const gridWidth = cssWidth - LABEL_WIDTH;
    const gridHeight = cssHeight - HEADER_HEIGHT;
    const cellWidth = gridWidth / buckets.length;
    const cellHeight = Math.max(MIN_CELL_HEIGHT, gridHeight / sensors.length);

    const relX = mx - LABEL_WIDTH;
    const relY = my - HEADER_HEIGHT;
    if (relX < 0 || relY < 0) { onTooltip(null); return; }

    const si = Math.floor(relY / cellHeight);
    const bi = Math.floor(relX / cellWidth);
    if (si < 0 || si >= sensors.length || bi < 0 || bi >= buckets.length) {
      onTooltip(null);
      return;
    }

    const key = `${sensors[si]}::${bi}`;
    const cell = cellMapRef.current.get(key);
    if (cell) {
      onTooltip({
        x: e.clientX,
        y: e.clientY,
        label: cell.sensorLabel,
        value: cell.value,
        unit,
        timestamp: cell.timestamp,
      });
    } else {
      onTooltip(null);
    }
  }, [grid, onTooltip, unit]);

  return (
    <div ref={containerRef} className="w-full h-full">
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => onTooltip(null)}
      />
    </div>
  );
};

// ============================================================================
// Main component
// ============================================================================

export const HeatmapWidgetContent: React.FC<HeatmapWidgetContentProps> = ({ config }) => {
  const { history, loading, error } = useWidgetData(config);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const colorScale: ColorScale = config.settings?.heatmapColorScale || 'viridis';
  const canvasSupported = typeof HTMLCanvasElement !== 'undefined';

  // Derive unit from first history point or selected channels
  const unit = useMemo(() => {
    if (history.length > 0 && history[0].unit) return history[0].unit;
    if (config.selectedChannels && config.selectedChannels.length > 0) {
      return config.selectedChannels[0].unit || '';
    }
    return '';
  }, [history, config.selectedChannels]);

  const grid = useMemo(() => buildGrid(history, config.timeRange), [history, config.timeRange]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-6 h-6 border-2 border-cyan-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-500 text-sm">
        {error}
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        No historical data available
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      {canvasSupported ? (
        <CanvasHeatmap
          grid={grid}
          scale={colorScale}
          onTooltip={setTooltip}
          unit={unit}
        />
      ) : (
        <FallbackTable grid={grid} scale={colorScale} />
      )}

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-gray-900 text-white text-xs rounded-lg px-2.5 py-2 shadow-lg"
          style={{ left: tooltip.x + 12, top: tooltip.y - 8 }}
        >
          <div className="font-semibold truncate max-w-[160px]">{tooltip.label}</div>
          <div className="mt-0.5">
            {tooltip.value.toFixed(2)}{tooltip.unit && ` ${tooltip.unit}`}
          </div>
          <div className="text-gray-400 mt-0.5">
            {tooltip.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      )}

      {/* Min/Max legend strip */}
      <div className="absolute bottom-0 right-0 flex items-center gap-1 px-1 py-0.5 bg-white/80 rounded text-[9px] text-gray-500">
        <span>{grid.minValue.toFixed(1)}</span>
        <div
          className="w-16 h-2 rounded"
          style={{
            background: `linear-gradient(to right, ${colorFromScale(0, colorScale)}, ${colorFromScale(0.5, colorScale)}, ${colorFromScale(1, colorScale)})`,
          }}
        />
        <span>{grid.maxValue.toFixed(1)}</span>
      </div>
    </div>
  );
};

export default HeatmapWidgetContent;
