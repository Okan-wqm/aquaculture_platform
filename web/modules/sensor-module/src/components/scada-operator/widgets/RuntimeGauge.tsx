/**
 * RuntimeGauge — Enhanced SVG circular gauge for operator mode.
 *
 * Modes:
 *   dial   — classic half-circle gauge with needle and arc (default)
 *   donut  — full-circle donut with value arc
 *   zone   — full-circle with coloured zone arcs and no needle
 *
 * Features:
 *   - Smooth CSS transition on needle rotation and arc dashoffset
 *   - Configurable zones (color ranges) rendered as arc segments
 *   - Center value text, label, and unit
 *   - Responsive SVG (preserveAspectRatio)
 *   - Accessible aria-label
 */

import React, { memo, useMemo } from 'react';
import type { RuntimeWidgetProps } from '../../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface GaugeZone {
  min: number;
  max: number;
  color: string;
  label?: string;
}

/* ------------------------------------------------------------------ */
/*  SVG helpers                                                         */
/* ------------------------------------------------------------------ */

const TWO_PI = 2 * Math.PI;

function polarToCartesian(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number,
): string {
  const start = polarToCartesian(cx, cy, r, endDeg);
  const end = polarToCartesian(cx, cy, r, startDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 0 ${end.x} ${end.y}`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

const RuntimeGauge: React.FC<RuntimeWidgetProps> = ({
  value,
  config,
  isEnabled,
  width = 200,
  height = 180,
}) => {
  /* ---- config ---- */
  const min = (config.min ?? 0) as number;
  const max = (config.max ?? 100) as number;
  const unit = (config.unit ?? '') as string;
  const label = (config.label ?? '') as string;
  const mode = (config.mode ?? 'dial') as 'dial' | 'donut' | 'zone';
  const decimals = (config.decimals ?? 1) as number;
  const zones = (config.zones ?? []) as GaugeZone[];

  /* ---- value ---- */
  const raw = Number(value ?? 0);
  const numVal = isNaN(raw) ? 0 : raw;
  const clamped = Math.max(min, Math.min(max, numVal));
  const pct = max === min ? 0 : (clamped - min) / (max - min);
  const displayVal = isNaN(raw) ? '--' : numVal.toFixed(decimals);

  /* ---- active zone color ---- */
  const activeZoneColor = useMemo(() => {
    if (zones.length === 0) return '#22c55e';
    const sorted = [...zones].sort((a, b) => a.min - b.min);
    for (const z of sorted) {
      if (numVal >= z.min && numVal <= z.max) return z.color;
    }
    return sorted[sorted.length - 1]?.color ?? '#22c55e';
  }, [zones, numVal]);

  /* ---- SVG constants ---- */
  const CX = 100;
  const CY = mode === 'dial' ? 95 : 100;
  const R = 70;
  const TRACK_WIDTH = 12;
  const ZONE_WIDTH = 14;

  /* ---- dial mode ---- */
  if (mode === 'dial') {
    // Half circle: -180 deg (left) to 0 deg (right)
    const ARC_LENGTH = Math.PI * R;
    const dashOffset = ARC_LENGTH * (1 - pct);
    const needleDeg = -180 + 180 * pct;

    // Zone arc paths (half circle, mapped from 0..1 to -180..0)
    function halfArcPath(fromPct: number, toPct: number): string {
      const startDeg = -180 + 180 * fromPct;
      const endDeg = -180 + 180 * toPct;
      // Use polarToCartesian with 90-degree offset for half-circle
      const toHalf = (deg: number) => {
        const rad = (deg * Math.PI) / 180;
        return { x: CX + R * Math.cos(rad), y: CY - R * Math.sin(rad) };
      };
      const s = toHalf(startDeg < endDeg ? startDeg : endDeg);
      const e = toHalf(startDeg < endDeg ? endDeg : startDeg);
      const sweep = Math.abs(endDeg - startDeg);
      const large = sweep > 180 ? 1 : 0;
      return `M ${s.x} ${s.y} A ${R} ${R} 0 ${large} 1 ${e.x} ${e.y}`;
    }

    const fullArcPath = halfArcPath(0, 1);

    return (
      <div
        className="w-full h-full flex items-center justify-center"
        aria-label={`${label} gauge: ${displayVal} ${unit}`}
        role="img"
      >
        <svg
          width={width}
          height={height}
          viewBox="0 0 200 130"
          preserveAspectRatio="xMidYMid meet"
          className="block overflow-visible"
          style={{ opacity: isEnabled ? 1 : 0.5 }}
        >
          {/* Zone bands */}
          {zones.length > 0 &&
            zones.map((z, i) => {
              const zFromPct = Math.max(0, Math.min(1, (z.min - min) / (max - min || 1)));
              const zToPct = Math.max(0, Math.min(1, (z.max - min) / (max - min || 1)));
              if (zFromPct >= zToPct) return null;
              return (
                <path
                  key={i}
                  d={halfArcPath(zFromPct, zToPct)}
                  fill="none"
                  stroke={z.color}
                  strokeWidth={ZONE_WIDTH}
                  strokeLinecap="butt"
                  opacity={0.2}
                />
              );
            })}

          {/* Track */}
          <path
            d={fullArcPath}
            fill="none"
            stroke="#e5e7eb"
            strokeWidth={TRACK_WIDTH}
            strokeLinecap="round"
          />

          {/* Value arc */}
          <path
            d={fullArcPath}
            fill="none"
            stroke={activeZoneColor}
            strokeWidth={TRACK_WIDTH}
            strokeLinecap="round"
            strokeDasharray={ARC_LENGTH}
            strokeDashoffset={dashOffset}
            style={{ transition: 'stroke-dashoffset 350ms ease-out, stroke 350ms ease-out' }}
          />

          {/* Needle */}
          <g
            style={{
              transformOrigin: `${CX}px ${CY}px`,
              transform: `rotate(${needleDeg}deg)`,
              transition: 'transform 350ms ease-out',
            }}
          >
            <line
              x1={CX}
              y1={CY}
              x2={CX + 62}
              y2={CY}
              stroke="#374151"
              strokeWidth={2}
              strokeLinecap="round"
            />
            <circle cx={CX} cy={CY} r={4} fill="#374151" />
            <circle cx={CX} cy={CY} r={2} fill="#ffffff" />
          </g>

          {/* Value */}
          <text
            x={CX}
            y={CY - 12}
            textAnchor="middle"
            fontSize={Math.min(height * 0.14, 20)}
            fontWeight={700}
            fill="#111827"
          >
            {displayVal}
          </text>
          <text x={CX} y={CY + 4} textAnchor="middle" fontSize={10} fill="#6b7280">
            {unit}
          </text>
          <text x={CX} y={126} textAnchor="middle" fontSize={9} fill="#9ca3af">
            {label}
          </text>

          {/* Min / Max */}
          <text x={26} y={106} textAnchor="middle" fontSize={8} fill="#9ca3af">
            {min}
          </text>
          <text x={174} y={106} textAnchor="middle" fontSize={8} fill="#9ca3af">
            {max}
          </text>
        </svg>
      </div>
    );
  }

  /* ---- donut / zone mode ---- */
  // Full circle: start at -90 (top), sweep clockwise
  const DONUT_START = -90;
  const FULL_SWEEP = 360;
  const ARC_CIRCUMFERENCE = TWO_PI * R;

  // Value arc: donut tracks the value as a portion of 360 deg
  const valueArcDeg = pct * FULL_SWEEP;

  return (
    <div
      className="w-full h-full flex items-center justify-center"
      aria-label={`${label} gauge: ${displayVal} ${unit}`}
      role="img"
    >
      <svg
        width={width}
        height={height}
        viewBox="0 0 200 200"
        preserveAspectRatio="xMidYMid meet"
        className="block overflow-visible"
        style={{ opacity: isEnabled ? 1 : 0.5 }}
      >
        {/* Track ring */}
        <circle
          cx={CX}
          cy={100}
          r={R}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={TRACK_WIDTH}
        />

        {mode === 'zone' && zones.length > 0
          ? /* Zone segments */
            zones.map((z, i) => {
              const zFromPct = Math.max(0, Math.min(1, (z.min - min) / (max - min || 1)));
              const zToPct = Math.max(0, Math.min(1, (z.max - min) / (max - min || 1)));
              if (zFromPct >= zToPct) return null;
              const startDeg = DONUT_START + zFromPct * FULL_SWEEP;
              const endDeg = DONUT_START + zToPct * FULL_SWEEP;
              return (
                <path
                  key={i}
                  d={describeArc(CX, 100, R, startDeg, endDeg)}
                  fill="none"
                  stroke={z.color}
                  strokeWidth={ZONE_WIDTH}
                  strokeLinecap="round"
                />
              );
            })
          : /* Donut value arc via dashoffset */
            (() => {
              const dashOff = ARC_CIRCUMFERENCE * (1 - pct);
              return (
                <circle
                  cx={CX}
                  cy={100}
                  r={R}
                  fill="none"
                  stroke={activeZoneColor}
                  strokeWidth={TRACK_WIDTH}
                  strokeLinecap="round"
                  strokeDasharray={ARC_CIRCUMFERENCE}
                  strokeDashoffset={dashOff}
                  style={{
                    transformOrigin: `${CX}px 100px`,
                    transform: 'rotate(-90deg)',
                    transition: 'stroke-dashoffset 350ms ease-out, stroke 350ms ease-out',
                  }}
                />
              );
            })()}

        {/* Zone mode: value pointer dot */}
        {mode === 'zone' && (
          (() => {
            const pointerDeg = DONUT_START + pct * FULL_SWEEP;
            const pt = polarToCartesian(CX, 100, R, pointerDeg);
            return (
              <circle
                cx={pt.x}
                cy={pt.y}
                r={6}
                fill="#374151"
                style={{
                  transition: 'cx 350ms ease-out, cy 350ms ease-out',
                }}
              />
            );
          })()
        )}

        {/* Center text */}
        <text
          x={CX}
          y={96}
          textAnchor="middle"
          fontSize={Math.min(height * 0.14, 22)}
          fontWeight={700}
          fill="#111827"
        >
          {displayVal}
        </text>
        <text x={CX} y={112} textAnchor="middle" fontSize={10} fill="#6b7280">
          {unit}
        </text>
        <text x={CX} y={128} textAnchor="middle" fontSize={9} fill="#9ca3af">
          {label}
        </text>
      </svg>
    </div>
  );
};

RuntimeGauge.displayName = 'RuntimeGauge';
export default memo(RuntimeGauge);
