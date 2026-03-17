import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const FlowTransmitterSymbol: React.FC<EquipmentSymbolProps> = ({
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

        {/* Function tag line */}
        <line x1={14} y1={38} x2={66} y2={38} stroke={colors.stroke} strokeWidth={1.5} />

        {/* Top: F — measured variable (flow) */}
        <text
          x={40}
          y={34}
          textAnchor="middle"
          fontSize={14}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          F
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

        {/* Process connection line */}
        <line x1={40} y1={66} x2={40} y2={78} stroke={colors.stroke} strokeWidth={2.5} />

        {/* Flow element — orifice plate / pitot symbol */}
        <path
          d="M 20 78 L 60 78"
          stroke={colors.stroke}
          strokeWidth={3}
          strokeLinecap="round"
        />
        {/* Orifice restriction */}
        <path
          d="M 33 74 L 33 82 M 47 74 L 47 82"
          stroke={colors.stroke}
          strokeWidth={2}
          strokeLinecap="round"
        />

        {/* Process pipe connections */}
        <line x1={0} y1={78} x2={20} y2={78} stroke={colors.stroke} strokeWidth={2.5} />
        <line x1={60} y1={78} x2={80} y2={78} stroke={colors.stroke} strokeWidth={2.5} />

        {/* Signal line — top */}
        <line x1={40} y1={10} x2={40} y2={0} stroke={colors.stroke} strokeWidth={1.5} strokeDasharray="3,2" opacity={0.6} />

        {isRunning && (
          <circle cx={40} cy={38} r={4} fill={colors.stroke} fillOpacity={0.25} />
        )}

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
        points={CONNECTION_POINTS['flowTransmitter']}
        viewBoxWidth={80}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default FlowTransmitterSymbol;
