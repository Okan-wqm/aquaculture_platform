/**
 * MbbrRenderer - Moving Bed Biofilm Reactor (MBBR) SVG symbol.
 *
 * Rectangular tank with floating bio-media carriers (small circles/donuts),
 * aeration bubbles rising from a diffuser grid at the bottom, and
 * inlet/outlet pipes on each side.
 *
 * Status colors follow platform convention:
 *   Running: #22c55e   Stopped: #9ca3af   Error: #ef4444
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const STATUS_COLORS: Record<string, { fill: string; accent: string }> = {
  running: { fill: '#22c55e', accent: '#16a34a' },
  stopped: { fill: '#9ca3af', accent: '#6b7280' },
  error:   { fill: '#ef4444', accent: '#dc2626' },
};

/** Bio-media carrier positions (cx, cy) — scattered inside the tank */
const CARRIERS = [
  [40, 42], [60, 36], [82, 44], [100, 38],
  [35, 58], [55, 62], [75, 55], [95, 60],
  [45, 75], [68, 72], [88, 78], [105, 70],
  [38, 90], [58, 88], [80, 92], [98, 86],
] as const;

/** Aeration bubble positions (cx, startY) */
const BUBBLES = [
  [36, 100], [48, 98], [60, 102], [72, 99],
  [84, 101], [96, 97], [108, 100],
] as const;

const MbbrRenderer: React.FC<WidgetRendererProps> = ({
  config,
  value,
  width,
  height,
  isEditing,
}) => {
  const label = (config.label ?? 'MBBR') as string;
  const demoStatus = (config.demoStatus ?? 'running') as string;
  const status = isEditing ? demoStatus : (String(value ?? 'stopped'));
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS.stopped;
  const isRunning = status === 'running';

  return (
    <div style={{ width, height, padding: 8, boxSizing: 'border-box' }}>
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 140 120"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
      >
        {/* Label */}
        <text
          x={70}
          y={12}
          textAnchor="middle"
          fontSize={10}
          fill="#6b7280"
          fontWeight={500}
        >
          {label}
        </text>

        {/* Tank body */}
        <rect
          x={20}
          y={22}
          width={100}
          height={86}
          rx={3}
          fill="#cfd8dc"
          stroke="#333"
          strokeWidth={2}
        />

        {/* Water fill */}
        <rect
          x={22}
          y={30}
          width={96}
          height={76}
          rx={2}
          fill={colors.fill}
          opacity={0.15}
        />

        {/* Diffuser grid at bottom */}
        <line x1={28} y1={104} x2={112} y2={104} stroke="#555" strokeWidth={2} />
        {/* Diffuser nozzles */}
        {[36, 48, 60, 72, 84, 96, 108].map((cx) => (
          <circle key={cx} cx={cx} cy={104} r={1.5} fill="#555" />
        ))}

        {/* Aeration bubbles (animated when running) */}
        {BUBBLES.map(([cx, startY], i) => (
          <g key={`bubble-${i}`}>
            <circle cx={cx} cy={startY} r={1.8} fill={colors.fill} opacity={0.5}>
              {isRunning && (
                <animate
                  attributeName="cy"
                  from={startY}
                  to={32}
                  dur={`${1.2 + i * 0.15}s`}
                  repeatCount="indefinite"
                />
              )}
              {isRunning && (
                <animate
                  attributeName="opacity"
                  from="0.5"
                  to="0"
                  dur={`${1.2 + i * 0.15}s`}
                  repeatCount="indefinite"
                />
              )}
            </circle>
            <circle cx={cx + 3} cy={startY - 6} r={1.2} fill={colors.fill} opacity={0.35}>
              {isRunning && (
                <animate
                  attributeName="cy"
                  from={startY - 6}
                  to={28}
                  dur={`${1.5 + i * 0.12}s`}
                  repeatCount="indefinite"
                />
              )}
              {isRunning && (
                <animate
                  attributeName="opacity"
                  from="0.35"
                  to="0"
                  dur={`${1.5 + i * 0.12}s`}
                  repeatCount="indefinite"
                />
              )}
            </circle>
          </g>
        ))}

        {/* Bio-media carriers (small donut shapes) */}
        {CARRIERS.map(([cx, cy], i) => (
          <g key={`carrier-${i}`}>
            <circle cx={cx} cy={cy} r={4} fill="#e0e0e0" stroke="#777" strokeWidth={1} />
            <circle cx={cx} cy={cy} r={1.5} fill="#cfd8dc" />
          </g>
        ))}

        {/* Inlet pipe (left) */}
        <rect x={2} y={40} width={20} height={8} fill="#cfd8dc" stroke="#333" strokeWidth={1.5} rx={1} />
        <polygon points="16,44 20,41 20,47" fill={colors.fill} />

        {/* Outlet pipe (right) */}
        <rect x={118} y={40} width={20} height={8} fill="#cfd8dc" stroke="#333" strokeWidth={1.5} rx={1} />
        <polygon points="132,44 136,41 136,47" fill={colors.fill} />

        {/* Status indicator */}
        <circle cx={70} cy={116} r={3} fill={colors.fill} />
      </svg>
    </div>
  );
};

MbbrRenderer.displayName = 'MbbrRenderer';
export default memo(MbbrRenderer);
