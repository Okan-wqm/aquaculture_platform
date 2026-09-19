/**
 * HepaFilterRenderer - HEPA filter housing SVG symbol.
 *
 * Rectangular housing with visible pleated filter element (zigzag pattern),
 * airflow direction arrows at inlet/outlet, and a Delta-P (pressure
 * differential) indicator.
 *
 * Status colors follow platform convention:
 *   Running: success-500   Stopped: neutral-400   Error: error-500
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import { colors as themeColors } from '@aquaculture/shared-ui';

const STATUS_COLORS: Record<string, { fill: string; accent: string }> = {
  running: { fill: themeColors.success[500], accent: themeColors.success[600] },
  stopped: { fill: themeColors.neutral[400], accent: themeColors.gray[400] },
  error:   { fill: themeColors.error[500], accent: themeColors.error[600] },
};

const HepaFilterRenderer: React.FC<WidgetRendererProps> = ({
  config,
  value,
  width,
  height,
  isEditing,
}) => {
  const demoStatus = (config.demoStatus ?? 'running') as string;
  const status = isEditing ? demoStatus : (String(value ?? 'stopped'));
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS.stopped;

  // Build the pleated zigzag filter path
  const pleats: string[] = [];
  const pleatsStartX = 58;
  const pleatsEndX = 82;
  const pleatsTop = 14;
  const pleatsBottom = 64;
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
        viewBox="0 0 140 86"
        preserveAspectRatio="xMidYMid meet"
        className="block"
      >
        {/* Filter housing (outer rectangle) */}
        <rect
          x={38}
          y={6}
          width={64}
          height={66}
          rx={3}
          fill={themeColors.neutral[300]}
          stroke="#333"
          strokeWidth={2}
        />

        {/* Inner chamber */}
        <rect
          x={42}
          y={10}
          width={56}
          height={58}
          rx={2}
          fill={themeColors.neutral[100]}
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
        <line x1={58} y1={10} x2={58} y2={68} stroke="#777" strokeWidth={1} />
        <line x1={82} y1={10} x2={82} y2={68} stroke="#777" strokeWidth={1} />

        {/* Inlet pipe (left) */}
        <rect x={8} y={32} width={32} height={12} fill={themeColors.neutral[300]} stroke="#333" strokeWidth={1.5} rx={1} />
        {/* Inlet airflow arrows */}
        <polygon points="18,38 24,34 24,42" fill={colors.fill} />
        <polygon points="28,38 34,34 34,42" fill={colors.fill} opacity={0.6} />

        {/* Outlet pipe (right) */}
        <rect x={100} y={32} width={32} height={12} fill={themeColors.neutral[300]} stroke="#333" strokeWidth={1.5} rx={1} />
        {/* Outlet airflow arrows */}
        <polygon points="112,38 118,34 118,42" fill={colors.fill} />
        <polygon points="122,38 128,34 128,42" fill={colors.fill} opacity={0.6} />

        {/* Pressure differential indicator (Delta-P) */}
        <rect
          x={52}
          y={72}
          width={36}
          height={12}
          rx={2}
          fill="white"
          stroke="#333"
          strokeWidth={1}
        />
        <text
          x={70}
          y={81}
          textAnchor="middle"
          fontSize={8}
          fontWeight={600}
          fill={status === 'error' ? themeColors.error[500] : themeColors.neutral[700]}
        >
          {'\u0394'}P
        </text>

        {/* Status indicator */}
        <circle cx={70} cy={4} r={3} fill={colors.fill} />
      </svg>
    </div>
  );
};

HepaFilterRenderer.displayName = 'HepaFilterRenderer';
export default memo(HepaFilterRenderer);
