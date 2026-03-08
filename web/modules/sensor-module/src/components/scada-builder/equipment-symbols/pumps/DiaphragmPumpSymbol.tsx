import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const DiaphragmPumpSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];

  // Diaphragm path varies slightly based on state to indicate motion
  const diaphragmPath =
    state === 'running'
      ? 'M 20 50 C 30 32, 40 68, 50 50 C 60 32, 70 68, 80 50'
      : 'M 20 50 C 30 42, 40 58, 50 50 C 60 42, 70 58, 80 50';

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 50)`}>
        {/* Pump body — circle */}
        <circle
          cx={50}
          cy={50}
          r={30}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Diaphragm membrane — wavy line through center */}
        <path
          d={diaphragmPath}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2}
          strokeLinecap="round"
        />

        {/* Upper chamber fill hint */}
        <path
          d={`${diaphragmPath} L 80 50 A 30 30 0 0 0 20 50 Z`}
          fill={colors.stroke}
          fillOpacity={0.08}
        />

        {/* Check valve indicators — small triangles at inlet/outlet */}
        {/* Inlet check valve (left) */}
        <polygon
          points="22,44 28,47 22,50"
          fill={colors.stroke}
          fillOpacity={0.5}
        />
        {/* Outlet check valve (right) */}
        <polygon
          points="78,44 72,47 78,50"
          fill={colors.stroke}
          fillOpacity={0.5}
        />

        {/* Inlet line — left */}
        <line
          x1={0}
          y1={50}
          x2={20}
          y2={50}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Outlet line — right */}
        <line
          x1={80}
          y1={50}
          x2={100}
          y2={50}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

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
        points={CONNECTION_POINTS['diaphragmPump']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default DiaphragmPumpSymbol;
