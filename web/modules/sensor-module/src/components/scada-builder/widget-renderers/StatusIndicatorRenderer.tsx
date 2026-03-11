/**
 * StatusIndicatorRenderer - Colored circle (green/red/yellow) + label
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const STATUS_COLORS: Record<string, string> = {
  normal: '#22c55e',
  ok: '#22c55e',
  warning: '#eab308',
  alarm: '#ef4444',
  critical: '#ef4444',
  offline: '#9ca3af',
};

const StatusIndicatorRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const label = (config.label ?? 'Status') as string;
  const statusValue = (isEditing ? (config.demoStatus ?? 'normal') : String(value ?? 'offline')) as string;
  const color = STATUS_COLORS[statusValue.toLowerCase()] ?? '#9ca3af';
  const circleR = Math.min(width, height) * 0.22;

  return (
    <div
      style={{
        width,
        height,
        padding: 8,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <svg width={circleR * 2 + 8} height={circleR * 2 + 8}>
        {/* Glow */}
        <circle cx={circleR + 4} cy={circleR + 4} r={circleR + 2} fill={color} opacity={0.2} />
        {/* Main circle */}
        <circle cx={circleR + 4} cy={circleR + 4} r={circleR} fill={color} />
      </svg>
      <span style={{ fontSize: 11, fontWeight: 500, color: '#374151', textAlign: 'center' }}>
        {label}
      </span>
    </div>
  );
};

StatusIndicatorRenderer.displayName = 'StatusIndicatorRenderer';
export default memo(StatusIndicatorRenderer);
