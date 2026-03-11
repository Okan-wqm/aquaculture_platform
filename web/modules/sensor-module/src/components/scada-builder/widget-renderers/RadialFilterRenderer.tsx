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
        {/* Top circular rim (ellipse) */}
        <ellipse
          cx={60}
          cy={14}
          rx={42}
          ry={8}
          fill="#e0e0e0"
          stroke="#333"
          strokeWidth={2}
        />

        {/* Conical body — trapezoid from wide top to narrow bottom */}
        <path
          d="M18,14 L102,14 L72,116 L48,116 Z"
          fill="#cfd8dc"
          stroke="#333"
          strokeWidth={2}
          strokeLinejoin="round"
        />

        {/* Internal settling cone lines */}
        <line x1={38} y1={36} x2={60} y2={106} stroke="#999" strokeWidth={1.5} strokeDasharray="4,3" />
        <line x1={82} y1={36} x2={60} y2={106} stroke="#999" strokeWidth={1.5} strokeDasharray="4,3" />

        {/* Liquid fill zone (upper portion) */}
        <path
          d="M24,26 L96,26 L78,86 L42,86 Z"
          fill={colors.fill}
          opacity={0.25}
        />

        {/* Sludge collection pocket at bottom */}
        <path
          d="M52,104 L68,104 L64,116 L56,116 Z"
          fill={colors.accent}
          opacity={0.6}
        />
        <path
          d="M52,104 L68,104 L64,116 L56,116 Z"
          fill="none"
          stroke="#333"
          strokeWidth={1.5}
        />

        {/* Inlet pipe (left side) */}
        <rect x={2} y={24} width={18} height={8} fill="#cfd8dc" stroke="#333" strokeWidth={1.5} rx={1} />
        <path d="M14,24 L14,32" stroke={colors.fill} strokeWidth={2} />
        {/* Inlet arrow */}
        <polygon points="16,28 20,25 20,31" fill={colors.fill} />

        {/* Outlet pipe (right side) */}
        <rect x={100} y={36} width={18} height={8} fill="#cfd8dc" stroke="#333" strokeWidth={1.5} rx={1} />
        {/* Outlet arrow */}
        <polygon points="114,40 118,37 118,43" fill={colors.fill} />

        {/* Bottom drain pipe */}
        <rect x={56} y={116} width={8} height={14} fill="#cfd8dc" stroke="#333" strokeWidth={1.5} rx={1} />
        {/* Drain valve symbol (small butterfly) */}
        <line x1={56} y1={126} x2={64} y2={126} stroke="#333" strokeWidth={2} />
        <circle cx={60} cy={126} r={3} fill="white" stroke="#333" strokeWidth={1.5} />

        {/* Status indicator dot */}
        <circle cx={60} cy={146} r={4} fill={colors.fill} />
        <circle cx={60} cy={146} r={6} fill={colors.fill} opacity={0.3} />
      </svg>
    </div>
  );
};

RadialFilterRenderer.displayName = 'RadialFilterRenderer';
export default memo(RadialFilterRenderer);
