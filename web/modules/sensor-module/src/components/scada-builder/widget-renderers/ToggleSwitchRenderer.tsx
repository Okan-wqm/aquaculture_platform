/**
 * ToggleSwitchRenderer - ON/OFF switch visual
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const ToggleSwitchRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const label = config.label ?? 'Switch';
  const isOn = isEditing ? (config.demoValue ?? true) : Boolean(value);

  const trackW = Math.min(width * 0.45, 52);
  const trackH = trackW * 0.52;
  const knobR = trackH * 0.4;
  const knobCx = isOn ? trackW - knobR - 4 : knobR + 4;

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
      }}
    >
      <svg width={trackW} height={trackH}>
        <rect
          x={0} y={0}
          width={trackW} height={trackH}
          rx={trackH / 2}
          fill={isOn ? '#22c55e' : '#d1d5db'}
        />
        <circle cx={knobCx} cy={trackH / 2} r={knobR} fill="white" />
      </svg>
      <span style={{ fontSize: 10, fontWeight: 600, color: isOn ? '#16a34a' : '#6b7280' }}>
        {isOn ? 'ON' : 'OFF'}
      </span>
      <span style={{ fontSize: 10, color: '#9ca3af' }}>{label}</span>
    </div>
  );
};

ToggleSwitchRenderer.displayName = 'ToggleSwitchRenderer';
export default memo(ToggleSwitchRenderer);
