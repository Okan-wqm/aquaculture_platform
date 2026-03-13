/**
 * StatusIndicatorRenderer - Colored circle (green/red/yellow) + label
 * Supports boolean/numeric values for SCADA simulation (pump, lamp signals).
 */

import React, { memo, useId } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const STATUS_COLORS: Record<string, string> = {
  normal: '#22c55e',
  ok: '#22c55e',
  warning: '#eab308',
  alarm: '#ef4444',
  critical: '#ef4444',
  offline: '#9ca3af',
};

/**
 * Resolve raw value (boolean, number, string) into a status key.
 * - true / 1  -> 'normal'
 * - false / 0 -> 'offline'
 * - string    -> used as-is (lowercased) for STATUS_COLORS lookup
 */
function resolveStatus(raw: unknown): string {
  if (raw === null || raw === undefined) return 'offline';
  if (typeof raw === 'boolean') return raw ? 'normal' : 'offline';
  if (typeof raw === 'number') return raw >= 1 ? 'normal' : 'offline';
  return String(raw).toLowerCase();
}

/** Which statuses get a pulsing glow animation */
function getGlowMode(statusKey: string): 'pulse-fast' | 'pulse' | 'steady' | 'none' {
  if (statusKey === 'alarm' || statusKey === 'critical') return 'pulse-fast';
  if (statusKey === 'normal' || statusKey === 'ok') return 'pulse';
  if (statusKey === 'warning') return 'steady';
  return 'none';
}

const StatusIndicatorRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const label = (config.label ?? 'Status') as string;
  const activeColor = (config.activeColor as string) || null;
  const inactiveColor = (config.inactiveColor as string) || '#9ca3af';
  const rawValue = isEditing ? (config.demoStatus ?? 'normal') : (value ?? 'offline');
  const statusKey = resolveStatus(rawValue);

  // If activeColor is configured, use it for boolean true/numeric >=1, otherwise use STATUS_COLORS
  let color: string;
  if (activeColor && (statusKey === 'normal' || statusKey === 'ok')) {
    color = activeColor;
  } else if (statusKey === 'offline' && inactiveColor) {
    color = inactiveColor;
  } else {
    color = STATUS_COLORS[statusKey] ?? '#9ca3af';
  }
  const circleR = Math.min(width, height) * 0.22;
  const glowMode = getGlowMode(statusKey);
  const uid = useId().replace(/:/g, '_');
  const animId = `glow_${uid}`;

  const svgSize = circleR * 2 + 20;
  const cx = svgSize / 2;
  const cy = svgSize / 2;

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
      <svg width={svgSize} height={svgSize}>
        {/* Inline keyframes for pulse animation */}
        {glowMode !== 'none' && (
          <defs>
            <style>{`
              @keyframes ${animId} {
                0%, 100% { opacity: 0.15; }
                50% { opacity: 0.45; }
              }
            `}</style>
            <radialGradient id={`${animId}_grad`}>
              <stop offset="0%" stopColor={color} stopOpacity={0.6} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </radialGradient>
          </defs>
        )}

        {/* Outer glow ring — animated for alarm/normal, steady for warning */}
        {glowMode !== 'none' && (
          <circle
            cx={cx}
            cy={cy}
            r={circleR + 8}
            fill={`url(#${animId}_grad)`}
            style={
              glowMode === 'pulse-fast'
                ? { animation: `${animId} 0.8s ease-in-out infinite` }
                : glowMode === 'pulse'
                  ? { animation: `${animId} 2s ease-in-out infinite` }
                  : { opacity: 0.25 }
            }
          />
        )}

        {/* Inner glow halo */}
        <circle
          cx={cx}
          cy={cy}
          r={circleR + 3}
          fill={color}
          opacity={glowMode !== 'none' ? 0.25 : 0.1}
          style={{ transition: 'fill 0.4s ease, opacity 0.4s ease' }}
        />

        {/* Main circle */}
        <circle
          cx={cx}
          cy={cy}
          r={circleR}
          fill={color}
          style={{ transition: 'fill 0.4s ease' }}
        />

        {/* Specular highlight for depth */}
        <circle
          cx={cx - circleR * 0.2}
          cy={cy - circleR * 0.2}
          r={circleR * 0.35}
          fill="white"
          opacity={0.18}
        />
      </svg>
      <span style={{ fontSize: 11, fontWeight: 500, color: '#374151', textAlign: 'center' }}>
        {label}
      </span>
    </div>
  );
};

StatusIndicatorRenderer.displayName = 'StatusIndicatorRenderer';
export default memo(StatusIndicatorRenderer);
