/**
 * HepaFilterRenderer - HEPA filter housing SVG symbol.
 *
 * Rectangular housing with visible pleated filter element (zigzag pattern),
 * airflow direction arrows at inlet/outlet, and a Delta-P (pressure
 * differential) indicator.
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

const HepaFilterRenderer: React.FC<WidgetRendererProps> = ({
  config,
  value,
  width,
  height,
  isEditing,
}) => {
  const label = (config.label ?? 'HEPA Filtre') as string;
  const demoStatus = (config.demoStatus ?? 'running') as string;
  const status = isEditing ? demoStatus : (String(value ?? 'stopped'));
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS.stopped;

  // Build the pleated zigzag filter path
  const pleats: string[] = [];
  const pleatsStartX = 58;
  const pleatsEndX = 82;
  const pleatsTop = 28;
  const pleatsBottom = 78;
  const numPleats = 8;
  const step = (pleatsBottom - pleatsTop) / numPleats;

  pleats.push(`M${pleatsStartX},${pleatsTop}`);
  for (let i = 0; i < numPleats; i++) {
    const y = pleatsTop + i * step;
    if (i % 2 === 0) {
      pleats.push(`L${pleatsEndX},${y + step / 2}`);
      pleats.push(`L${pleatsStartX},${y + step}`);
    } else {
      pleats.push(`L${pleatsEndX},${y + step / 2}`);
      pleats.push(`L${pleatsStartX},${y + step}`);
    }
  }
  const pleatPath = pleats.join(' ');

  return (
    <div style={{ width, height, padding: 8, boxSizing: 'border-box' }}>
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 140 100"
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

        {/* Filter housing (outer rectangle) */}
        <rect
          x={38}
          y={20}
          width={64}
          height={66}
          rx={3}
          fill="#cfd8dc"
          stroke="#333"
          strokeWidth={2}
        />

        {/* Inner chamber */}
        <rect
          x={42}
          y={24}
          width={56}
          height={58}
          rx={2}
          fill="#f1f5f9"
          stroke="#999"
          strokeWidth={1}
        />

        {/* Pleated filter element (zigzag) */}
        <path
          d={pleatPath}
          fill="none"
          stroke={colors.accent}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />

        {/* Vertical filter frame lines */}
        <line x1={58} y1={24} x2={58} y2={82} stroke="#777" strokeWidth={1} />
        <line x1={82} y1={24} x2={82} y2={82} stroke="#777" strokeWidth={1} />

        {/* Inlet pipe (left) */}
        <rect x={8} y={46} width={32} height={12} fill="#cfd8dc" stroke="#333" strokeWidth={1.5} rx={1} />
        {/* Inlet airflow arrows */}
        <polygon points="18,52 24,48 24,56" fill={colors.fill} />
        <polygon points="28,52 34,48 34,56" fill={colors.fill} opacity={0.6} />

        {/* Outlet pipe (right) */}
        <rect x={100} y={46} width={32} height={12} fill="#cfd8dc" stroke="#333" strokeWidth={1.5} rx={1} />
        {/* Outlet airflow arrows */}
        <polygon points="112,52 118,48 118,56" fill={colors.fill} />
        <polygon points="122,52 128,48 128,56" fill={colors.fill} opacity={0.6} />

        {/* Pressure differential indicator (Delta-P) */}
        <rect
          x={52}
          y={86}
          width={36}
          height={12}
          rx={2}
          fill="white"
          stroke="#333"
          strokeWidth={1}
        />
        <text
          x={70}
          y={95}
          textAnchor="middle"
          fontSize={8}
          fontWeight={600}
          fill={status === 'error' ? '#ef4444' : '#374151'}
        >
          {'\u0394'}P
        </text>

        {/* Status indicator */}
        <circle cx={70} cy={18} r={3} fill={colors.fill} />
      </svg>
    </div>
  );
};

HepaFilterRenderer.displayName = 'HepaFilterRenderer';
export default memo(HepaFilterRenderer);
