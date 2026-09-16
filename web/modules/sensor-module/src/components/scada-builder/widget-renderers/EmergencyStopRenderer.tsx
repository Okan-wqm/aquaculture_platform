/**
 * EmergencyStopRenderer - Large red E-STOP button.
 *
 * RUNTIME (T3):
 *   - Press-and-hold activation: the button must be held for
 *     config.holdDuration ms (default 3000 ms) before the E-STOP fires.
 *     A ring progress indicator fills while holding; releasing early cancels.
 *   - On hold completion → onCommand('emergencyStop', true). The runtime
 *     command router (RuntimeWidgetRenderer) drives every affected tag to
 *     its safe value and latches the state.
 *   - Persistent ISO 13850 disclaimer: this is a SOFTWARE E-Stop and is NOT
 *     a safety device — it must never replace a hardwired emergency stop.
 *
 * BUILDER PREVIEW (isEditing): visual only — no interaction, no commands.
 */

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const DEFAULT_HOLD_DURATION_MS = 3000;

/** Persistent disclaimer (ISO 13850) — always visible, both modes. */
const DISCLAIMER = 'SOFTWARE E-Stop — not a safety device (ISO 13850)';

const EmergencyStopRenderer: React.FC<WidgetRendererProps> = ({
  config,
  value,
  width,
  height,
  isEditing,
  onCommand,
}) => {
  const label = (config.label ?? 'E-STOP') as string;
  const activated = isEditing ? false : Boolean(value);
  const holdDuration = Number(config.holdDuration ?? DEFAULT_HOLD_DURATION_MS) || DEFAULT_HOLD_DURATION_MS;

  const [holdProgress, setHoldProgress] = useState(0);
  const holdStartedAtRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const stopHold = useCallback(() => {
    holdStartedAtRef.current = null;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setHoldProgress(0);
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const startHold = useCallback(
    (e: React.PointerEvent<SVGCircleElement>) => {
      if (isEditing) return;
      // Prevent text selection / touch scroll from swallowing the hold.
      e.preventDefault();

      holdStartedAtRef.current = Date.now();
      const tick = (): void => {
        const startedAt = holdStartedAtRef.current;
        if (startedAt === null) return;
        const elapsed = Date.now() - startedAt;
        const progress = Math.min(1, elapsed / holdDuration);
        setHoldProgress(progress);
        if (progress >= 1) {
          stopHold();
          onCommand?.('emergencyStop', true);
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [isEditing, holdDuration, onCommand, stopHold],
  );

  const h = height - 16; // account for padding + disclaimer
  const labelFontSize = Math.min(h * 0.13, 22);
  const statusFontSize = Math.min(h * 0.075, 11);

  // Hold progress ring (sweep from the top, clockwise).
  const ringCircumference = 2 * Math.PI * 72;

  return (
    <div
      style={{
        width,
        height,
        padding: 8,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 200 200"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block', cursor: isEditing ? 'default' : 'pointer', flex: 1 }}
        role={isEditing ? 'img' : 'button'}
        aria-label="Emergency Stop"
      >
        {/* Pulse animation for runtime */}
        {!isEditing && activated && (
          <circle cx={100} cy={96} r={80} fill="none" stroke="#ef4444" strokeWidth={2} opacity={0.6}>
            <animate attributeName="r" from={72} to={90} dur="1s" repeatCount="indefinite" />
            <animate attributeName="opacity" from="0.6" to="0" dur="1s" repeatCount="indefinite" />
          </circle>
        )}
        {/* Hold progress ring (runtime only) */}
        {!isEditing && holdProgress > 0 && (
          <circle
            cx={100}
            cy={96}
            r={72}
            fill="none"
            stroke="#b91c1c"
            strokeWidth={5}
            strokeLinecap="round"
            strokeDasharray={ringCircumference}
            strokeDashoffset={ringCircumference * (1 - holdProgress)}
            transform="rotate(-90 100 96)"
          />
        )}
        {/* Outer ring */}
        <circle
          cx={100}
          cy={96}
          r={72}
          fill="#fef2f2"
          stroke="#fca5a5"
          strokeWidth={3}
        />
        {/* Button body */}
        <circle
          cx={100}
          cy={96}
          r={64}
          fill={activated ? '#991b1b' : '#dc2626'}
          stroke="#7f1d1d"
          strokeWidth={2}
        />
        {/* Shadow inset for 3D effect */}
        <circle
          cx={100}
          cy={96}
          r={60}
          fill="none"
          stroke="rgba(255,255,255,0.25)"
          strokeWidth={2}
        />
        {/* Interactive hold surface (runtime only) */}
        {!isEditing && (
          <circle
            cx={100}
            cy={96}
            r={64}
            fill="transparent"
            style={{ touchAction: 'none' }}
            onPointerDown={startHold}
            onPointerUp={stopHold}
            onPointerLeave={stopHold}
            onPointerCancel={stopHold}
          />
        )}
        {/* Label */}
        <text
          x={100}
          y={90}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={labelFontSize}
          fontWeight={800}
          fill="white"
          letterSpacing={1}
          pointerEvents="none"
        >
          {label}
        </text>
        {/* Hold hint / progress % */}
        {!isEditing && (
          <text
            x={100}
            y={110}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={statusFontSize}
            fill="rgba(255,255,255,0.85)"
            pointerEvents="none"
          >
            {holdProgress > 0 ? `HOLD ${Math.round(holdProgress * 100)}%` : `HOLD ${Math.round(holdDuration / 1000)}s`}
          </text>
        )}
        {/* Status text */}
        <text
          x={100}
          y={172}
          textAnchor="middle"
          fontSize={statusFontSize}
          fontWeight={600}
          fill={activated ? '#dc2626' : '#6b7280'}
          pointerEvents="none"
        >
          {activated ? 'ACTIVATED' : isEditing ? 'PREVIEW' : 'READY'}
        </text>
      </svg>
      {/* Persistent ISO 13850 disclaimer — always rendered, never truncated away */}
      <div
        role="note"
        style={{
          fontSize: Math.max(7, Math.min(width * 0.055, 9)),
          color: '#6b7280',
          textAlign: 'center',
          lineHeight: 1.1,
          flexShrink: 0,
        }}
      >
        {DISCLAIMER}
      </div>
    </div>
  );
};

EmergencyStopRenderer.displayName = 'EmergencyStopRenderer';
export default memo(EmergencyStopRenderer);
