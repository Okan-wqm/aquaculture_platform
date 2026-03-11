/**
 * RadialFilterRenderer - Conical settling tank (Radyal Filtre) SVG symbol.
 *
 * Shows a wide-at-top, narrow-at-bottom conical settler with rim, internal
 * settling cone, sludge pocket, inlet/outlet pipes and bottom drain.
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

const RadialFilterRenderer: React.FC<WidgetRendererProps> = ({
  config,
  value,
  width,
  height,
  isEditing,
}) => {
  const label = (config.label ?? 'Radyal Filtre') as string;
  const demoStatus = (config.demoStatus ?? 'running') as string;
  const status = isEditing ? demoStatus : (String(value ?? 'stopped'));
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS.stopped;

  return (
    <div style={{ width, height, padding: 8, boxSizing: 'border-box' }}>
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 120 160"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
      >
        {/* Label */}
        <text
          x={60}
          y={12}
          textAnchor="middle"
          fontSize={10}
          fill="#6b7280"
          fontWeight={500}
        >
          {label}
        </text>

        {/* Top circular rim (ellipse) */}
        <ellipse
          cx={60}
          cy={28}
          rx={42}
          ry={8}
          fill="#e0e0e0"
          stroke="#333"
          strokeWidth={2}
        />

        {/* Conical body — trapezoid from wide top to narrow bottom */}
        <path
          d="M18,28 L102,28 L72,130 L48,130 Z"
          fill="#cfd8dc"
          stroke="#333"
          strokeWidth={2}
          strokeLinejoin="round"
        />

        {/* Internal settling cone lines */}
        <line x1={38} y1={50} x2={60} y2={120} stroke="#999" strokeWidth={1.5} strokeDasharray="4,3" />
        <line x1={82} y1={50} x2={60} y2={120} stroke="#999" strokeWidth={1.5} strokeDasharray="4,3" />

        {/* Liquid fill zone (upper portion) */}
        <path
          d="M24,40 L96,40 L78,100 L42,100 Z"
          fill={colors.fill}
          opacity={0.25}
        />

        {/* Sludge collection pocket at bottom */}
        <path
          d="M52,118 L68,118 L64,130 L56,130 Z"
          fill={colors.accent}
          opacity={0.6}
        />
        <path
          d="M52,118 L68,118 L64,130 L56,130 Z"
          fill="none"
          stroke="#333"
          strokeWidth={1.5}
        />

        {/* Inlet pipe (left side) */}
        <rect x={2} y={38} width={18} height={8} fill="#cfd8dc" stroke="#333" strokeWidth={1.5} rx={1} />
        <path d="M14,38 L14,46" stroke={colors.fill} strokeWidth={2} />
        {/* Inlet arrow */}
        <polygon points="16,42 20,39 20,45" fill={colors.fill} />

        {/* Outlet pipe (right side) */}
        <rect x={100} y={50} width={18} height={8} fill="#cfd8dc" stroke="#333" strokeWidth={1.5} rx={1} />
        {/* Outlet arrow */}
        <polygon points="114,54 118,51 118,57" fill={colors.fill} />

        {/* Bottom drain pipe */}
        <rect x={56} y={130} width={8} height={14} fill="#cfd8dc" stroke="#333" strokeWidth={1.5} rx={1} />
        {/* Drain valve symbol (small butterfly) */}
        <line x1={56} y1={140} x2={64} y2={140} stroke="#333" strokeWidth={2} />
        <circle cx={60} cy={140} r={3} fill="white" stroke="#333" strokeWidth={1.5} />

        {/* Status indicator dot */}
        <circle cx={60} cy={152} r={4} fill={colors.fill} />
        <circle cx={60} cy={152} r={6} fill={colors.fill} opacity={0.3} />
      </svg>
    </div>
  );
};

RadialFilterRenderer.displayName = 'RadialFilterRenderer';
export default memo(RadialFilterRenderer);
