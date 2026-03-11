/**
 * GaugeRenderer - SVG half-circle gauge with value, unit, min/max labels,
 * and color thresholds. NaN-safe numeric parsing.
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const GaugeRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const min = (config.min ?? 0) as number;
  const max = (config.max ?? 100) as number;
  const unit = (config.unit ?? '') as string;
  const label = (config.label ?? 'Gauge') as string;
  const warningThreshold = (config.warningThreshold ?? 70) as number;
  const criticalThreshold = (config.criticalThreshold ?? 90) as number;

  const raw = isEditing ? (config.demoValue ?? 42) : Number(value ?? 0);
  const numValue = typeof raw === 'number' && !isNaN(raw) ? raw : 0;
  const safeValue = isNaN(numValue) ? 0 : numValue;

  // Responsive font sizes
  const h = height - 16; // account for padding
  const valueFontSize = Math.min(h * 0.18, 24);
  const labelFontSize = Math.min(h * 0.08, 11);
  const minMaxFontSize = Math.min(h * 0.07, 10);
  const pct = Math.max(0, Math.min(1, (safeValue - min) / (max - min || 1)));

  // Arc geometry (half-circle, 180 deg from left to right)
  const cx = 100;
  const cy = 95;
  const r = 70;
  const startAngle = Math.PI; // 180 deg
  const endAngle = 0;
  const sweepAngle = startAngle - (startAngle - endAngle) * pct;

  const arcX = (a: number) => cx + r * Math.cos(a);
  const arcY = (a: number) => cy - r * Math.sin(a);

  // Color based on thresholds
  const warningPct = Math.max(0, Math.min(1, (warningThreshold - min) / (max - min || 1)));
  const criticalPct = Math.max(0, Math.min(1, (criticalThreshold - min) / (max - min || 1)));
  let color = '#22c55e'; // green
  if (pct >= criticalPct) color = '#ef4444'; // red
  else if (pct >= warningPct) color = '#eab308'; // yellow

  // Build background arc path
  const bgPath = `M ${arcX(startAngle)} ${arcY(startAngle)} A ${r} ${r} 0 0 1 ${arcX(endAngle)} ${arcY(endAngle)}`;

  // Build value arc path
  const largeArc = pct > 0.5 ? 1 : 0;
  const valPath = pct > 0
    ? `M ${arcX(startAngle)} ${arcY(startAngle)} A ${r} ${r} 0 ${largeArc} 1 ${arcX(sweepAngle)} ${arcY(sweepAngle)}`
    : '';

  return (
    <div style={{ width, height, padding: 8, boxSizing: 'border-box' }}>
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 200 130"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
      >
        {/* Background arc */}
        <path d={bgPath} fill="none" stroke="#e5e7eb" strokeWidth={12} strokeLinecap="round" />

        {/* Value arc */}
        {valPath && (
          <path d={valPath} fill="none" stroke={color} strokeWidth={12} strokeLinecap="round" />
        )}

        {/* Value text */}
        <text x={cx} y={cy - 10} textAnchor="middle" fontSize={valueFontSize} fontWeight={700} fill="#111827">
          {safeValue.toFixed(1)}
        </text>

        {/* Unit */}
        <text x={cx} y={cy + 10} textAnchor="middle" fontSize={labelFontSize} fill="#6b7280">
          {unit}
        </text>

        {/* Label */}
        <text x={cx} y={125} textAnchor="middle" fontSize={minMaxFontSize} fill="#9ca3af">
          {label}
        </text>

        {/* Min / Max */}
        <text x={arcX(startAngle) - 2} y={arcY(startAngle) + 14} textAnchor="end" fontSize={minMaxFontSize} fill="#9ca3af">
          {min}
        </text>
        <text x={arcX(endAngle) + 2} y={arcY(endAngle) + 14} textAnchor="start" fontSize={minMaxFontSize} fill="#9ca3af">
          {max}
        </text>
      </svg>
    </div>
  );
};

GaugeRenderer.displayName = 'GaugeRenderer';
export default memo(GaugeRenderer);
