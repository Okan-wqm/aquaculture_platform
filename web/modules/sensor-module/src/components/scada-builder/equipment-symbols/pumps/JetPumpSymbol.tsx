import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const JetPumpSymbol: React.FC<EquipmentSymbolProps> = ({
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
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 50)`}>
        {/* Converging nozzle section */}
        <path
          d="M 5 35 L 5 65 L 40 55 L 40 45 Z"
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Throat / mixing chamber */}
        <rect
          x={40}
          y={44}
          width={20}
          height={12}
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Diffuser / diverging section */}
        <path
          d="M 60 44 L 60 56 L 95 65 L 95 35 Z"
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Motive fluid inlet — left main */}
        <line x1={0} y1={50} x2={5} y2={50} stroke={colors.stroke} strokeWidth={3} />

        {/* Suction inlet — top */}
        <line x1={50} y1={0} x2={50} y2={44} stroke={colors.stroke} strokeWidth={2.5} />
        {/* Suction flange tick */}
        <line x1={44} y1={5} x2={56} y2={5} stroke={colors.stroke} strokeWidth={1.5} />

        {/* Discharge line — right */}
        <line x1={95} y1={50} x2={100} y2={50} stroke={colors.stroke} strokeWidth={3} />

        {/* Flow arrows inside (running state) */}
        {state === 'running' && (
          <g fill={colors.stroke} opacity={0.5}>
            <polygon points="47,51 44,48 44,54" />
            <polygon points="55,51 52,48 52,54" />
          </g>
        )}

        {/* JP label */}
        <text
          x={50}
          y={93}
          textAnchor="middle"
          fontSize={10}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          JP
        </text>

        {label && (
          <text x={50} y={10} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['jetPump']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default JetPumpSymbol;
