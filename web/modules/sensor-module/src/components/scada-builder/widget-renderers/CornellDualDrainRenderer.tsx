/**
 * CornellDualDrainRenderer - Professional Cornell-type dual-drain fish tank
 * (side view cross-section).
 *
 * Features:
 * - Flat-bottomed circular tank shown as rectangular side cross-section
 * - Sloped bottom (2-3 deg grade toward center drain)
 * - Center bottom drain (solids removal) with vertical downpipe
 * - Side outlet / sideflow box with vertical standpipe and overflow weir
 * - Water fill with fish silhouettes
 * - Spray-bar inlet pipe from above
 * - Flow direction arrows
 *
 * NaN-safe. Uses config.demoLevel / config.demoStatus in edit mode.
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const CornellDualDrainRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const label = (config.label ?? 'Cornell Dual Drain') as string;
  const raw = isEditing ? (config.demoLevel ?? 75) : Number(value ?? 0);
  const numValue = typeof raw === 'number' && !isNaN(raw) ? raw : 0;
  const level = Math.max(0, Math.min(100, isNaN(numValue) ? 0 : numValue));
  const pct = level / 100;

  const status = (isEditing ? (config.demoStatus ?? 'running') : String(value !== undefined ? 'running' : 'stopped')) as string;
  const isRunning = status === 'running';
  const statusColor = isRunning ? '#22c55e' : '#9ca3af';

  // --- Main tank geometry (side view cross-section) ---
  const tankL = 14;     // tank left x
  const tankR = 156;    // tank right x
  const tankW = tankR - tankL;  // 142
  const tankTop = 32;   // top of tank wall
  const tankBot = 112;  // bottom reference line (floor level at walls)
  const tankH = tankBot - tankTop; // 80

  // Bottom slope: walls at tankBot, center 4px lower (approx 3 deg grade)
  const slopeDepth = 4;
  const centerX = tankL + tankW / 2; // 85
  const centerBotY = tankBot + slopeDepth; // 116

  // Water level
  const waterMaxH = tankH + slopeDepth; // total fillable depth
  const waterH = waterMaxH * pct;
  const waterSurfaceY = centerBotY - waterH;

  // --- Sideflow box geometry (right side) ---
  const sfBoxW = 18;
  const sfBoxH = 50;
  const sfBoxX = tankR;          // flush with right tank wall
  const sfBoxTop = tankBot - sfBoxH; // top of sideflow box
  const sfBoxBot = tankBot;

  // Standpipe inside sideflow box
  const spX = sfBoxX + sfBoxW / 2; // center of sideflow box
  const spTop = sfBoxTop + 4;      // top of standpipe
  const spBot = sfBoxBot - 2;

  // Overflow weir level (where water spills from tank into sideflow box)
  const weirY = sfBoxTop + 10;

  // --- Center bottom drain ---
  const drainPipeW = 8;
  const drainPipeTop = centerBotY;
  const drainPipeBot = 148;

  // --- Inlet spray bar ---
  const sprayBarY = tankTop - 4;
  const sprayBarLeft = centerX - 30;
  const sprayBarRight = centerX + 30;

  // Water color
  const waterColor = '#4FB3F6';

  return (
    <div style={{ width, height, padding: 8, boxSizing: 'border-box' }}>
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 200 160"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
      >
        <defs>
          {/* Water gradient */}
          <linearGradient id="cornellWaterGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={waterColor} stopOpacity={0.35} />
            <stop offset="100%" stopColor={waterColor} stopOpacity={0.55} />
          </linearGradient>
          {/* Tank wall gradient (slight metallic) */}
          <linearGradient id="cornellTankWall" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#b0bec5" />
            <stop offset="50%" stopColor="#cfd8dc" />
            <stop offset="100%" stopColor="#b0bec5" />
          </linearGradient>
          {/* Clip for water fill inside tank */}
          <clipPath id="cornellWaterClip">
            <polygon points={`
              ${tankL + 2},${tankTop + 1}
              ${tankR - 1},${tankTop + 1}
              ${tankR - 1},${tankBot}
              ${centerX},${centerBotY}
              ${tankL + 2},${tankBot}
            `} />
          </clipPath>
        </defs>

        {/* ==================== LABEL ==================== */}
        <text x={100} y={12} textAnchor="middle" fontSize={10} fill="#6b7280" fontWeight={500}>
          {label}
        </text>

        {/* Status dot */}
        <circle cx={188} cy={10} r={4} fill={statusColor} />

        {/* ==================== INLET SPRAY BAR ==================== */}
        {/* Inlet pipe from top */}
        <line x1={centerX} y1={2} x2={centerX} y2={sprayBarY - 2} stroke="#333" strokeWidth={2} />
        {/* Spray bar horizontal */}
        <line x1={sprayBarLeft} y1={sprayBarY} x2={sprayBarRight} y2={sprayBarY} stroke="#333" strokeWidth={2.5} />
        {/* Spray nozzles (small downward lines) */}
        {[-24, -12, 0, 12, 24].map((offset) => (
          <g key={offset}>
            <line
              x1={centerX + offset}
              y1={sprayBarY}
              x2={centerX + offset}
              y2={sprayBarY + 5}
              stroke={statusColor}
              strokeWidth={1.5}
            />
            {/* Spray droplets */}
            {isRunning && (
              <>
                <circle cx={centerX + offset - 1.5} cy={sprayBarY + 7} r={0.8} fill={waterColor} opacity={0.7} />
                <circle cx={centerX + offset + 1.5} cy={sprayBarY + 8} r={0.8} fill={waterColor} opacity={0.7} />
              </>
            )}
          </g>
        ))}
        {/* Inlet flow arrow */}
        <polygon points={`${centerX - 3},6 ${centerX},2 ${centerX + 3},6`} fill={statusColor} />

        {/* ==================== TANK BODY ==================== */}
        {/* Tank walls + sloped bottom */}
        <polygon
          points={`
            ${tankL},${tankTop}
            ${tankR},${tankTop}
            ${tankR},${tankBot}
            ${centerX},${centerBotY}
            ${tankL},${tankBot}
          `}
          fill="url(#cornellTankWall)"
          stroke="#333"
          strokeWidth={2}
          strokeLinejoin="round"
        />

        {/* ==================== WATER FILL ==================== */}
        {pct > 0 && (
          <g clipPath="url(#cornellWaterClip)">
            {/* Water body - fills from sloped bottom up to water surface */}
            <polygon
              points={`
                ${tankL + 2},${waterSurfaceY}
                ${tankR - 1},${waterSurfaceY}
                ${tankR - 1},${tankBot}
                ${centerX},${centerBotY}
                ${tankL + 2},${tankBot}
              `}
              fill="url(#cornellWaterGrad)"
            />

            {/* Water surface highlight line */}
            {pct > 0.05 && pct < 0.95 && (
              <line
                x1={tankL + 4}
                y1={waterSurfaceY}
                x2={tankR - 3}
                y2={waterSurfaceY}
                stroke={waterColor}
                strokeWidth={1.5}
                strokeOpacity={0.6}
              />
            )}

            {/* ==================== FISH SILHOUETTES ==================== */}
            {/* Fish 1 - facing right */}
            {pct > 0.25 && (
              <g transform={`translate(${centerX - 28}, ${waterSurfaceY + (centerBotY - waterSurfaceY) * 0.4})`} opacity={0.5}>
                <ellipse cx={0} cy={0} rx={8} ry={3.5} fill="#1e6091" />
                <polygon points="-8,-3.5 -13,0 -8,3.5" fill="#1e6091" />
                <circle cx={5} cy={-1} r={0.8} fill="#0d3b66" />
              </g>
            )}
            {/* Fish 2 - facing left */}
            {pct > 0.35 && (
              <g transform={`translate(${centerX + 20}, ${waterSurfaceY + (centerBotY - waterSurfaceY) * 0.55}) scale(-1,1)`} opacity={0.45}>
                <ellipse cx={0} cy={0} rx={7} ry={3} fill="#1e6091" />
                <polygon points="-7,-3 -11,0 -7,3" fill="#1e6091" />
                <circle cx={4} cy={-1} r={0.7} fill="#0d3b66" />
              </g>
            )}
            {/* Fish 3 - small, facing right */}
            {pct > 0.45 && (
              <g transform={`translate(${centerX - 5}, ${waterSurfaceY + (centerBotY - waterSurfaceY) * 0.7})`} opacity={0.4}>
                <ellipse cx={0} cy={0} rx={5.5} ry={2.5} fill="#1e6091" />
                <polygon points="-5.5,-2.5 -9,0 -5.5,2.5" fill="#1e6091" />
                <circle cx={3} cy={-0.8} r={0.6} fill="#0d3b66" />
              </g>
            )}
          </g>
        )}

        {/* ==================== CENTER BOTTOM DRAIN ==================== */}
        {/* Drain screen / grate at center bottom */}
        <rect
          x={centerX - 6}
          y={centerBotY - 2}
          width={12}
          height={3}
          rx={1}
          fill="#78909c"
          stroke="#333"
          strokeWidth={1}
        />
        {/* Drain grate lines */}
        <line x1={centerX - 3} y1={centerBotY - 1.5} x2={centerX - 3} y2={centerBotY + 0.5} stroke="#333" strokeWidth={0.5} />
        <line x1={centerX} y1={centerBotY - 1.5} x2={centerX} y2={centerBotY + 0.5} stroke="#333" strokeWidth={0.5} />
        <line x1={centerX + 3} y1={centerBotY - 1.5} x2={centerX + 3} y2={centerBotY + 0.5} stroke="#333" strokeWidth={0.5} />

        {/* Drain pipe going down */}
        <rect
          x={centerX - drainPipeW / 2}
          y={drainPipeTop}
          width={drainPipeW}
          height={drainPipeBot - drainPipeTop}
          fill="#cfd8dc"
          stroke="#333"
          strokeWidth={1.5}
        />

        {/* Drain flow arrow */}
        <polygon
          points={`${centerX - 4},${drainPipeBot - 6} ${centerX},${drainPipeBot - 1} ${centerX + 4},${drainPipeBot - 6}`}
          fill={statusColor}
        />

        {/* Drain label */}
        <text x={centerX} y={drainPipeBot + 8} textAnchor="middle" fontSize={7} fill="#6b7280">
          Solids
        </text>

        {/* ==================== SIDEFLOW BOX ==================== */}
        {/* Box outline */}
        <rect
          x={sfBoxX}
          y={sfBoxTop}
          width={sfBoxW}
          height={sfBoxH}
          fill="#e8edf0"
          stroke="#333"
          strokeWidth={2}
        />

        {/* Water in sideflow box (if water is above weir level) */}
        {waterSurfaceY < weirY && (
          <rect
            x={sfBoxX + 1}
            y={weirY + 2}
            width={sfBoxW - 2}
            height={sfBoxBot - weirY - 3}
            fill={waterColor}
            opacity={0.3}
          />
        )}

        {/* Overflow weir opening in tank wall */}
        <line x1={tankR - 1} y1={weirY - 3} x2={tankR - 1} y2={weirY + 3} stroke="#f8fafc" strokeWidth={3} />
        <line x1={tankR} y1={weirY - 4} x2={tankR} y2={weirY - 4} stroke="#333" strokeWidth={1} />
        <line x1={tankR} y1={weirY + 4} x2={tankR} y2={weirY + 4} stroke="#333" strokeWidth={1} />

        {/* Overflow flow arrows (from tank into sideflow box) */}
        {waterSurfaceY < weirY && isRunning && (
          <>
            <line x1={tankR - 4} y1={weirY} x2={sfBoxX + 3} y2={weirY} stroke={waterColor} strokeWidth={1} strokeOpacity={0.7} />
            <polygon
              points={`${sfBoxX + 1},${weirY - 2} ${sfBoxX + 4},${weirY} ${sfBoxX + 1},${weirY + 2}`}
              fill={waterColor}
              opacity={0.7}
            />
          </>
        )}

        {/* Standpipe inside sideflow box */}
        <rect
          x={spX - 2}
          y={spTop}
          width={4}
          height={spBot - spTop}
          fill="#b0bec5"
          stroke="#333"
          strokeWidth={1}
        />
        {/* Standpipe top cap */}
        <line x1={spX - 3} y1={spTop} x2={spX + 3} y2={spTop} stroke="#333" strokeWidth={1.5} />

        {/* Sideflow outlet pipe (exits right) */}
        <line x1={sfBoxX + sfBoxW} y1={sfBoxBot - 10} x2={sfBoxX + sfBoxW + 16} y2={sfBoxBot - 10} stroke="#333" strokeWidth={2} />
        {/* Sideflow outlet arrow */}
        <polygon
          points={`${sfBoxX + sfBoxW + 12},${sfBoxBot - 13} ${sfBoxX + sfBoxW + 16},${sfBoxBot - 10} ${sfBoxX + sfBoxW + 12},${sfBoxBot - 7}`}
          fill={statusColor}
        />
        {/* Sideflow label */}
        <text x={sfBoxX + sfBoxW / 2} y={sfBoxBot + 10} textAnchor="middle" fontSize={7} fill="#6b7280">
          Sideflow
        </text>

        {/* ==================== ANNOTATIONS ==================== */}
        {/* Level percentage */}
        <text
          x={tankL + tankW / 2 - 8}
          y={tankTop + 22}
          textAnchor="middle"
          fontSize={14}
          fontWeight={700}
          fill="#111827"
        >
          {Math.round(level)}%
        </text>

        {/* Tank wall thickness indicators (small horizontal lines at top) */}
        <line x1={tankL - 2} y1={tankTop} x2={tankL + 3} y2={tankTop} stroke="#333" strokeWidth={2} />
        <line x1={tankR - 3} y1={tankTop} x2={tankR + 2} y2={tankTop} stroke="#333" strokeWidth={2} />

        {/* Bottom slope angle indicator */}
        <text x={tankL + 14} y={tankBot + 6} fontSize={6} fill="#9ca3af">
          3°
        </text>

        {/* ==================== STATUS BAR ==================== */}
        {/* Status indicator line at bottom */}
        <rect x={14} y={152} width={172} height={2} rx={1} fill={statusColor} opacity={0.5} />
      </svg>
    </div>
  );
};

CornellDualDrainRenderer.displayName = 'CornellDualDrainRenderer';
export default memo(CornellDualDrainRenderer);
