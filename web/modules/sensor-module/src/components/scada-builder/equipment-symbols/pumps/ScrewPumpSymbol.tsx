import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const ScrewPumpSymbol: React.FC<EquipmentSymbolProps> = ({
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
        {/* Pump casing — rectangle with rounded ends */}
        <rect
          x={15}
          y={32}
          width={70}
          height={36}
          rx={18}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Screw helix — wave pattern inside casing */}
        <path
          d="M 20 50 C 25 38, 33 38, 38 50 C 43 62, 51 62, 56 50 C 61 38, 69 38, 74 50 C 79 62, 82 60, 82 52"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2}
          opacity={state === 'running' ? 1 : 0.4}
        />

        {/* Shaft line */}
        <line x1={15} y1={50} x2={85} y2={50} stroke={colors.stroke} strokeWidth={0.8} strokeDasharray="2,3" opacity={0.3} />

        {/* Inlet line — left */}
        <line x1={0} y1={50} x2={15} y2={50} stroke={colors.stroke} strokeWidth={2.5} />

        {/* Outlet line — right */}
        <line x1={85} y1={50} x2={100} y2={50} stroke={colors.stroke} strokeWidth={2.5} />

        {/* SP label */}
        <text
          x={50}
          y={92}
          textAnchor="middle"
          fontSize={10}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          SP
        </text>

        {label && (
          <text x={50} y={10} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['screwPump']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default ScrewPumpSymbol;
