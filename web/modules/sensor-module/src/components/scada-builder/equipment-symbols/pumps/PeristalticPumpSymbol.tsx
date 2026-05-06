import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const PeristalticPumpSymbol: React.FC<EquipmentSymbolProps> = ({
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
        {/* Outer casing circle */}
        <circle
          cx={50}
          cy={50}
          r={30}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Rotor disc */}
        <circle
          cx={50}
          cy={50}
          r={16}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={1.5}
          opacity={0.5}
        />

        {/* Roller 1 — top-right position */}
        <circle
          cx={60}
          cy={38}
          r={6}
          fill={colors.fill}
          stroke={colors.stroke}
          strokeWidth={2}
        />
        <circle cx={60} cy={38} r={2} fill={colors.stroke} opacity={0.6} />

        {/* Roller 2 — bottom-right position */}
        <circle
          cx={60}
          cy={62}
          r={6}
          fill={colors.fill}
          stroke={colors.stroke}
          strokeWidth={2}
        />
        <circle cx={60} cy={62} r={2} fill={colors.stroke} opacity={0.6} />

        {/* Hose tube arc — right side */}
        <path
          d="M 50 20 A 30 30 0 0 1 80 50 A 30 30 0 0 1 50 80"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={4}
          opacity={state === 'running' ? 0.8 : 0.3}
        />

        {/* Center shaft */}
        <circle cx={50} cy={50} r={4} fill={colors.stroke} fillOpacity={0.7} />

        {/* Inlet line — left */}
        <line x1={0} y1={50} x2={20} y2={50} stroke={colors.stroke} strokeWidth={2.5} />

        {/* Outlet line — right */}
        <line x1={80} y1={50} x2={100} y2={50} stroke={colors.stroke} strokeWidth={2.5} />

        {/* PP label */}
        <text
          x={50}
          y={93}
          textAnchor="middle"
          fontSize={10}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          PP
        </text>

        {label && (
          <text x={50} y={10} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['peristalticPump']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default PeristalticPumpSymbol;
