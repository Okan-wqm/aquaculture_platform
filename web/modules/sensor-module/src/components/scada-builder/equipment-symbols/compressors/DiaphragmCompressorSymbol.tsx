import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const DiaphragmCompressorSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];
  const isRunning = state === 'running';

  // Diaphragm flex — alternates up/down when running
  const diaphragmOffset = isRunning ? -8 : 0;

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 50)`}>
        {/* Upper gas chamber — domed */}
        <path
          d="M 15 50 Q 50 15 85 50 Z"
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Lower hydraulic chamber */}
        <path
          d="M 15 50 Q 50 85 85 50 Z"
          fill={colors.fill}
          fillOpacity={0.5}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Diaphragm membrane — horizontal divider with flex */}
        <path
          d={`M 15 50 Q 50 ${50 + diaphragmOffset} 85 50`}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={3}
          strokeLinecap="round"
        />

        {/* Valve ports — top (suction / discharge) */}
        <line x1={35} y1={15} x2={35} y2={8} stroke={colors.stroke} strokeWidth={2} />
        <circle cx={35} cy={8} r={4} fill={colors.fill} stroke={colors.stroke} strokeWidth={1.5} />

        <line x1={65} y1={15} x2={65} y2={8} stroke={colors.stroke} strokeWidth={2} />
        <circle cx={65} cy={8} r={4} fill={colors.fill} stroke={colors.stroke} strokeWidth={1.5} />

        {/* Hydraulic drive — bottom */}
        <rect
          x={35}
          y={82}
          width={30}
          height={12}
          rx={3}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Inlet — left top */}
        <line x1={0} y1={30} x2={15} y2={30} stroke={colors.stroke} strokeWidth={2.5} />

        {/* Outlet — right top */}
        <line x1={85} y1={30} x2={100} y2={30} stroke={colors.stroke} strokeWidth={2.5} />

        {/* DC label */}
        <text
          x={50}
          y={97}
          textAnchor="middle"
          fontSize={9}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          DC
        </text>

        {label && (
          <text x={50} y={7} textAnchor="middle" fontSize={8} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['diaphragmCompressor']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default DiaphragmCompressorSymbol;
