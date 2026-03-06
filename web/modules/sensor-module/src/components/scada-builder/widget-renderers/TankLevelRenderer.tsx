/**
 * TankLevelRenderer - SVG tank fill animation + percentage text
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const TankLevelRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const label = config.label ?? 'Tank';
  const unit = config.unit ?? '%';
  const max = config.max ?? 100;
  const numericValue = isEditing ? (config.demoValue ?? 65) : Number(value ?? 0);
  const pct = Math.max(0, Math.min(1, numericValue / (max || 1)));

  const tankW = 60;
  const tankH = 100;
  const fillH = tankH * pct;
  const padTop = 20;

  // Color gradient based on level
  let fillColor = '#3b82f6';
  if (pct > 0.85) fillColor = '#ef4444';
  else if (pct > 0.7) fillColor = '#eab308';

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 100 ${tankH + padTop + 30}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block' }}
    >
      {/* Label */}
      <text x={50} y={14} textAnchor="middle" fontSize={10} fill="#6b7280" fontWeight={500}>
        {label}
      </text>

      {/* Tank outline */}
      <rect
        x={20}
        y={padTop}
        width={tankW}
        height={tankH}
        rx={4}
        fill="#f1f5f9"
        stroke="#cbd5e1"
        strokeWidth={2}
      />

      {/* Fill */}
      <rect
        x={22}
        y={padTop + (tankH - fillH)}
        width={tankW - 4}
        height={fillH}
        rx={2}
        fill={fillColor}
        opacity={0.8}
      />

      {/* Percentage text */}
      <text x={50} y={padTop + tankH / 2 + 4} textAnchor="middle" fontSize={16} fontWeight={700} fill="#111827">
        {Math.round(pct * 100)}
      </text>
      <text x={50} y={padTop + tankH / 2 + 18} textAnchor="middle" fontSize={10} fill="#6b7280">
        {unit}
      </text>

      {/* Scale marks */}
      <text x={84} y={padTop + 8} fontSize={8} fill="#9ca3af">{max}</text>
      <text x={84} y={padTop + tankH} fontSize={8} fill="#9ca3af">0</text>
    </svg>
  );
};

TankLevelRenderer.displayName = 'TankLevelRenderer';
export default memo(TankLevelRenderer);
