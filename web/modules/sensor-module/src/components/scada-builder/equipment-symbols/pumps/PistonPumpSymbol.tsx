import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const PistonPumpSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];

  // Piston position changes based on state
  const pistonX = state === 'running' ? 55 : 45;

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 50)`}>
        {/* Outer cylinder */}
        <rect
          x={15}
          y={25}
          width={70}
          height={50}
          rx={3}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Cylinder bore — inner area */}
        <rect
          x={20}
          y={30}
          width={60}
          height={40}
          rx={2}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={1}
          strokeDasharray="4,3"
          opacity={0.3}
        />

        {/* Piston head */}
        <rect
          x={pistonX}
          y={30}
          width={8}
          height={40}
          rx={1}
          fill={colors.stroke}
          fillOpacity={0.5}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Piston rod — extends upward from piston */}
        <line
          x1={pistonX + 4}
          y1={15}
          x2={pistonX + 4}
          y2={30}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinecap="round"
        />

        {/* Crosshead / crank connection — small circle at top of rod */}
        <circle
          cx={pistonX + 4}
          cy={14}
          r={3}
          fill={colors.stroke}
          fillOpacity={0.4}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Inlet check valve — left side */}
        <polygon
          points="18,45 26,50 18,55"
          fill={colors.stroke}
          fillOpacity={0.6}
        />

        {/* Outlet check valve — right side */}
        <polygon
          points="82,45 74,50 82,55"
          fill={colors.stroke}
          fillOpacity={0.6}
        />

        {/* Inlet line — left */}
        <line
          x1={0}
          y1={50}
          x2={15}
          y2={50}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Outlet line — right */}
        <line
          x1={85}
          y1={50}
          x2={100}
          y2={50}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Compression area shading (running state) */}
        {state === 'running' && (
          <rect
            x={pistonX + 8}
            y={32}
            width={80 - (pistonX + 8) - 2}
            height={36}
            fill={colors.stroke}
            fillOpacity={0.06}
            rx={1}
          />
        )}

        {/* P label */}
        <text
          x={50}
          y={95}
          textAnchor="middle"
          fontSize={11}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          P
        </text>

        {/* Label */}
        {label && (
          <text
            x={50}
            y={10}
            textAnchor="middle"
            fontSize={9}
            fill="#374151"
            fontFamily="sans-serif"
          >
            {label}
          </text>
        )}
      </g>

      {/* Connection points */}
      <ConnectionPoints
        points={CONNECTION_POINTS['pistonPump']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default PistonPumpSymbol;
