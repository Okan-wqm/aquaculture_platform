import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const PressureTransmitterSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];
  const isRunning = state === 'running';

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 80 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 40 50)`}>
        {/* ISA-5.1 instrument circle */}
        <circle
          cx={40}
          cy={38}
          r={28}
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Function tag line — divides top (measured variable) from bottom (function) */}
        <line x1={14} y1={38} x2={66} y2={38} stroke={colors.stroke} strokeWidth={1.5} />

        {/* Top: P — measured variable (pressure) */}
        <text
          x={40}
          y={34}
          textAnchor="middle"
          fontSize={14}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          P
        </text>

        {/* Bottom: T — transmitter function */}
        <text
          x={40}
          y={52}
          textAnchor="middle"
          fontSize={14}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          T
        </text>

        {/* Process connection — bottom line to process */}
        <line x1={40} y1={66} x2={40} y2={80} stroke={colors.stroke} strokeWidth={2.5} />

        {/* Sensing element — diaphragm symbol at bottom */}
        <ellipse
          cx={40}
          cy={82}
          rx={12}
          ry={5}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Signal line — top (4-20mA output) */}
        <line x1={40} y1={10} x2={40} y2={0} stroke={colors.stroke} strokeWidth={1.5} strokeDasharray="3,2" opacity={0.6} />

        {/* Running indicator */}
        {isRunning && (
          <circle cx={40} cy={38} r={4} fill={colors.stroke} fillOpacity={0.25} />
        )}

        {/* Fault indicator */}
        {state === 'fault' && (
          <text x={40} y={42} textAnchor="middle" fontSize={10} fill="#ef4444" fontFamily="sans-serif" fontWeight="bold">!</text>
        )}

        {label && (
          <text x={40} y={97} textAnchor="middle" fontSize={8} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['pressureTransmitter']}
        viewBoxWidth={80}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default PressureTransmitterSymbol;
