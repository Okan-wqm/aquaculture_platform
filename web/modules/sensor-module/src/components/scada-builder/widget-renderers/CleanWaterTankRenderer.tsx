/**
 * CleanWaterTankRenderer - Cylindrical clean water tank with level indicator,
 * inlet/outlet pipes, and "Temiz" (Clean) badge. NaN-safe.
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const CleanWaterTankRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const raw = isEditing ? (config.demoLevel ?? 70) : Number(value ?? 0);
  const numValue = typeof raw === 'number' && !isNaN(raw) ? raw : 0;
  const level = Math.max(0, Math.min(100, isNaN(numValue) ? 0 : numValue));

  const status = (isEditing ? (config.demoStatus ?? 'running') : String(value !== undefined ? 'running' : 'stopped')) as string;
  const isRunning = status === 'running';
  const statusColor = isRunning ? '#22c55e' : '#9ca3af';
  const effectiveLevel = isRunning ? Math.max(level, 90) : 0;
  const pct = effectiveLevel / 100;

  // Tank geometry
  const tankX = 20;
  const tankY = 28;
  const tankW = 80;
  const tankH = 72;
  const capRy = 6; // ellipse vertical radius for top/bottom caps
  const fillH = tankH * pct;

  // Water color
  const waterColor = '#4FB3F6';

  return (
    <div style={{ width, height, padding: 8, boxSizing: 'border-box' }}>
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 120 140"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
      >
        <defs>
          {/* Water gradient */}
          <linearGradient id="cleanWaterGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={waterColor} stopOpacity={0.4} />
            <stop offset="100%" stopColor={waterColor} stopOpacity={0.6} />
          </linearGradient>
          {/* Tank body gradient */}
          <linearGradient id="cleanTankGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#e2e8f0" />
            <stop offset="50%" stopColor="#f8fafc" />
            <stop offset="100%" stopColor="#e2e8f0" />
          </linearGradient>
          {/* Clip path for water fill inside tank */}
          <clipPath id="cleanTankClip">
            <rect x={tankX + 1} y={tankY + capRy} width={tankW - 2} height={tankH - capRy * 2} />
            <ellipse cx={tankX + tankW / 2} cy={tankY + tankH - capRy} rx={tankW / 2 - 1} ry={capRy} />
          </clipPath>
        </defs>

        {/* Inlet pipe (top-left) */}
        <line x1={2} y1={tankY + 8} x2={tankX} y2={tankY + 8} stroke="#333" strokeWidth={2} />
        <polygon points={`${tankX - 4},${tankY + 5} ${tankX},${tankY + 8} ${tankX - 4},${tankY + 11}`} fill={statusColor} />

        {/* Tank body (rounded rect simulating cylinder) */}
        <rect
          x={tankX}
          y={tankY + capRy}
          width={tankW}
          height={tankH - capRy * 2}
          fill="url(#cleanTankGrad)"
          stroke="#333"
          strokeWidth={2}
        />

        {/* Top cap (ellipse) */}
        <ellipse
          cx={tankX + tankW / 2}
          cy={tankY + capRy}
          rx={tankW / 2}
          ry={capRy}
          fill="#e2e8f0"
          stroke="#333"
          strokeWidth={2}
        />

        {/* Bottom cap (ellipse) */}
        <ellipse
          cx={tankX + tankW / 2}
          cy={tankY + tankH - capRy}
          rx={tankW / 2}
          ry={capRy}
          fill="#cfd8dc"
          stroke="#333"
          strokeWidth={2}
        />

        {/* Water fill */}
        <g clipPath="url(#cleanTankClip)">
          <rect
            x={tankX + 1}
            y={tankY + tankH - capRy - fillH}
            width={tankW - 2}
            height={fillH}
            fill="url(#cleanWaterGrad)"
          />
          {/* Water surface line */}
          {pct > 0.02 && pct < 0.98 && (
            <line
              x1={tankX + 3}
              y1={tankY + tankH - capRy - fillH}
              x2={tankX + tankW - 3}
              y2={tankY + tankH - capRy - fillH}
              stroke={waterColor}
              strokeWidth={1.5}
              strokeOpacity={0.8}
            />
          )}
        </g>

        {/* Outline over water (re-draw side walls) */}
        <line x1={tankX} y1={tankY + capRy} x2={tankX} y2={tankY + tankH - capRy} stroke="#333" strokeWidth={2} />
        <line x1={tankX + tankW} y1={tankY + capRy} x2={tankX + tankW} y2={tankY + tankH - capRy} stroke="#333" strokeWidth={2} />

        {/* Outlet pipe (bottom-right) */}
        <line x1={tankX + tankW} y1={tankY + tankH - 14} x2={118} y2={tankY + tankH - 14} stroke="#333" strokeWidth={2} />
        <polygon points={`${114},${tankY + tankH - 17} ${118},${tankY + tankH - 14} ${114},${tankY + tankH - 11}`} fill={statusColor} />

        {/* Level percentage (centered in tank) */}
        <text
          x={tankX + tankW / 2}
          y={tankY + tankH / 2 + 2}
          textAnchor="middle"
          fontSize={16}
          fontWeight={700}
          fill="#111827"
        >
          {Math.round(effectiveLevel)}%
        </text>

        {/* "Temiz" badge */}
        <rect x={34} y={110} width={52} height={16} rx={8} fill={waterColor} opacity={0.2} />
        <rect x={34} y={110} width={52} height={16} rx={8} fill="none" stroke={waterColor} strokeWidth={1} />
        <text x={60} y={121} textAnchor="middle" fontSize={9} fill="#2563eb" fontWeight={600}>
          Clean
        </text>

        {/* Status dot */}
        <circle cx={108} cy={18} r={4} fill={statusColor} />
      </svg>
    </div>
  );
};

CleanWaterTankRenderer.displayName = 'CleanWaterTankRenderer';
export default memo(CleanWaterTankRenderer);
