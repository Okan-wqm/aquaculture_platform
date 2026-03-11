/**
 * TrendChartRenderer - Simple SVG polyline chart placeholder.
 * Uses deterministic pseudo-random seed instead of Math.random().
 */

import React, { memo, useMemo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const TrendChartRenderer: React.FC<WidgetRendererProps> = ({ config, width, height, isEditing }) => {
  const label = (config.label ?? 'Trend') as string;
  const color = (config.color ?? '#3b82f6') as string;

  const innerW = width - 16; // account for 8px padding
  const innerH = height - 16;

  // Generate demo data points with deterministic noise
  const points = useMemo(() => {
    const pts: { x: number; y: number }[] = [];
    const padX = Math.min(innerW * 0.12, 30);
    const padTop = 28;
    const padBottom = 22;
    const chartW = innerW - padX - 10;
    const chartH = innerH - padTop - padBottom;
    const count = 20;
    for (let i = 0; i < count; i++) {
      const x = padX + (i / (count - 1)) * chartW;
      // Deterministic noise based on index
      const noise = (Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1;
      const y = padTop + chartH / 2 - Math.sin(i * 0.5 + 1) * chartH * 0.3 + (noise - 0.5) * chartH * 0.1;
      pts.push({ x, y });
    }
    return pts;
  }, [innerW, innerH]);

  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const padX = Math.min(innerW * 0.12, 30);
  const padTop = 28;
  const padBottom = 22;
  const chartH = innerH - padTop - padBottom;

  return (
    <div style={{ width, height, padding: 8, boxSizing: 'border-box' }}>
      <svg width={innerW} height={innerH} style={{ display: 'block' }}>
        {/* Label */}
        <text x={innerW / 2} y={16} textAnchor="middle" fontSize={11} fill="#374151" fontWeight={600}>
          {label}
        </text>

        {/* Y axis */}
        <line x1={padX} y1={padTop} x2={padX} y2={padTop + chartH} stroke="#d1d5db" strokeWidth={1} />
        {/* X axis */}
        <line x1={padX} y1={padTop + chartH} x2={innerW - 10} y2={padTop + chartH} stroke="#d1d5db" strokeWidth={1} />

        {/* Grid lines */}
        {[0.25, 0.5, 0.75].map((frac) => (
          <line
            key={frac}
            x1={padX}
            y1={padTop + chartH * frac}
            x2={innerW - 10}
            y2={padTop + chartH * frac}
            stroke="#f3f4f6"
            strokeWidth={1}
          />
        ))}

        {/* Data line */}
        <polyline points={polyline} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />

        {/* Time labels */}
        <text x={padX} y={innerH - 4} fontSize={8} fill="#9ca3af">00:00</text>
        <text x={innerW - 10} y={innerH - 4} textAnchor="end" fontSize={8} fill="#9ca3af">now</text>

        {/* Demo badge */}
        {isEditing && (
          <text x={innerW - 12} y={16} textAnchor="end" fontSize={8} fill="#9ca3af" fontStyle="italic">
            demo
          </text>
        )}
      </svg>
    </div>
  );
};

TrendChartRenderer.displayName = 'TrendChartRenderer';
export default memo(TrendChartRenderer);
