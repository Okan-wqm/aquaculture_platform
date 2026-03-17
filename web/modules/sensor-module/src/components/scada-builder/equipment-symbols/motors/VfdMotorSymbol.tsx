import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const VfdMotorSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];
  const isRunning = state === 'running';

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 120 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 60 50)`}>
        {/* VFD drive box — left rectangle */}
        <rect
          x={5}
          y={20}
          width={38}
          height={60}
          rx={4}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* VFD label */}
        <text
          x={24}
          y={46}
          textAnchor="middle"
          fontSize={9}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          VFD
        </text>

        {/* Frequency indicator — stepped waveform */}
        <path
          d="M 10 55 L 14 55 L 14 50 L 18 50 L 18 55 L 22 55 L 22 50 L 26 50 L 26 55 L 30 55 L 30 50 L 34 50 L 34 55 L 38 55"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={1.2}
          opacity={isRunning ? 0.9 : 0.3}
        />

        {/* Connection cable between VFD and motor */}
        <line x1={43} y1={50} x2={55} y2={50} stroke={colors.stroke} strokeWidth={2} strokeDasharray="3,2" />

        {/* Motor body — circle */}
        <circle
          cx={75}
          cy={50}
          r={30}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* M label */}
        <text
          x={75}
          y={46}
          textAnchor="middle"
          fontSize={20}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          M
        </text>

        {/* Hz indicator on motor */}
        <text
          x={75}
          y={60}
          textAnchor="middle"
          fontSize={9}
          fill={colors.stroke}
          fontFamily="sans-serif"
          opacity={0.7}
        >
          Hz
        </text>

        {/* Shaft */}
        <line x1={105} y1={50} x2={120} y2={50} stroke={colors.stroke} strokeWidth={3} strokeLinecap="round" />

        {label && (
          <text x={60} y={10} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['vfdMotor']}
        viewBoxWidth={120}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default VfdMotorSymbol;
