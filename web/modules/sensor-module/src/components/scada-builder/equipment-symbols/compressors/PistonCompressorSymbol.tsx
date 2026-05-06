import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const PistonCompressorSymbol: React.FC<EquipmentSymbolProps> = ({
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
      viewBox="0 0 120 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 60 50)`}>
        {/* Cylinder body */}
        <rect
          x={15}
          y={30}
          width={55}
          height={40}
          rx={3}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Cylinder head — left */}
        <rect
          x={10}
          y={27}
          width={8}
          height={46}
          rx={2}
          fill={colors.fill}
          fillOpacity={0.9}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Cylinder head — right */}
        <rect
          x={67}
          y={27}
          width={8}
          height={46}
          rx={2}
          fill={colors.fill}
          fillOpacity={0.9}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Piston inside cylinder */}
        <rect
          x={isRunning ? 35 : 28}
          y={33}
          width={12}
          height={34}
          rx={2}
          fill={colors.stroke}
          fillOpacity={0.3}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Connecting rod */}
        <line
          x1={isRunning ? 47 : 40}
          y1={50}
          x2={82}
          y2={50}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Crankshaft circle */}
        <circle
          cx={90}
          cy={50}
          r={14}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2}
        />
        <circle cx={90} cy={50} r={4} fill={colors.stroke} fillOpacity={0.7} />

        {/* Crank pin offset */}
        <circle
          cx={isRunning ? 97 : 90}
          cy={isRunning ? 43 : 36}
          r={3}
          fill={colors.stroke}
          fillOpacity={0.5}
        />

        {/* Valve ports — top */}
        <line x1={30} y1={30} x2={30} y2={18} stroke={colors.stroke} strokeWidth={2} />
        <line x1={55} y1={30} x2={55} y2={18} stroke={colors.stroke} strokeWidth={2} />
        <line x1={26} y1={18} x2={59} y2={18} stroke={colors.stroke} strokeWidth={1.5} />

        {/* Inlet line — top left */}
        <line x1={30} y1={10} x2={30} y2={18} stroke={colors.stroke} strokeWidth={2} />

        {/* Outlet line — top right */}
        <line x1={55} y1={10} x2={55} y2={18} stroke={colors.stroke} strokeWidth={2} />

        {/* PC label */}
        <text
          x={55}
          y={92}
          textAnchor="middle"
          fontSize={10}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          PC
        </text>

        {label && (
          <text x={60} y={8} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['pistonCompressor']}
        viewBoxWidth={120}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default PistonCompressorSymbol;
