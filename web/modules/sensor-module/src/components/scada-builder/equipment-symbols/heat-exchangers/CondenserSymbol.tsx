import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const CondenserSymbol: React.FC<EquipmentSymbolProps> = ({
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
      viewBox="0 0 100 120"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 60)`}>
        {/* Main body */}
        <rect
          x={20}
          y={20}
          width={60}
          height={80}
          rx={5}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Internal serpentine/baffle cooling path */}
        <path
          d="M 30 30 L 70 30 L 70 42 L 30 42 L 30 54 L 70 54 L 70 66 L 30 66 L 30 78 L 70 78 L 70 90 L 30 90"
          fill="none"
          stroke={isRunning ? '#3b82f6' : colors.stroke}
          strokeWidth={1.5}
          opacity={isRunning ? 0.8 : 0.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Flow direction indicators on serpentine (running) */}
        {isRunning && (
          <g fill="#3b82f6" opacity={0.7}>
            {/* Arrow on top pass — right */}
            <polygon points="52,27 58,30 52,33" />
            {/* Arrow on second pass — left */}
            <polygon points="48,39 42,42 48,45" />
            {/* Arrow on third pass — right */}
            <polygon points="52,51 58,54 52,57" />
            {/* Arrow on fourth pass — left */}
            <polygon points="48,63 42,66 48,69" />
            {/* Arrow on fifth pass — right */}
            <polygon points="52,75 58,78 52,81" />
            {/* Arrow on sixth pass — left */}
            <polygon points="48,87 42,90 48,93" />
          </g>
        )}

        {/* Condensation droplets (running state) */}
        {isRunning && (
          <g fill="#93c5fd" opacity={0.5}>
            <circle cx={35} cy={36} r={1.5} />
            <circle cx={65} cy={48} r={1.5} />
            <circle cx={40} cy={60} r={1.5} />
            <circle cx={60} cy={72} r={1.5} />
            <circle cx={45} cy={84} r={1.5} />
          </g>
        )}

        {/* Nozzle — vapor-in (top) */}
        <line
          x1={50}
          y1={0}
          x2={50}
          y2={20}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="47,8 50,14 53,8" fill="#ef4444" opacity={0.8} />
        )}

        {/* Nozzle — liquid-out (bottom) */}
        <line
          x1={50}
          y1={100}
          x2={50}
          y2={120}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="47,108 50,114 53,108" fill="#3b82f6" opacity={0.8} />
        )}

        {/* Nozzle — coolant-in (left) */}
        <line
          x1={0}
          y1={40}
          x2={20}
          y2={40}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="10,37 16,40 10,43" fill="#3b82f6" opacity={0.8} />
        )}

        {/* Nozzle — coolant-out (right) */}
        <line
          x1={80}
          y1={80}
          x2={100}
          y2={80}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="88,77 94,80 88,83" fill="#60a5fa" opacity={0.8} />
        )}

        {/* P&ID label — C */}
        <text
          x={50}
          y={116}
          textAnchor="middle"
          fontSize={11}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          C
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
        points={CONNECTION_POINTS['condenser']}
        viewBoxWidth={100}
        viewBoxHeight={120}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default CondenserSymbol;
