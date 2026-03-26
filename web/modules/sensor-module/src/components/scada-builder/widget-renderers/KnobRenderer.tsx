/**
 * KnobRenderer - Rotary knob input control for analog value adjustment.
 * Users drag to rotate the knob, which writes the computed value
 * to the bound tag via TagValueBus (onCommand).
 *
 * Architecture: Pointer events (not mouse events) for touch support.
 * Angle-to-value mapping uses linear interpolation with configurable
 * min/max angle range (default 30 to 330 = 300 degree sweep).
 * Step snapping rounds to nearest step value during drag.
 *
 * The knob is rendered as pure SVG: circular track, rotating indicator,
 * tick marks, and center value display. All interaction is handled
 * through pointer events for cross-device compatibility.
 */

import React, { memo, useCallback, useRef, useState, useEffect } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const DEG_TO_RAD = Math.PI / 180;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Clamp a value between min and max bounds.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Snap a value to the nearest step increment.
 * Prevents floating-point drift by rounding to step precision.
 */
function snapToStep(value: number, step: number, min: number): number {
  if (step <= 0) return value;
  const snapped = Math.round((value - min) / step) * step + min;
  // Prevent floating point noise by rounding to step's decimal precision
  const decimals = step.toString().split('.')[1]?.length ?? 0;
  return parseFloat(snapped.toFixed(decimals));
}

/**
 * Calculate the angle (in degrees, 0 = top, clockwise positive)
 * from a center point to a pointer position.
 */
