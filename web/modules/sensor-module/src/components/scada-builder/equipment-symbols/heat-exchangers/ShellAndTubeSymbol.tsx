import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const ShellAndTubeSymbol: React.FC<EquipmentSymbolProps> = ({
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
      viewBox="0 0 140 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 70 50)`}>
        {/* Shell (outer body) */}
        <rect
          x={20}
          y={20}
          width={100}
          height={60}
          rx={3}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Left tube sheet */}
        <line
          x1={35}
          y1={20}
          x2={35}
          y2={80}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Right tube sheet */}
        <line
          x1={105}
          y1={20}
          x2={105}
          y2={80}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Inner tubes — dashed lines */}
        <line
          x1={35}
          y1={35}
          x2={105}
          y2={35}
          stroke={isRunning ? '#ef4444' : colors.stroke}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          opacity={isRunning ? 0.8 : 0.5}
        />
        <line
          x1={35}
          y1={50}
          x2={105}
          y2={50}
          stroke={isRunning ? '#ef4444' : colors.stroke}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          opacity={isRunning ? 0.8 : 0.5}
        />
        <line
          x1={35}
          y1={65}
          x2={105}
          y2={65}
          stroke={isRunning ? '#ef4444' : colors.stroke}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          opacity={isRunning ? 0.8 : 0.5}
        />

        {/* Running state: flow direction arrows on tubes */}
        {isRunning && (
          <g fill="#ef4444" opacity={0.9}>
            {/* Arrows on tube y=35 */}
            <polygon points="60,32 66,35 60,38" />
            <polygon points="82,32 88,35 82,38" />
            {/* Arrows on tube y=50 */}
            <polygon points="60,47 66,50 60,53" />
            <polygon points="82,47 88,50 82,53" />
            {/* Arrows on tube y=65 */}
            <polygon points="60,62 66,65 60,68" />
            <polygon points="82,62 88,65 82,68" />
          </g>
        )}

        {/* Shell-side flow indicators (running) */}
        {isRunning && (
          <g stroke="#3b82f6" strokeWidth={1} fill="none" opacity={0.6}>
            <path d="M 25 40 Q 30 42 25 45 Q 20 48 25 50" />
            <path d="M 110 55 Q 115 57 110 60 Q 105 63 110 65" />
          </g>
        )}

        {/* Nozzle — hot-in (left-top) */}
        <line
          x1={0}
          y1={30}
          x2={20}
          y2={30}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="12,27 18,30 12,33" fill="#ef4444" opacity={0.8} />
        )}

        {/* Nozzle — hot-out (right-top) */}
        <line
          x1={120}
          y1={30}
          x2={140}
          y2={30}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="128,27 134,30 128,33" fill="#ef4444" opacity={0.8} />
        )}

        {/* Nozzle — cold-in (left-bottom) */}
        <line
          x1={0}
          y1={70}
          x2={20}
          y2={70}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="12,67 18,70 12,73" fill="#3b82f6" opacity={0.8} />
        )}

        {/* Nozzle — cold-out (right-bottom) */}
        <line
          x1={120}
          y1={70}
          x2={140}
          y2={70}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="128,67 134,70 128,73" fill="#3b82f6" opacity={0.8} />
        )}

        {/* P&ID label — E (exchanger) */}
        <text
          x={70}
          y={96}
          textAnchor="middle"
          fontSize={11}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          E
        </text>

        {/* Label */}
        {label && (
          <text
            x={70}
            y={14}
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
        points={CONNECTION_POINTS['shellAndTube']}
        viewBoxWidth={140}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default ShellAndTubeSymbol;
