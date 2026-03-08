import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const ControlValveSymbol: React.FC<EquipmentSymbolProps> = ({
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

        {/* Stem — from body center up to actuator */}
        <line
          x1={50} y1={22} x2={50} y2={17}
          stroke={colors.stroke} strokeWidth={2} strokeLinecap="round"
        />

        {/* Control actuator — rectangular box */}
        <rect
          x={38} y={2} width={24} height={15} rx={2}
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Actuator label */}
        <text
          x={50} y={13}
          textAnchor="middle" fontSize={8}
          fontWeight="bold"
          fill={colors.stroke} fontFamily="sans-serif"
        >
          CV
        </text>

        {/* Position indicator at center — shows throttle position */}
        {isClosed && (
          <line
            x1={50} y1={30} x2={50} y2={50}
            stroke={colors.stroke} strokeWidth={2.5} strokeLinecap="round"
            opacity={0.6}
          />
        )}

        {isOpen && (
          <g opacity={0.5}>
            {/* Flow-through indicator lines */}
            <line
              x1={35} y1={38} x2={42} y2={40}
              stroke={colors.stroke} strokeWidth={1}
            />
            <line
              x1={58} y1={40} x2={65} y2={38}
              stroke={colors.stroke} strokeWidth={1}
            />
          </g>
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
        points={CONNECTION_POINTS['controlValve']}
        viewBoxWidth={100}
        viewBoxHeight={80}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default ControlValveSymbol;
