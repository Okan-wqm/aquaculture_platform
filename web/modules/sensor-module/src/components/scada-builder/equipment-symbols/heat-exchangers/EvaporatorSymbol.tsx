import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const EvaporatorSymbol: React.FC<EquipmentSymbolProps> = ({
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

        {/* Internal heating coils — 3 wavy vertical lines */}
        <path
          d="M 35 30 S 30 42 35 54 S 40 66 35 78 S 30 90 35 95"
          fill="none"
          stroke={isRunning ? '#ef4444' : colors.stroke}
          strokeWidth={1.5}
          opacity={isRunning ? 0.8 : 0.4}
          strokeLinecap="round"
        />
        <path
          d="M 50 30 S 45 42 50 54 S 55 66 50 78 S 45 90 50 95"
          fill="none"
          stroke={isRunning ? '#ef4444' : colors.stroke}
          strokeWidth={1.5}
          opacity={isRunning ? 0.8 : 0.4}
          strokeLinecap="round"
        />
        <path
          d="M 65 30 S 60 42 65 54 S 70 66 65 78 S 60 90 65 95"
          fill="none"
          stroke={isRunning ? '#ef4444' : colors.stroke}
          strokeWidth={1.5}
          opacity={isRunning ? 0.8 : 0.4}
          strokeLinecap="round"
        />

        {/* Heat glow indicators on coils (running) */}
        {isRunning && (
          <g stroke="#f97316" strokeWidth={0.8} fill="none" opacity={0.4}>
            <path d="M 32 40 Q 29 42 32 44" />
            <path d="M 47 55 Q 44 57 47 59" />
            <path d="M 62 70 Q 59 72 62 74" />
            <path d="M 38 75 Q 41 77 38 79" />
            <path d="M 53 45 Q 56 47 53 49" />
            <path d="M 68 85 Q 71 87 68 89" />
          </g>
        )}

        {/* Vapor bubbles at top (visible only when running) */}
        {isRunning && (
          <g fill="#93c5fd" opacity={0.6}>
            <circle cx={38} cy={26} r={3} />
            <circle cx={48} cy={23} r={2.5} />
            <circle cx={57} cy={27} r={2} />
            <circle cx={64} cy={24} r={2.8} />
          </g>
        )}

        {/* Vapor rising lines (running) */}
        {isRunning && (
          <g stroke="#93c5fd" strokeWidth={1} fill="none" opacity={0.5}>
            <path d="M 40 28 Q 38 24 40 20" />
            <path d="M 50 25 Q 48 21 50 17" />
            <path d="M 62 26 Q 60 22 62 18" />
          </g>
        )}

        {/* Liquid level indicator (stopped — full) */}
        {!isRunning && (
          <rect
            x={21.5}
            y={55}
            width={57}
            height={44}
            rx={3}
            fill={colors.stroke}
            fillOpacity={0.08}
          />
        )}

        {/* Liquid level indicator (running — lower level with surface) */}
        {isRunning && (
          <g>
            <rect
              x={21.5}
              y={65}
              width={57}
              height={34}
              rx={3}
              fill="#93c5fd"
              fillOpacity={0.25}
            />
            {/* Liquid surface wave */}
            <path
              d="M 22 65 Q 35 62 50 65 Q 65 68 78 65"
              fill="none"
              stroke="#60a5fa"
              strokeWidth={1}
              opacity={0.6}
            />
          </g>
        )}

        {/* Nozzle — liquid-in (bottom) */}
        <line
          x1={50}
          y1={100}
          x2={50}
          y2={120}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="47,114 50,108 53,114" fill="#3b82f6" opacity={0.8} />
        )}

        {/* Nozzle — vapor-out (top) */}
        <line
          x1={50}
          y1={0}
          x2={50}
          y2={20}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="47,8 50,2 53,8" fill="#93c5fd" opacity={0.8} />
        )}

        {/* Nozzle — heat-in (left) */}
        <line
          x1={0}
          y1={50}
          x2={20}
          y2={50}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="10,47 16,50 10,53" fill="#ef4444" opacity={0.8} />
        )}

        {/* Nozzle — heat-out (right) */}
        <line
          x1={80}
          y1={70}
          x2={100}
          y2={70}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="88,67 94,70 88,73" fill="#f97316" opacity={0.8} />
        )}

        {/* P&ID label — EV */}
        <text
          x={50}
          y={116}
          textAnchor="middle"
          fontSize={10}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          EV
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
        points={CONNECTION_POINTS['evaporator']}
        viewBoxWidth={100}
        viewBoxHeight={120}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default EvaporatorSymbol;
