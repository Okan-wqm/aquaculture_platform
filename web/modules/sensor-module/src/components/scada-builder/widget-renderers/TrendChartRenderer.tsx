/**
 * TrendChartRenderer - Simple SVG polyline chart placeholder
 */

import React, { memo, useMemo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const TrendChartRenderer: React.FC<WidgetRendererProps> = ({ config, width, height, isEditing }) => {
  const label = config.label ?? 'Trend';
  const color = config.color ?? '#3b82f6';

  // Generate demo data points
  const points = useMemo(() => {
    const pts: { x: number; y: number }[] = [];
    const padX = 30;
    const padTop = 28;
    const padBottom = 22;
    const chartW = width - padX - 10;
    const chartH = height - padTop - padBottom;
    const count = 20;
    for (let i = 0; i < count; i++) {
      const x = padX + (i / (count - 1)) * chartW;
      // Sine wave demo
      const y = padTop + chartH / 2 - Math.sin(i * 0.5 + 1) * chartH * 0.3 + (Math.random() - 0.5) * chartH * 0.1;
      pts.push({ x, y });
    }
    return pts;
  }, [width, height]);

  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const padX = 30;
  const padTop = 28;
  const padBottom = 22;
  const chartH = height - padTop - padBottom;

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {/* Label */}
      <text x={width / 2} y={16} textAnchor="middle" fontSize={11} fill="#374151" fontWeight={600}>
        {label}
      </text>

      {/* Y axis */}
      <line x1={padX} y1={padTop} x2={padX} y2={padTop + chartH} stroke="#d1d5db" strokeWidth={1} />
      {/* X axis */}
      <line x1={padX} y1={padTop + chartH} x2={width - 10} y2={padTop + chartH} stroke="#d1d5db" strokeWidth={1} />

      {/* Grid lines */}
      {[0.25, 0.5, 0.75].map((frac) => (
        <line
          key={frac}
          x1={padX}
          y1={padTop + chartH * frac}
          x2={width - 10}
          y2={padTop + chartH * frac}
          stroke="#f3f4f6"
          strokeWidth={1}
        />
      ))}

      {/* Data line */}
      <polyline points={polyline} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />

      {/* Time labels */}
      <text x={padX} y={height - 4} fontSize={8} fill="#9ca3af">00:00</text>
      <text x={width - 10} y={height - 4} textAnchor="end" fontSize={8} fill="#9ca3af">now</text>

      {/* Demo badge */}
      {isEditing && (
        <text x={width - 12} y={16} textAnchor="end" fontSize={8} fill="#9ca3af" fontStyle="italic">
          demo
        </text>
      )}
    </svg>
  );
};

TrendChartRenderer.displayName = 'TrendChartRenderer';
export default memo(TrendChartRenderer);
