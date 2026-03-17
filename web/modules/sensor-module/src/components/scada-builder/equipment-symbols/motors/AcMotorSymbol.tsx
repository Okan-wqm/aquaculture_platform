import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const AcMotorSymbol: React.FC<EquipmentSymbolProps> = ({
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
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 50)`}>
        {/* Motor body — ISA circle symbol */}
        <circle
          cx={50}
          cy={50}
          r={32}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* M label — standard motor designation */}
        <text
          x={50}
          y={46}
          textAnchor="middle"
          fontSize={22}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          M
        </text>

        {/* AC tilde symbol */}
        <path
          d="M 38 56 Q 42 50, 46 56 Q 50 62, 54 56 Q 58 50, 62 56"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={1.8}
          opacity={0.8}
        />

        {/* Shaft — right side */}
        <line x1={82} y1={50} x2={100} y2={50} stroke={colors.stroke} strokeWidth={3} strokeLinecap="round" />

        {/* Stator winding indicators — small arcs around motor rim */}
        {isRunning && (
          <g stroke={colors.stroke} strokeWidth={1.2} fill="none" opacity={0.4}>
            <path d="M 50 18 A 32 32 0 0 1 82 50" />
            <path d="M 18 50 A 32 32 0 0 1 50 82" />
          </g>
        )}

        {/* Terminal box indicator */}
        <rect
          x={33}
          y={78}
          width={34}
          height={8}
          rx={2}
          fill={colors.fill}
          fillOpacity={0.9}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {label && (
          <text x={50} y={10} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['acMotor']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default AcMotorSymbol;
