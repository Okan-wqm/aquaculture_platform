/**
 * FeederRenderer - Hopper-style automatic fish feeder (Yemlik)
 *
 * SVG drawing: conical hopper with motor housing on top, feed discharge
 * chute at bottom, fill-level indicator inside hopper, and motor status.
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const STATUS_COLORS: Record<string, string> = {
  running: '#22c55e',
  stopped: '#9ca3af',
  error: '#ef4444',
};

const STATUS_LABELS: Record<string, string> = {
  running: 'Calisiyor',
  stopped: 'Durdu',
  error: 'Hata',
};

const FeederRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const label = (config.label ?? 'Yemlik') as string;
  const rawLevel = isEditing
    ? ((config.demoFeedLevel ?? 65) as number)
    : Number(value ?? 0);
  const feedLevel = Math.max(0, Math.min(100, isNaN(rawLevel) ? 0 : rawLevel));
  const status = (
    isEditing ? ((config.demoStatus ?? 'running') as string) : String(value ?? 'stopped')
  ).toLowerCase();
  const statusColor = STATUS_COLORS[status] ?? '#9ca3af';
  const statusLabel = STATUS_LABELS[status] ?? status;
  const pct = feedLevel / 100;

  // --- Hopper geometry (viewBox 0 0 120 160) ---
  // Motor housing: centered rect at top
  const motorX = 42;
  const motorY = 8;
  const motorW = 36;
  const motorH = 18;

  // Hopper body: trapezoid from wide top to narrow bottom
  const hopperTopY = motorY + motorH;            // 26
  const hopperTopLeft = 18;
  const hopperTopRight = 102;
  const hopperBottomY = 118;
  const hopperBottomLeft = 48;
  const hopperBottomRight = 72;

  // Discharge chute: small rect hanging below hopper
  const chuteX = 52;
  const chuteY = hopperBottomY;
  const chuteW = 16;
  const chuteH = 14;

  // --- Fill polygon: mirrors hopper shape, clipped by level ---
  // Fill from bottom up. The hopper narrows linearly from top to bottom.
  // At fill fraction pct, the fill top edge is at:
  const fillTopY = hopperBottomY - pct * (hopperBottomY - hopperTopY);
  // Interpolate left/right x at fillTopY
  const tFill = pct; // 0=bottom, 1=top
  const fillTopLeft = hopperBottomLeft + tFill * (hopperTopLeft - hopperBottomLeft);
  const fillTopRight = hopperBottomRight + tFill * (hopperTopRight - hopperBottomRight);

  // Fill color: blue normally, yellow when low, red when critically low
  let fillColor = '#8B6914'; // feed/grain brown
  if (pct < 0.15) fillColor = '#ef4444';
  else if (pct < 0.3) fillColor = '#eab308';

  return (
    <div style={{ width, height, padding: 8, boxSizing: 'border-box' }}>
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 120 160"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
      >
        {/* ---- Label ---- */}
        <text x={60} y={7} textAnchor="middle" fontSize={10} fill="#374151" fontWeight={500}>
          {label}
        </text>

        {/* ---- Motor housing ---- */}
        <rect
          x={motorX}
          y={motorY}
          width={motorW}
          height={motorH}
          rx={3}
          fill="#e0e0e0"
          stroke="#444"
          strokeWidth={2}
        />
        {/* Motor "M" symbol */}
        <text
          x={motorX + motorW / 2}
          y={motorY + motorH / 2 + 1}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={11}
          fontWeight={700}
          fill="#333"
        >
          M
        </text>

        {/* Motor status indicator dot */}
        <circle cx={motorX + motorW - 5} cy={motorY + 5} r={3} fill={statusColor}>
          {status === 'running' && (
            <animate attributeName="opacity" values="1;0.4;1" dur="1.2s" repeatCount="indefinite" />
          )}
        </circle>

        {/* ---- Hopper body (trapezoid outline) ---- */}
        <polygon
          points={`${hopperTopLeft},${hopperTopY} ${hopperTopRight},${hopperTopY} ${hopperBottomRight},${hopperBottomY} ${hopperBottomLeft},${hopperBottomY}`}
          fill="#f1f5f9"
          stroke="#444"
          strokeWidth={2}
          strokeLinejoin="round"
        />

        {/* ---- Fill inside hopper ---- */}
        {pct > 0 && (
          <polygon
            points={`${fillTopLeft},${fillTopY} ${fillTopRight},${fillTopY} ${hopperBottomRight},${hopperBottomY} ${hopperBottomLeft},${hopperBottomY}`}
            fill={fillColor}
            opacity={0.75}
          />
        )}

        {/* ---- Feed level percentage (centered in hopper) ---- */}
        <text
          x={60}
          y={78}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={16}
          fontWeight={700}
          fill="#111827"
        >
          {Math.round(feedLevel)}
        </text>
        <text
          x={60}
          y={93}
          textAnchor="middle"
          fontSize={10}
          fill="#6b7280"
        >
          %
        </text>

        {/* ---- Discharge chute ---- */}
        <rect
          x={chuteX}
          y={chuteY}
          width={chuteW}
          height={chuteH}
          rx={1}
          fill="#cfd8dc"
          stroke="#444"
          strokeWidth={1.5}
        />

        {/* Feed particles falling (only when running) */}
        {status === 'running' && (
          <>
            <circle cx={57} cy={chuteY + chuteH + 4} r={1.5} fill={fillColor} opacity={0.8}>
              <animate attributeName="cy" from={chuteY + chuteH + 2} to={chuteY + chuteH + 16} dur="0.8s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.8;0" dur="0.8s" repeatCount="indefinite" />
            </circle>
            <circle cx={60} cy={chuteY + chuteH + 6} r={1.5} fill={fillColor} opacity={0.8}>
              <animate attributeName="cy" from={chuteY + chuteH + 2} to={chuteY + chuteH + 16} dur="0.8s" begin="0.25s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.8;0" dur="0.8s" begin="0.25s" repeatCount="indefinite" />
            </circle>
            <circle cx={63} cy={chuteY + chuteH + 4} r={1.5} fill={fillColor} opacity={0.8}>
              <animate attributeName="cy" from={chuteY + chuteH + 2} to={chuteY + chuteH + 16} dur="0.8s" begin="0.5s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.8;0" dur="0.8s" begin="0.5s" repeatCount="indefinite" />
            </circle>
          </>
        )}

        {/* ---- Status text ---- */}
        <text
          x={60}
          y={154}
          textAnchor="middle"
          fontSize={10}
          fontWeight={600}
          fill={statusColor}
        >
          {statusLabel}
        </text>

        {/* ---- Spinning motor indicator (when running) ---- */}
        {status === 'running' && (
          <g transform={`translate(${motorX + motorW / 2}, ${motorY + motorH / 2})`}>
            <animateTransform
              attributeName="transform"
              type="rotate"
              from={`0 ${motorX + motorW / 2} ${motorY + motorH / 2}`}
              to={`360 ${motorX + motorW / 2} ${motorY + motorH / 2}`}
              dur="2s"
              repeatCount="indefinite"
            />
            {/* Small rotation indicator lines around motor */}
            <line x1={-14} y1={0} x2={-17} y2={0} stroke={statusColor} strokeWidth={1.5} />
            <line x1={14} y1={0} x2={17} y2={0} stroke={statusColor} strokeWidth={1.5} />
            <line x1={0} y1={-7} x2={0} y2={-10} stroke={statusColor} strokeWidth={1.5} />
          </g>
        )}
      </svg>
    </div>
  );
};

FeederRenderer.displayName = 'FeederRenderer';
export default memo(FeederRenderer);