function pointerAngle(
  cx: number,
  cy: number,
  px: number,
  py: number,
): number {
  const dx = px - cx;
  const dy = py - cy;
  // atan2 returns radians where 0 = right, positive = counter-clockwise
  // We need 0 = top, positive = clockwise
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI);
  if (angle < 0) angle += 360;
  return angle;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const KnobRenderer: React.FC<WidgetRendererProps> = ({
  config,
  value,
  width,
  height,
  isEditing,
  onCommand,
}) => {
  /* ---- Config ---- */
  const min = (config.min as number) ?? 0;
  const max = (config.max as number) ?? 100;
  const step = (config.step as number) ?? 1;
  const startAngle = (config.startAngle as number) ?? 30;
  const endAngle = (config.endAngle as number) ?? 330;
  const showValue = (config.showValue as boolean) ?? true;
  const showTicks = (config.showTicks as boolean) ?? true;
  const tickCount = (config.tickCount as number) ?? 11;
  const knobColor = (config.knobColor as string) ?? '#374151';
  const trackColor = (config.trackColor as string) ?? '#e5e7eb';
  const indicatorColor = (config.indicatorColor as string) ?? '#06b6d4';
  const label = (config.label as string) ?? 'Knob';

  /* ---- State ---- */
  const [isDragging, setIsDragging] = useState(false);
  const [localValue, setLocalValue] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Resolve displayed value: local drag value takes priority during interaction
  const rawValue = isEditing
    ? (config.demoValue as number) ?? 42
    : typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? parseFloat(value) || 0
        : 0;

  const displayValue = localValue !== null ? localValue : clamp(rawValue, min, max);

  /* ---- Geometry ---- */
  const PAD = 8;
  const size = Math.min(width, height) - PAD * 2;
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size / 2 - 4;
  const trackR = outerR - 6;
  const indicatorR = trackR - 8;
  const tickOuterR = outerR + 1;
  const tickInnerR = outerR - 5;

  /* ---- Angular sweep ---- */
  const sweep = endAngle - startAngle; // total degrees of rotation range

  /**
   * Map a value [min, max] to an angle [startAngle, endAngle].
   * Angles are measured from top (0 deg) clockwise.
   */
  const valueToAngle = useCallback(
    (v: number): number => {
      const pct = (clamp(v, min, max) - min) / (max - min || 1);
      return startAngle + pct * sweep;
    },
    [min, max, startAngle, sweep],
  );

  /**
   * Map an angle [startAngle, endAngle] back to a value [min, max].
   */
  const angleToValue = useCallback(
    (angle: number): number => {
      const pct = clamp((angle - startAngle) / sweep, 0, 1);
      return min + pct * (max - min);
    },
    [min, max, startAngle, sweep],
  );

  /* ---- Pointer handlers ---- */
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (isEditing) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsDragging(true);

      // Compute initial value from pointer position
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      let angle = pointerAngle(cx + PAD, cy + PAD, px, py);

      // Clamp to knob range
      angle = clamp(angle, startAngle, endAngle);
      const newVal = snapToStep(angleToValue(angle), step, min);
      setLocalValue(clamp(newVal, min, max));
    },
    [isEditing, cx, cy, startAngle, endAngle, angleToValue, step, min, max],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!isDragging) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      let angle = pointerAngle(cx + PAD, cy + PAD, px, py);

      angle = clamp(angle, startAngle, endAngle);
      const newVal = snapToStep(angleToValue(angle), step, min);
      setLocalValue(clamp(newVal, min, max));
    },
    [isDragging, cx, cy, startAngle, endAngle, angleToValue, step, min, max],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!isDragging) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      setIsDragging(false);

      // Emit the final value via onCommand for TagValueBus
      if (localValue !== null && onCommand) {
        onCommand('setValue', localValue);
      }
      // Keep localValue displayed until next external value arrives
    },
    [isDragging, localValue, onCommand],
  );

  // Clear local override when external value changes (tag update arrived)
  useEffect(() => {
    if (!isDragging) {
      setLocalValue(null);
    }
  }, [value, isDragging]);

  /* ---- Indicator position ---- */
  const currentAngle = valueToAngle(displayValue);
  const indicatorRad = currentAngle * DEG_TO_RAD;
  // SVG coordinate system: 0 deg = top, measured from center
  const indX = cx + indicatorR * Math.sin(indicatorRad);
  const indY = cy - indicatorR * Math.cos(indicatorRad);

  /* ---- Ticks ---- */
  const ticks = [];
  for (let i = 0; i < tickCount; i++) {
    const pct = i / (tickCount - 1);
    const angle = startAngle + pct * sweep;
    const rad = angle * DEG_TO_RAD;
    const x1 = cx + tickInnerR * Math.sin(rad);
    const y1 = cy - tickInnerR * Math.cos(rad);
    const x2 = cx + tickOuterR * Math.sin(rad);
    const y2 = cy - tickOuterR * Math.cos(rad);
    ticks.push({ x1, y1, x2, y2, angle });
  }

  /* ---- Track arc path (background) ---- */
  const trackStartRad = startAngle * DEG_TO_RAD;
  const trackEndRad = endAngle * DEG_TO_RAD;
  const trackStartX = cx + trackR * Math.sin(trackStartRad);
  const trackStartY = cy - trackR * Math.cos(trackStartRad);
  const trackEndX = cx + trackR * Math.sin(trackEndRad);
  const trackEndY = cy - trackR * Math.cos(trackEndRad);
  const largeArc = sweep > 180 ? 1 : 0;
  const trackPath = `M ${trackStartX} ${trackStartY} A ${trackR} ${trackR} 0 ${largeArc} 1 ${trackEndX} ${trackEndY}`;

  /* ---- Active arc path (filled portion from start to current) ---- */
  const activeEndRad = currentAngle * DEG_TO_RAD;
  const activeEndX = cx + trackR * Math.sin(activeEndRad);
  const activeEndY = cy - trackR * Math.cos(activeEndRad);
  const activeSweep = currentAngle - startAngle;
  const activeLargeArc = activeSweep > 180 ? 1 : 0;
  const activePath = `M ${trackStartX} ${trackStartY} A ${trackR} ${trackR} 0 ${activeLargeArc} 1 ${activeEndX} ${activeEndY}`;

  return (
    <div style={{ width, height, padding: PAD, boxSizing: 'border-box' }}>
      <svg
        ref={svgRef}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{
          display: 'block',
          cursor: isEditing ? 'default' : isDragging ? 'grabbing' : 'grab',
          touchAction: 'none', // Prevent browser pan/zoom on touch devices
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* Background circle */}
        <circle
          cx={cx}
          cy={cy}
          r={outerR}
          fill="#f9fafb"
          stroke="#e5e7eb"
          strokeWidth={1}
        />

        {/* Track arc (background) */}
        <path
          d={trackPath}
          fill="none"
          stroke={trackColor}
          strokeWidth={6}
          strokeLinecap="round"
        />

        {/* Active arc (colored portion showing current value) */}
        <path
          d={activePath}
          fill="none"
          stroke={indicatorColor}
          strokeWidth={6}
          strokeLinecap="round"
          style={{ transition: isDragging ? 'none' : 'd 200ms ease-out' }}
        />

        {/* Tick marks */}
        {showTicks &&
          ticks.map((tick, i) => (
            <line
              key={i}
              x1={tick.x1}
              y1={tick.y1}
              x2={tick.x2}
              y2={tick.y2}
              stroke="#9ca3af"
              strokeWidth={1}
              strokeLinecap="round"
            />
          ))}

        {/* Knob center circle */}
        <circle cx={cx} cy={cy} r={indicatorR - 4} fill={knobColor} />
        <circle cx={cx} cy={cy} r={indicatorR - 8} fill="#4b5563" />

        {/* Indicator line (rotating pointer) */}
        <line
          x1={cx}
          y1={cy}
          x2={indX}
          y2={indY}
          stroke={indicatorColor}
          strokeWidth={3}
          strokeLinecap="round"
          style={{
            transition: isDragging ? 'none' : 'x2 200ms ease-out, y2 200ms ease-out',
          }}
        />

        {/* Indicator dot at tip */}
        <circle
          cx={indX}
          cy={indY}
          r={3}
          fill={indicatorColor}
          stroke="white"
          strokeWidth={1}
        />

        {/* Center value display */}
        {showValue && (
          <text
            x={cx}
            y={cy + 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={Math.min(16, size * 0.12)}
            fontWeight={700}
            fill="white"
          >
            {displayValue.toFixed(step < 1 ? 1 : 0)}
          </text>
        )}

        {/* Label below knob */}
        <text
          x={cx}
          y={size - 2}
          textAnchor="middle"
          fontSize={Math.min(10, size * 0.08)}
          fill="#6b7280"
        >
          {label}
        </text>

        {/* Min/Max labels */}
        <text
          x={ticks[0]?.x2 ?? 0}
          y={(ticks[0]?.y2 ?? 0) + 10}
          textAnchor="middle"
          fontSize={7}
          fill="#9ca3af"
        >
          {min}
        </text>
        <text
          x={ticks[ticks.length - 1]?.x2 ?? 0}
          y={(ticks[ticks.length - 1]?.y2 ?? 0) + 10}
          textAnchor="middle"
          fontSize={7}
          fill="#9ca3af"
        >
          {max}
        </text>
      </svg>
    </div>
  );
};

KnobRenderer.displayName = 'KnobRenderer';
export default memo(KnobRenderer);
