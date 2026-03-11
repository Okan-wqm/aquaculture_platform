/**
 * DirtyWaterTankRenderer - Cylindrical dirty/waste water tank with murky fill,
 * sediment layer at bottom, drain valve, and "Kirli" (Dirty) badge. NaN-safe.
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const DirtyWaterTankRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const raw = isEditing ? (config.demoLevel ?? 55) : Number(value ?? 0);
  const numValue = typeof raw === 'number' && !isNaN(raw) ? raw : 0;
  const level = Math.max(0, Math.min(100, isNaN(numValue) ? 0 : numValue));

  const status = (isEditing ? (config.demoStatus ?? 'running') : String(value !== undefined ? 'running' : 'stopped')) as string;
  const isRunning = status === 'running';
  const statusColor = isRunning ? '#22c55e' : '#9ca3af';
  const effectiveLevel = isRunning ? Math.max(level, 90) : 0;
  const pct = effectiveLevel / 100;

  // Tank geometry (same as clean water tank)
  const tankX = 20;
  const tankY = 28;
  const tankW = 80;
  const tankH = 72;
  const capRy = 6;
  const fillH = tankH * pct;

  // Water colors
  const dirtyColor = '#8B7355';
  const sedimentColor = '#6B5335';

  // Sediment layer height (fixed at 10% of tank)
  const sedimentH = tankH * 0.1;

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
          {/* Dirty water gradient */}
          <linearGradient id="dirtyWaterGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={dirtyColor} stopOpacity={0.4} />
            <stop offset="100%" stopColor={dirtyColor} stopOpacity={0.6} />
          </linearGradient>
          {/* Sediment gradient */}
          <linearGradient id="sedimentGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={sedimentColor} stopOpacity={0.5} />
            <stop offset="100%" stopColor={sedimentColor} stopOpacity={0.8} />
          </linearGradient>
          {/* Tank body gradient */}
          <linearGradient id="dirtyTankGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#e2e8f0" />
            <stop offset="50%" stopColor="#f8fafc" />
            <stop offset="100%" stopColor="#e2e8f0" />
          </linearGradient>
          {/* Clip path for water fill inside tank */}
          <clipPath id="dirtyTankClip">
            <rect x={tankX + 1} y={tankY + capRy} width={tankW - 2} height={tankH - capRy * 2} />
            <ellipse cx={tankX + tankW / 2} cy={tankY + tankH - capRy} rx={tankW / 2 - 1} ry={capRy} />
          </clipPath>
        </defs>

        {/* Tank body (rounded rect simulating cylinder) */}
        <rect
          x={tankX}
          y={tankY + capRy}
          width={tankW}
          height={tankH - capRy * 2}
          fill="url(#dirtyTankGrad)"
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

        {/* Water fill + sediment (clipped to tank interior) */}
        <g clipPath="url(#dirtyTankClip)">
          {/* Dirty water */}
          <rect
            x={tankX + 1}
            y={tankY + tankH - capRy - fillH}
            width={tankW - 2}
            height={fillH}
            fill="url(#dirtyWaterGrad)"
          />
          {/* Sediment layer at bottom */}
          <rect
            x={tankX + 1}
            y={tankY + tankH - capRy - sedimentH}
            width={tankW - 2}
            height={sedimentH}
            fill="url(#sedimentGrad)"
          />
          {/* Sediment particles (small dots) */}
          <circle cx={tankX + 15} cy={tankY + tankH - capRy - 4} r={1.5} fill={sedimentColor} opacity={0.6} />
          <circle cx={tankX + 30} cy={tankY + tankH - capRy - 6} r={1} fill={sedimentColor} opacity={0.5} />
          <circle cx={tankX + 50} cy={tankY + tankH - capRy - 3} r={1.5} fill={sedimentColor} opacity={0.7} />
          <circle cx={tankX + 65} cy={tankY + tankH - capRy - 5} r={1} fill={sedimentColor} opacity={0.5} />
          {/* Water surface line */}
          {pct > 0.02 && pct < 0.98 && (
            <line
              x1={tankX + 3}
              y1={tankY + tankH - capRy - fillH}
              x2={tankX + tankW - 3}
              y2={tankY + tankH - capRy - fillH}
              stroke={dirtyColor}
              strokeWidth={1.5}
              strokeOpacity={0.7}
            />
          )}
        </g>

        {/* Outline over water (re-draw side walls) */}
        <line x1={tankX} y1={tankY + capRy} x2={tankX} y2={tankY + tankH - capRy} stroke="#333" strokeWidth={2} />
        <line x1={tankX + tankW} y1={tankY + capRy} x2={tankX + tankW} y2={tankY + tankH - capRy} stroke="#333" strokeWidth={2} />

        {/* Drain valve at bottom-center */}
        <line x1={tankX + tankW / 2} y1={tankY + tankH - capRy + 4} x2={tankX + tankW / 2} y2={tankY + tankH + 6} stroke="#333" strokeWidth={2} />
        {/* Valve body */}
        <rect
          x={tankX + tankW / 2 - 6}
          y={tankY + tankH + 4}
          width={12}
          height={8}
          rx={2}
          fill={statusColor}
          stroke="#333"
          strokeWidth={1.5}
        />
        {/* Valve handle */}
        <line
          x1={tankX + tankW / 2 - 5}
          y1={tankY + tankH + 8}
          x2={tankX + tankW / 2 + 5}
          y2={tankY + tankH + 8}
          stroke="#333"
          strokeWidth={1.5}
        />
        {/* Drain arrow */}
        <line x1={tankX + tankW / 2} y1={tankY + tankH + 12} x2={tankX + tankW / 2} y2={tankY + tankH + 20} stroke="#333" strokeWidth={1.5} />
        <polygon
          points={`${tankX + tankW / 2 - 3},${tankY + tankH + 17} ${tankX + tankW / 2},${tankY + tankH + 21} ${tankX + tankW / 2 + 3},${tankY + tankH + 17}`}
          fill={statusColor}
        />

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

        {/* "Kirli" badge */}
        <rect x={34} y={110} width={52} height={16} rx={8} fill="#d97706" opacity={0.15} />
        <rect x={34} y={110} width={52} height={16} rx={8} fill="none" stroke="#d97706" strokeWidth={1} />
        <text x={60} y={121} textAnchor="middle" fontSize={9} fill="#92400e" fontWeight={600}>
          Dirty
        </text>

        {/* Status dot */}
        <circle cx={108} cy={18} r={4} fill={statusColor} />
      </svg>
    </div>
  );
};

DirtyWaterTankRenderer.displayName = 'DirtyWaterTankRenderer';
export default memo(DirtyWaterTankRenderer);
