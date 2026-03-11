/**
 * EmergencyStopRenderer - Large red E-STOP button with confirmation dialog
 */

import React, { memo, useCallback } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const EmergencyStopRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing, onCommand }) => {
  const label = (config.label ?? 'E-STOP') as string;
  const activated = isEditing ? false : Boolean(value);

  const handleEmergencyStop = useCallback(() => {
    if (isEditing) return;
    const confirmed = window.confirm('ACIL DURDURMA aktive edilecek. Emin misiniz?');
    if (confirmed && onCommand) {
      onCommand('emergencyStop', true);
    }
  }, [isEditing, onCommand]);

  const h = height - 16; // account for padding
  const labelFontSize = Math.min(h * 0.14, 22);
  const statusFontSize = Math.min(h * 0.08, 12);

  return (
    <div style={{ width, height, padding: 8, boxSizing: 'border-box' }}>
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 200 200"
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block', cursor: isEditing ? 'default' : 'pointer' }}
      onClick={handleEmergencyStop}
      role="button"
      aria-label="Emergency Stop"
    >
      {/* Pulse animation for runtime */}
      {!isEditing && activated && (
        <circle cx={100} cy={96} r={80} fill="none" stroke="#ef4444" strokeWidth={2} opacity={0.6}>
          <animate attributeName="r" from="72" to="90" dur="1s" repeatCount="indefinite" />
          <animate attributeName="opacity" from="0.6" to="0" dur="1s" repeatCount="indefinite" />
        </circle>
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
      {/* Label */}
      <text
        x={100}
        y={96}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={labelFontSize}
        fontWeight={800}
        fill="white"
        letterSpacing={1}
      >
        {label}
      </text>
      {/* Status text */}
      <text
        x={100}
        y={180}
        textAnchor="middle"
        fontSize={statusFontSize}
        fontWeight={600}
        fill={activated ? '#dc2626' : '#6b7280'}
      >
        {activated ? 'ACTIVATED' : 'READY'}
      </text>
    </svg>
    </div>
  );
};

EmergencyStopRenderer.displayName = 'EmergencyStopRenderer';
export default memo(EmergencyStopRenderer);
