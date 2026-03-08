import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const ButterflyValveSymbol: React.FC<EquipmentSymbolProps> = ({
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
        {/* Pipe stubs */}
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
          d="M 20 20 L 50 40 L 20 60 Z"
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Bowtie body — right triangle */}
        <path
          d="M 80 20 L 50 40 L 80 60 Z"
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Stem — from body center upward */}
        <line
          x1={50} y1={20} x2={50} y2={8}
          stroke={colors.stroke} strokeWidth={2} strokeLinecap="round"
        />

        {/* Stem cap */}
        <circle
          cx={50} cy={6} r={3}
          fill={colors.stroke} fillOpacity={0.5}
          stroke={colors.stroke} strokeWidth={1.5}
        />

        {/* Butterfly disk — rotates between open/closed */}
        {isOpen ? (
          // Horizontal thin line = disk fully open (parallel to flow)
          <line
            x1={40} y1={40} x2={60} y2={40}
            stroke={colors.stroke} strokeWidth={2} strokeLinecap="round"
          />
        ) : (
          // Vertical thick line = disk fully closed (perpendicular to flow)
          <line
            x1={50} y1={25} x2={50} y2={55}
            stroke={colors.stroke} strokeWidth={3.5} strokeLinecap="round"
          />
        )}

        {/* Disk pivot point */}
        <circle
          cx={50} cy={40} r={2.5}
          fill={colors.stroke} fillOpacity={0.7}
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
        points={CONNECTION_POINTS['butterflyValve']}
        viewBoxWidth={100}
        viewBoxHeight={80}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default ButterflyValveSymbol;
