/**
 * ToggleSwitchRenderer - ON/OFF switch visual with onCommand
 */

import React, { memo, useCallback } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const ToggleSwitchRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing, onCommand }) => {
  const label = config.label ?? 'Switch';
  const isOn = isEditing ? (config.demoValue ?? true) : Boolean(value);

  const innerW = width - 16; // account for 8px padding
  const trackW = Math.min(innerW * 0.5, 52);
  const trackH = trackW * 0.52;
  const knobR = trackH * 0.4;
  const knobCx = isOn ? trackW - knobR - 4 : knobR + 4;

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
