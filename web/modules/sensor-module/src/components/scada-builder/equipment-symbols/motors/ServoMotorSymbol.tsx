import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const ServoMotorSymbol: React.FC<EquipmentSymbolProps> = ({
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
        {/* Motor body */}
        <circle
          cx={50}
          cy={50}
          r={30}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* SM label */}
        <text
          x={50}
          y={46}
          textAnchor="middle"
          fontSize={18}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          SM
        </text>

        {/* Servo label */}
        <text
          x={50}
          y={60}
          textAnchor="middle"
          fontSize={8}
          fill={colors.stroke}
          fontFamily="sans-serif"
          opacity={0.7}
        >
          servo
        </text>

        {/* Encoder housing — attached on back */}
        <rect
          x={84}
          y={35}
          width={22}
          height={30}
          rx={3}
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Encoder disc */}
        <circle
          cx={95}
          cy={50}
          r={8}
          fill={colors.fill}
          fillOpacity={0.5}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Encoder pulse lines */}
        {isRunning ? (
          <g stroke={colors.stroke} strokeWidth={1} opacity={0.6}>
            <line x1={89} y1={50} x2={101} y2={50} />
            <line x1={95} y1={44} x2={95} y2={56} />
            <line x1={90} y1={45} x2={100} y2={55} />
          </g>
        ) : (
          <circle cx={95} cy={50} r={2} fill={colors.stroke} fillOpacity={0.4} />
        )}

        {/* Shaft — right of encoder */}
        <line x1={106} y1={50} x2={120} y2={50} stroke={colors.stroke} strokeWidth={3} strokeLinecap="round" />

        {/* Feedback cable — dotted line from encoder upward */}
        <path
          d="M 95 35 L 95 18 L 50 18"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={1.2}
          strokeDasharray="3,2"
          opacity={0.5}
        />
        <circle cx={50} cy={18} r={2.5} fill={colors.stroke} fillOpacity={0.5} />

        {label && (
          <text x={60} y={10} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['servoMotor']}
        viewBoxWidth={120}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default ServoMotorSymbol;
