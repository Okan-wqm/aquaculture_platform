import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const BallValveSymbol: React.FC<EquipmentSymbolProps> = ({
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

        {/* Ball — filled circle at center */}
        <circle
          cx={50} cy={40} r={8}
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Ball bore indicator — horizontal when open, vertical when closed */}
        {isOpen ? (
          <line
            x1={42} y1={40} x2={58} y2={40}
            stroke={colors.stroke} strokeWidth={2.5} strokeLinecap="round"
          />
        ) : (
          <line
            x1={50} y1={32} x2={50} y2={48}
            stroke={colors.stroke} strokeWidth={2.5} strokeLinecap="round"
          />
        )}

        {/* Stem — from ball up */}
        <line
          x1={50} y1={32} x2={50} y2={12}
          stroke={colors.stroke} strokeWidth={2} strokeLinecap="round"
        />

        {/* Handle — lever style, rotates with state */}
        {isOpen ? (
          // Horizontal handle = open
          <line
            x1={38} y1={12} x2={62} y2={12}
            stroke={colors.stroke} strokeWidth={3} strokeLinecap="round"
          />
        ) : (
          // Vertical handle = closed (perpendicular to flow)
          <line
            x1={50} y1={4} x2={50} y2={12}
            stroke={colors.stroke} strokeWidth={3} strokeLinecap="round"
          />
        )}

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
        points={CONNECTION_POINTS['ballValve']}
        viewBoxWidth={100}
        viewBoxHeight={80}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default BallValveSymbol;
