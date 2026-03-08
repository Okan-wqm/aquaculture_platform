import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const ReliefValveSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];
  const isOpen = state === 'open';

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 100 80"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 40)`}>
        {/* Pipe stubs — inlet left, outlet goes upward via body */}
        <line
          x1={0} y1={40} x2={20} y2={40}
          stroke="#6b7280" strokeWidth={3} strokeLinecap="round"
        />
        <line
          x1={80} y1={40} x2={100} y2={40}
          stroke="#6b7280" strokeWidth={3} strokeLinecap="round"
        />

        {/* Bowtie body — left triangle */}
        <path
          d="M 20 25 L 50 42 L 20 60 Z"
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Bowtie body — right triangle */}
        <path
          d="M 80 25 L 50 42 L 80 60 Z"
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Spring (zigzag) — from body center upward */}
        <polyline
          points="50,35 45,31 55,27 45,23 55,19 45,15 50,12"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Pressure relief arrow — upward from spring */}
        <line
          x1={50} y1={12} x2={50} y2={3}
          stroke={colors.stroke} strokeWidth={1.5} strokeLinecap="round"
        />

        {/* Arrow head */}
        <path
          d="M 46 7 L 50 1 L 54 7"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Open indicator — spring compressed, gap visible */}
        {isOpen && (
          <g>
            {/* Discharge flow lines — small lines indicating flow upward */}
            <line
              x1={44} y1={5} x2={44} y2={1}
              stroke={colors.stroke} strokeWidth={1} opacity={0.6}
            />
            <line
              x1={56} y1={5} x2={56} y2={1}
              stroke={colors.stroke} strokeWidth={1} opacity={0.6}
            />
          </g>
        )}

        {/* Set pressure indicator — small horizontal line across spring (seat) */}
        <line
          x1={44} y1={35} x2={56} y2={35}
          stroke={colors.stroke} strokeWidth={1.5}
        />

        {/* Label */}
        {label && (
          <text
            x={50} y={75}
            textAnchor="middle" fontSize={9}
            fill="#374151" fontFamily="sans-serif"
          >
            {label}
          </text>
        )}
      </g>

      {/* Connection points */}
      <ConnectionPoints
        points={CONNECTION_POINTS['reliefValve']}
        viewBoxWidth={100}
        viewBoxHeight={80}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default ReliefValveSymbol;
