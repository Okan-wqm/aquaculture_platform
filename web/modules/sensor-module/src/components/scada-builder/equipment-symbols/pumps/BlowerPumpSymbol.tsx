import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const BlowerPumpSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 50)`}>
        {/* Blower casing — volute/scroll shape */}
        <circle
          cx={45}
          cy={50}
          r={28}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Fan blades — forward-curved */}
        {state === 'running' ? (
          <g stroke={colors.stroke} strokeWidth={2} fill="none">
            <path d="M 45 26 C 58 28, 65 38, 62 50" />
            <path d="M 62 50 C 64 62, 56 72, 45 74" />
            <path d="M 45 74 C 32 72, 24 62, 22 50" />
            <path d="M 22 50 C 20 38, 28 28, 45 26" />
          </g>
        ) : (
          <g stroke={colors.stroke} strokeWidth={1.5} fill="none" opacity={0.4}>
            <line x1={45} y1={26} x2={45} y2={50} />
            <line x1={67} y1={39} x2={45} y2={50} />
            <line x1={67} y1={61} x2={45} y2={50} />
            <line x1={45} y1={74} x2={45} y2={50} />
          </g>
        )}

        {/* Center hub */}
        <circle cx={45} cy={50} r={5} fill={colors.stroke} fillOpacity={0.6} />

        {/* Discharge volute scroll (discharge nozzle going right/up) */}
        <path
          d="M 73 50 L 85 50 L 85 35 L 100 35"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Inlet line — left */}
        <line x1={0} y1={50} x2={17} y2={50} stroke={colors.stroke} strokeWidth={2.5} />

        {/* BL label */}
        <text
          x={45}
          y={93}
          textAnchor="middle"
          fontSize={10}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          BL
        </text>

        {label && (
          <text x={50} y={10} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['blowerPump']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default BlowerPumpSymbol;
