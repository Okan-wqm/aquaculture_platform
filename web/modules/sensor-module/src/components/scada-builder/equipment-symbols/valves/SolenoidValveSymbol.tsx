import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const SolenoidValveSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];
  const isOpen = state === 'open';
  const isClosed = state === 'closed';

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
          d="M 20 22 L 50 40 L 20 58 Z"
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Bowtie body — right triangle */}
        <path
          d="M 80 22 L 50 40 L 80 58 Z"
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Stem — from body center up to solenoid coil */}
        <line
          x1={50} y1={22} x2={50} y2={18}
          stroke={colors.stroke} strokeWidth={2} strokeLinecap="round"
        />

        {/* Solenoid coil housing — rectangle */}
        <rect
          x={38} y={0} width={24} height={18} rx={2}
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Coil zigzag winding inside housing */}
        <polyline
          points="42,5 46,3 46,7 50,5 50,9 54,7 54,11 58,9"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={1.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Electrical terminals — two small lines from top of coil */}
        <line
          x1={44} y1={0} x2={44} y2={-4}
          stroke={colors.stroke} strokeWidth={1.5} strokeLinecap="round"
        />
        <line
          x1={56} y1={0} x2={56} y2={-4}
          stroke={colors.stroke} strokeWidth={1.5} strokeLinecap="round"
        />

        {/* Terminal dots */}
        <circle cx={44} cy={-4} r={1.5} fill={colors.stroke} />
        <circle cx={56} cy={-4} r={1.5} fill={colors.stroke} />

        {/* Lightning bolt symbol — small electricity indicator */}
        {isOpen && (
          <path
            d="M 48 12 L 50 9 L 52 12 L 50 15 Z"
            fill={colors.stroke}
            fillOpacity={0.6}
          />
        )}

        {/* Closed indicator — gate across flow */}
        {isClosed && (
          <line
            x1={50} y1={30} x2={50} y2={50}
            stroke={colors.stroke} strokeWidth={2.5} strokeLinecap="round"
            opacity={0.6}
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
        points={CONNECTION_POINTS['solenoidValve']}
        viewBoxWidth={100}
        viewBoxHeight={80}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default SolenoidValveSymbol;
