import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const VerticalTankSymbol: React.FC<EquipmentSymbolProps> = ({
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
      viewBox="0 0 100 140"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 70)`}>
        {/* Tank body */}
        <rect
          x={20}
          y={25}
          width={60}
          height={90}
          rx={3}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Dome top cap */}
        <path
          d="M 20 25 Q 50 5 80 25"
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Flat bottom line */}
        <line
          x1={20}
          y1={115}
          x2={80}
          y2={115}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Liquid level indicator (running state) */}
        {state === 'running' && (
          <g>
            {/* Liquid fill — 60% full */}
            <rect
              x={21.5}
              y={65}
              width={57}
              height={49}
              rx={2}
              fill="#93c5fd"
              fillOpacity={0.4}
            />
            {/* Liquid surface wave */}
            <path
              d="M 22 65 Q 35 61 50 65 Q 65 69 78 65"
              fill="none"
              stroke="#60a5fa"
              strokeWidth={1}
              opacity={0.7}
            />
          </g>
        )}

        {/* Nozzle — top inlet */}
        <line
          x1={50}
          y1={0}
          x2={50}
          y2={12}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />
        <line
          x1={44}
          y1={12}
          x2={56}
          y2={12}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Nozzle — bottom outlet */}
        <line
          x1={50}
          y1={115}
          x2={50}
          y2={130}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />
        <line
          x1={44}
          y1={130}
          x2={56}
          y2={130}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Nozzle — left level connection */}
        <line
          x1={0}
          y1={70}
          x2={20}
          y2={70}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />
        <line
          x1={0}
          y1={67}
          x2={0}
          y2={73}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Nozzle — right drain */}
        <line
          x1={80}
          y1={97}
          x2={100}
          y2={97}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />
        <line
          x1={100}
          y1={94}
          x2={100}
          y2={100}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Support legs */}
        <rect x={25} y={115} width={5} height={10} fill={colors.stroke} fillOpacity={0.5} rx={1} />
        <rect x={70} y={115} width={5} height={10} fill={colors.stroke} fillOpacity={0.5} rx={1} />

        {/* Label */}
        {label && (
          <text
            x={50}
            y={137}
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
        points={CONNECTION_POINTS['verticalTank']}
        viewBoxWidth={100}
        viewBoxHeight={140}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default VerticalTankSymbol;
