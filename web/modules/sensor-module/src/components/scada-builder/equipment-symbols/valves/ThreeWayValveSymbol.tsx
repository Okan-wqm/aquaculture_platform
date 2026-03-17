import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const ThreeWayValveSymbol: React.FC<EquipmentSymbolProps> = ({
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
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 50)`}>
        {/* Pipe stub — left inlet */}
        <line x1={0} y1={50} x2={22} y2={50} stroke="#6b7280" strokeWidth={3} strokeLinecap="round" />

        {/* Pipe stub — right outlet */}
        <line x1={78} y1={50} x2={100} y2={50} stroke="#6b7280" strokeWidth={3} strokeLinecap="round" />

        {/* Pipe stub — bottom outlet */}
        <line x1={50} y1={78} x2={50} y2={100} stroke="#6b7280" strokeWidth={3} strokeLinecap="round" />

        {/* Bowtie body — left triangle */}
        <path
          d="M 22 32 L 50 50 L 22 68 Z"
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Bowtie body — right triangle */}
        <path
          d="M 78 32 L 50 50 L 78 68 Z"
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Third port — bottom triangle */}
        <path
          d="M 32 78 L 50 50 L 68 78 Z"
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Actuator stem — top */}
        <line x1={50} y1={22} x2={50} y2={10} stroke={colors.stroke} strokeWidth={2} />
        <line x1={43} y1={10} x2={57} y2={10} stroke={colors.stroke} strokeWidth={2.5} strokeLinecap="round" />
        <circle cx={50} cy={10} r={2} fill={colors.stroke} opacity={0.6} />

        {/* Open indicator */}
        {isOpen && (
          <circle cx={50} cy={50} r={5} fill={colors.stroke} fillOpacity={0.4} />
        )}

        {label && (
          <text x={50} y={96} textAnchor="middle" fontSize={8} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['threeWayValve']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default ThreeWayValveSymbol;
