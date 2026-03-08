import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const GateValveSymbol: React.FC<EquipmentSymbolProps> = ({
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

  // Stem position: open = stem raised, closed = stem pushed down
  const stemTopY = isOpen ? 2 : 10;
  const stemBottomY = 20;
  const handwheelY = stemTopY;

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 100 80"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 40)`}>
        {/* Pipe stubs — inlet (left) and outlet (right) */}
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

        {/* Stem — vertical line from handwheel down to body */}
        <line
          x1={50} y1={stemBottomY} x2={50} y2={stemTopY}
          stroke={colors.stroke} strokeWidth={2} strokeLinecap="round"
        />

        {/* Handwheel — horizontal bar at top of stem */}
        <line
          x1={40} y1={handwheelY} x2={60} y2={handwheelY}
          stroke={colors.stroke} strokeWidth={2.5} strokeLinecap="round"
        />

        {/* Handwheel center knob */}
        <circle
          cx={50} cy={handwheelY} r={2.5}
          fill={colors.stroke} fillOpacity={0.6}
        />

        {/* Closed indicator — gate plate across flow path */}
        {isClosed && (
          <line
            x1={50} y1={28} x2={50} y2={52}
            stroke={colors.stroke} strokeWidth={3} strokeLinecap="round"
            opacity={0.7}
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
        points={CONNECTION_POINTS['gateValve']}
        viewBoxWidth={100}
        viewBoxHeight={80}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default GateValveSymbol;
