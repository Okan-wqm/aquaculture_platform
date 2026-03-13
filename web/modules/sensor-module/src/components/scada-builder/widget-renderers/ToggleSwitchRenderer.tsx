/**
 * ToggleSwitchRenderer - ON/OFF switch visual with onCommand
 * Smooth animated toggle with glow effect and 3D knob
 */

import React, { memo, useCallback, useMemo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const ToggleSwitchRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing, onCommand }) => {
  const label = (config.label ?? 'Switch') as string;
  const isOn = isEditing ? (config.demoValue ?? true) : Boolean(value);

  const innerW = width - 16; // account for 8px padding
  const trackW = Math.min(innerW * 0.5, 52);
  const trackH = trackW * 0.52;
  const knobR = trackH * 0.4;

  // Knob rests at the left (OFF) or right (ON) position
  const knobOffCx = knobR + 4;
  const knobOnCx = trackW - knobR - 4;
  // We translate from the OFF position to the ON position
  const knobTranslateX = isOn ? knobOnCx - knobOffCx : 0;

  // Unique IDs for SVG defs to avoid collisions when multiple instances render
  const ids = useMemo(() => {
    const uid = Math.random().toString(36).slice(2, 8);
    return {
      knobGradient: `knob-grad-${uid}`,
      knobShadow: `knob-shadow-${uid}`,
      glowFilter: `glow-${uid}`,
    };
  }, []);

  const handleToggle = useCallback(() => {
    if (isEditing) return;
    onCommand?.('toggle', !value);
  }, [isEditing, onCommand, value]);

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
        justifyContent: 'center',
        gap: 8,
        cursor: isEditing ? 'default' : 'pointer',
      }}
      onClick={handleToggle}
    >
      {/* Extra SVG height to accommodate glow filter overflow */}
      <svg width={trackW + 8} height={trackH + 8} style={{ overflow: 'visible' }}>
        <defs>
          {/* 3D knob gradient - subtle top-light / bottom-shadow */}
          <radialGradient id={ids.knobGradient} cx="40%" cy="35%" r="60%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#e2e2e2" />
          </radialGradient>
          {/* Drop shadow for the knob */}
          <filter id={ids.knobShadow} x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.2" floodColor="#00000033" />
          </filter>
          {/* Green glow filter for the ON state */}
          <filter id={ids.glowFilter} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g transform="translate(4, 4)">
          {/* Track background - color transitions smoothly via CSS */}
          <rect
            x={0} y={0}
            width={trackW} height={trackH}
            rx={trackH / 2}
            fill={isOn ? '#22c55e' : '#d1d5db'}
            style={{ transition: 'fill 200ms ease-in-out' }}
            filter={isOn ? `url(#${ids.glowFilter})` : undefined}
          />

          {/* Knob group - slides via translateX with CSS transition */}
          <g
            style={{
              transform: `translateX(${knobTranslateX}px)`,
              transition: 'transform 200ms ease-in-out',
            }}
          >
            {/* Main knob circle with gradient + shadow */}
            <circle
              cx={knobOffCx}
              cy={trackH / 2}
              r={knobR}
              fill={`url(#${ids.knobGradient})`}
              filter={`url(#${ids.knobShadow})`}
            />
            {/* Subtle grip line on the knob for texture */}
            <line
              x1={knobOffCx}
              y1={trackH / 2 - knobR * 0.3}
              x2={knobOffCx}
              y2={trackH / 2 + knobR * 0.3}
              stroke="#c0c0c0"
              strokeWidth={1}
              strokeLinecap="round"
            />
          </g>
        </g>
      </svg>

      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: isOn ? '#16a34a' : '#6b7280',
          transition: 'color 200ms ease-in-out',
        }}
      >
        {isOn ? 'ON' : 'OFF'}
      </span>
      <span style={{ fontSize: 10, color: '#9ca3af' }}>{label}</span>
    </div>
  );
};

ToggleSwitchRenderer.displayName = 'ToggleSwitchRenderer';
export default memo(ToggleSwitchRenderer);
