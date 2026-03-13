/**
 * GaugeRenderer - SVG half-circle gauge with smooth arc animation,
 * needle pointer, threshold color bands, tick marks, and value pulse.
 * NaN-safe numeric parsing. Read-only (no onCommand).
 */

import React, { memo, useRef, useEffect, useState } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

/* ------------------------------------------------------------------ */
/*  Inject animation keyframes once                                    */
/* ------------------------------------------------------------------ */

let gaugeStyleInjected = false;

function injectGaugeStyles() {
  if (gaugeStyleInjected) return;
  const style = document.createElement('style');
  style.textContent = `
@keyframes gaugePulse {
  0%   { transform: scale(1); }
  40%  { transform: scale(1.06); }
  100% { transform: scale(1); }
}
`;
  document.head.appendChild(style);
  gaugeStyleInjected = true;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CX = 100;           // center x in viewBox
const CY = 95;            // center y in viewBox
const R = 70;             // arc radius
const ARC_WIDTH = 12;     // main arc stroke width
const BAND_WIDTH = 14;    // background band stroke width (slightly wider)
const NEEDLE_LEN = 62;    // needle length (shorter than R so it doesn't overlap arc)
const START_ANGLE = Math.PI;  // 180 deg (left)
const END_ANGLE = 0;          // 0 deg (right)
const ARC_SPAN = Math.PI;     // total sweep = 180 deg

// Half-circle arc length
const ARC_LENGTH = Math.PI * R; // pi * r for 180 deg

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Convert a fraction [0..1] to an angle on the half-circle (PI..0) */
function pctToAngle(pct: number): number {
  return START_ANGLE - ARC_SPAN * pct;
}

/** Cartesian point on the arc for a given angle */
function arcPoint(angle: number): { x: number; y: number } {
  return { x: CX + R * Math.cos(angle), y: CY - R * Math.sin(angle) };
}

/** Build an SVG arc path from startAngle to endAngle (both in radians, going clockwise visually) */
function arcPath(fromAngle: number, toAngle: number, radius: number): string {
  const start = { x: CX + radius * Math.cos(fromAngle), y: CY - radius * Math.sin(fromAngle) };
  const end = { x: CX + radius * Math.cos(toAngle), y: CY - radius * Math.sin(toAngle) };
  // Sweep angle in the "pct" sense (fromAngle > toAngle means going right on the half-circle)
  const sweep = fromAngle - toAngle;
  const largeArc = sweep > Math.PI ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

/* ------------------------------------------------------------------ */
/*  Tick mark positions                                                */
/* ------------------------------------------------------------------ */

const TICK_PCTS = [0, 0.25, 0.5, 0.75, 1.0];
const TICK_INNER = R - 8;
const TICK_OUTER = R + 8;

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const GaugeRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  // Inject CSS once
  useEffect(injectGaugeStyles, []);

  /* ---- config ---- */
  const min = (config.min ?? 0) as number;
  const max = (config.max ?? 100) as number;
  const unit = (config.unit ?? '') as string;
  const label = (config.label ?? 'Gauge') as string;
  const warningThreshold = (config.warningThreshold ?? 70) as number;
  const criticalThreshold = (config.criticalThreshold ?? 90) as number;

  /* ---- value parsing ---- */
  const raw = isEditing ? (config.demoValue ?? 42) : Number(value ?? 0);
  const numValue = typeof raw === 'number' && !isNaN(raw) ? raw : 0;
  const safeValue = isNaN(numValue) ? 0 : numValue;
  const pct = Math.max(0, Math.min(1, (safeValue - min) / (max - min || 1)));

  /* ---- threshold pcts ---- */
  const warningPct = Math.max(0, Math.min(1, (warningThreshold - min) / (max - min || 1)));
  const criticalPct = Math.max(0, Math.min(1, (criticalThreshold - min) / (max - min || 1)));

  /* ---- active color ---- */
  let activeColor = '#22c55e'; // green
  if (pct >= criticalPct) activeColor = '#ef4444';
  else if (pct >= warningPct) activeColor = '#eab308';

  /* ---- responsive font sizes ---- */
  const h = height - 16;
  const valueFontSize = Math.min(h * 0.18, 24);
  const labelFontSize = Math.min(h * 0.08, 11);
  const minMaxFontSize = Math.min(h * 0.07, 10);

  /* ---- value pulse detection ---- */
  const prevValueRef = useRef(safeValue);
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    if (prevValueRef.current !== safeValue) {
      prevValueRef.current = safeValue;
      setPulsing(true);
      const timer = setTimeout(() => setPulsing(false), 350);
      return () => clearTimeout(timer);
    }
  }, [safeValue]);

  /* ---- dashoffset for animated value arc ---- */
  // stroke-dasharray = full arc length
  // stroke-dashoffset = arcLength * (1 - pct)  (0 offset = full, arcLength offset = empty)
  const dashOffset = ARC_LENGTH * (1 - pct);

  /* ---- needle angle ---- */
  // Needle rotates from 180 deg (pointing left = 0%) to 0 deg (pointing right = 100%)
  // In SVG rotate(), 0 deg = right, positive = clockwise
  // Our angles: pct 0 → pointing left (SVG rotate = 180 from right), pct 1 → pointing right (SVG rotate = 0)
  // SVG rotation is measured clockwise from the positive x axis.
  // At pct=0, the needle should point left (180 deg SVG rotation).
  // At pct=1, the needle should point right (0 deg SVG rotation).
  // Since our arc goes from PI (left, 180 deg) to 0 (right, 0 deg):
  // needleSvgAngle = 180 - 180*pct  (in degrees)
  const needleDeg = 180 - 180 * pct;

  /* ---- threshold band paths ---- */
  // Green band: 0% → warningPct
  const greenBandPath = arcPath(pctToAngle(0), pctToAngle(warningPct), R);
  // Yellow band: warningPct → criticalPct
  const yellowBandPath = warningPct < criticalPct
    ? arcPath(pctToAngle(warningPct), pctToAngle(criticalPct), R)
    : '';
  // Red band: criticalPct → 100%
  const redBandPath = criticalPct < 1
    ? arcPath(pctToAngle(criticalPct), pctToAngle(1), R)
    : '';

  /* ---- full background arc (for the dasharray-based value arc) ---- */
  const fullArcPath = arcPath(START_ANGLE, END_ANGLE, R);

  /* ---- min/max label positions ---- */
  const leftPt = arcPoint(START_ANGLE);
  const rightPt = arcPoint(END_ANGLE);

  return (
    <div style={{ width, height, padding: 8, boxSizing: 'border-box' }}>
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 200 130"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* ---- Threshold color bands (background) ---- */}
        <path
          d={greenBandPath}
          fill="none"
          stroke="#22c55e"
          strokeWidth={BAND_WIDTH}
          strokeLinecap="butt"
          opacity={0.15}
        />
        {yellowBandPath && (
          <path
            d={yellowBandPath}
            fill="none"
            stroke="#eab308"
            strokeWidth={BAND_WIDTH}
            strokeLinecap="butt"
            opacity={0.15}
          />
        )}
        {redBandPath && (
          <path
            d={redBandPath}
            fill="none"
            stroke="#ef4444"
            strokeWidth={BAND_WIDTH}
            strokeLinecap="butt"
            opacity={0.15}
          />
        )}

        {/* ---- Background arc (neutral track) ---- */}
        <path
          d={fullArcPath}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={ARC_WIDTH}
          strokeLinecap="round"
        />

        {/* ---- Value arc (animated via dashoffset) ---- */}
        <path
          d={fullArcPath}
          fill="none"
          stroke={activeColor}
          strokeWidth={ARC_WIDTH}
          strokeLinecap="round"
          strokeDasharray={ARC_LENGTH}
          strokeDashoffset={dashOffset}
          style={{
            transition: 'stroke-dashoffset 300ms ease-out, stroke 300ms ease-out',
          }}
        />

        {/* ---- Tick marks ---- */}
        {TICK_PCTS.map((t) => {
          const angle = pctToAngle(t);
          const inner = { x: CX + TICK_INNER * Math.cos(angle), y: CY - TICK_INNER * Math.sin(angle) };
          const outer = { x: CX + TICK_OUTER * Math.cos(angle), y: CY - TICK_OUTER * Math.sin(angle) };
          return (
            <line
              key={t}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke="#9ca3af"
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          );
        })}

        {/* ---- Needle / pointer ---- */}
        <g
          style={{
            transformOrigin: `${CX}px ${CY}px`,
            transform: `rotate(${-needleDeg}deg)`,
            transition: 'transform 300ms ease-out',
          }}
        >
          {/* Needle body — thin tapered line */}
          <line
            x1={CX}
            y1={CY}
            x2={CX + NEEDLE_LEN}
            y2={CY}
            stroke="#374151"
            strokeWidth={2}
            strokeLinecap="round"
          />
          {/* Needle tip — small triangle */}
          <polygon
            points={`${CX + NEEDLE_LEN},${CY} ${CX + NEEDLE_LEN - 5},${CY - 2.5} ${CX + NEEDLE_LEN - 5},${CY + 2.5}`}
            fill="#374151"
          />
          {/* Center pivot circle */}
          <circle cx={CX} cy={CY} r={4} fill="#374151" />
          <circle cx={CX} cy={CY} r={2} fill="#ffffff" />
        </g>

        {/* ---- Value text (with pulse animation) ---- */}
        <text
          x={CX}
          y={CY - 14}
          textAnchor="middle"
          fontSize={valueFontSize}
          fontWeight={700}
          fill="#111827"
          style={{
            transformOrigin: `${CX}px ${CY - 14}px`,
            animation: pulsing ? 'gaugePulse 300ms ease-out' : 'none',
          }}
        >
          {safeValue.toFixed(1)}
        </text>

        {/* ---- Unit ---- */}
        <text x={CX} y={CY + 4} textAnchor="middle" fontSize={labelFontSize} fill="#6b7280">
          {unit}
        </text>

        {/* ---- Label ---- */}
        <text x={CX} y={125} textAnchor="middle" fontSize={minMaxFontSize} fill="#9ca3af">
          {label}
        </text>

        {/* ---- Min / Max labels ---- */}
        <text
          x={leftPt.x - 2}
          y={leftPt.y + 14}
          textAnchor="end"
          fontSize={minMaxFontSize}
          fill="#9ca3af"
        >
          {min}
        </text>
        <text
          x={rightPt.x + 2}
          y={rightPt.y + 14}
          textAnchor="start"
          fontSize={minMaxFontSize}
          fill="#9ca3af"
        >
          {max}
        </text>
      </svg>
    </div>
  );
};

GaugeRenderer.displayName = 'GaugeRenderer';
export default memo(GaugeRenderer);
