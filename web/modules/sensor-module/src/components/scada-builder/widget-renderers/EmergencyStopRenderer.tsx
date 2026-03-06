/**
 * EmergencyStopRenderer - Large red E-STOP button
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const EmergencyStopRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const label = config.label ?? 'E-STOP';
  const activated = isEditing ? false : Boolean(value);
  const btnR = Math.min(width, height) * 0.32;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block' }}
    >
      {/* Outer ring */}
      <circle
        cx={width / 2}
        cy={height / 2 - 4}
        r={btnR + 8}
        fill="#fef2f2"
        stroke="#fca5a5"
        strokeWidth={3}
      />
      {/* Button body */}
      <circle
        cx={width / 2}
        cy={height / 2 - 4}
        r={btnR}
        fill={activated ? '#991b1b' : '#dc2626'}
        stroke="#7f1d1d"
        strokeWidth={2}
      />
      {/* Shadow inset for 3D effect */}
      <circle
        cx={width / 2}
        cy={height / 2 - 4}
        r={btnR - 4}
        fill="none"
        stroke="rgba(255,255,255,0.25)"
        strokeWidth={2}
      />
      {/* Label */}
      <text
        x={width / 2}
        y={height / 2 - 4}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={Math.max(10, btnR * 0.35)}
        fontWeight={800}
        fill="white"
        letterSpacing={1}
      >
        {label}
      </text>
      {/* Status text */}
      <text
        x={width / 2}
        y={height / 2 + btnR + 18}
        textAnchor="middle"
        fontSize={10}
        fontWeight={600}
        fill={activated ? '#dc2626' : '#6b7280'}
      >
        {activated ? 'ACTIVATED' : 'READY'}
      </text>
    </svg>
  );
};

EmergencyStopRenderer.displayName = 'EmergencyStopRenderer';
export default memo(EmergencyStopRenderer);
