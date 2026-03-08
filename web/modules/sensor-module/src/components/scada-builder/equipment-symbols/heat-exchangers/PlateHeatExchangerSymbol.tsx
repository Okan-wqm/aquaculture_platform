import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const PlateHeatExchangerSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];
  const isRunning = state === 'running';

  const plateXPositions = [42, 52, 62, 72, 82, 92];

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 140 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 70 50)`}>
        {/* Outer frame */}
        <rect
          x={30}
          y={15}
          width={80}
          height={70}
          rx={3}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* End plate — left */}
        <rect
          x={30}
          y={15}
          width={6}
          height={70}
          rx={1}
          fill={colors.stroke}
          fillOpacity={0.3}
          stroke={colors.stroke}
          strokeWidth={1}
        />

        {/* End plate — right */}
        <rect
          x={104}
          y={15}
          width={6}
          height={70}
          rx={1}
          fill={colors.stroke}
          fillOpacity={0.3}
          stroke={colors.stroke}
          strokeWidth={1}
        />

        {/* Parallel plates */}
        {plateXPositions.map((x) => (
          <line
            key={x}
            x1={x}
            y1={20}
            x2={x}
            y2={80}
            stroke={colors.stroke}
            strokeWidth={1.5}
            opacity={0.7}
          />
        ))}

        {/* Hot flow — chevron/zigzag between plates (left channels) */}
        {isRunning ? (
          <g stroke="#ef4444" strokeWidth={1.2} fill="none" opacity={0.7}>
            {/* Channel between plates at x=42-52 */}
            <path d="M 44 22 L 48 30 L 44 38 L 48 46 L 44 54 L 48 62 L 44 70 L 48 78" />
            {/* Channel between plates at x=62-72 */}
            <path d="M 64 22 L 68 30 L 64 38 L 68 46 L 64 54 L 68 62 L 64 70 L 68 78" />
            {/* Channel between plates at x=82-92 */}
            <path d="M 84 22 L 88 30 L 84 38 L 88 46 L 84 54 L 88 62 L 84 70 L 88 78" />
          </g>
        ) : (
          <g stroke={colors.stroke} strokeWidth={1} fill="none" opacity={0.3}>
            <path d="M 44 22 L 48 30 L 44 38 L 48 46 L 44 54 L 48 62 L 44 70 L 48 78" />
            <path d="M 64 22 L 68 30 L 64 38 L 68 46 L 64 54 L 68 62 L 64 70 L 68 78" />
            <path d="M 84 22 L 88 30 L 84 38 L 88 46 L 84 54 L 88 62 L 84 70 L 88 78" />
          </g>
        )}

        {/* Cold flow — chevron/zigzag between plates (right channels) */}
        {isRunning ? (
          <g stroke="#3b82f6" strokeWidth={1.2} fill="none" opacity={0.7}>
            {/* Channel between plates at x=52-62 */}
            <path d="M 56 78 L 54 70 L 58 62 L 54 54 L 58 46 L 54 38 L 58 30 L 54 22" />
            {/* Channel between plates at x=72-82 */}
            <path d="M 76 78 L 74 70 L 78 62 L 74 54 L 78 46 L 74 38 L 78 30 L 74 22" />
            {/* Channel between plates at x=92-104 */}
            <path d="M 96 78 L 94 70 L 98 62 L 94 54 L 98 46 L 94 38 L 98 30 L 94 22" />
          </g>
        ) : (
          <g stroke={colors.stroke} strokeWidth={1} fill="none" opacity={0.3}>
            <path d="M 56 78 L 54 70 L 58 62 L 54 54 L 58 46 L 54 38 L 58 30 L 54 22" />
            <path d="M 76 78 L 74 70 L 78 62 L 74 54 L 78 46 L 74 38 L 78 30 L 74 22" />
            <path d="M 96 78 L 94 70 L 98 62 L 94 54 L 98 46 L 94 38 L 98 30 L 94 22" />
          </g>
        )}

        {/* Nozzle — hot-in (left-top) */}
        <line
          x1={0}
          y1={28}
          x2={30}
          y2={28}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="16,25 22,28 16,31" fill="#ef4444" opacity={0.8} />
        )}

        {/* Nozzle — hot-out (right-bottom) */}
        <line
          x1={110}
          y1={72}
          x2={140}
          y2={72}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="126,69 132,72 126,75" fill="#ef4444" opacity={0.8} />
        )}

        {/* Nozzle — cold-in (right-top) */}
        <line
          x1={110}
          y1={28}
          x2={140}
          y2={28}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="120,25 114,28 120,31" fill="#3b82f6" opacity={0.8} />
        )}

        {/* Nozzle — cold-out (left-bottom) */}
        <line
          x1={0}
          y1={72}
          x2={30}
          y2={72}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="8,69 2,72 8,75" fill="#3b82f6" opacity={0.8} />
        )}

        {/* Tie bolts (top and bottom) */}
        <line x1={36} y1={13} x2={104} y2={13} stroke={colors.stroke} strokeWidth={1.5} opacity={0.5} />
        <line x1={36} y1={87} x2={104} y2={87} stroke={colors.stroke} strokeWidth={1.5} opacity={0.5} />

        {/* P&ID label — PHE */}
        <text
          x={70}
          y={96}
          textAnchor="middle"
          fontSize={10}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          PHE
        </text>

        {/* Label */}
        {label && (
          <text
            x={70}
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
        points={CONNECTION_POINTS['plateHeatExchanger']}
        viewBoxWidth={140}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default PlateHeatExchangerSymbol;
