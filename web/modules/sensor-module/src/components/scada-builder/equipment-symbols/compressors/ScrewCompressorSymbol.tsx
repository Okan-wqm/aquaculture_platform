import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const ScrewCompressorSymbol: React.FC<EquipmentSymbolProps> = ({
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
        {/* Compressor housing */}
        <rect
          x={15}
          y={22}
          width={85}
          height={56}
          rx={5}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Upper rotor — male screw helix */}
        <path
          d="M 20 35 C 28 28, 36 28, 44 35 C 52 42, 60 42, 68 35 C 76 28, 84 28, 92 35"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2}
          opacity={isRunning ? 1 : 0.4}
        />

        {/* Lower rotor — female screw helix (offset) */}
        <path
          d="M 20 58 C 28 65, 36 65, 44 58 C 52 51, 60 51, 68 58 C 76 65, 84 65, 92 58"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2}
          opacity={isRunning ? 1 : 0.4}
        />

        {/* Rotor divider line */}
        <line x1={20} y1={50} x2={100} y2={50} stroke={colors.stroke} strokeWidth={0.8} strokeDasharray="3,3" opacity={0.3} />

        {/* End plate — left */}
        <rect x={10} y={19} width={8} height={62} rx={2} fill={colors.fill} fillOpacity={0.9} stroke={colors.stroke} strokeWidth={2} />

        {/* End plate — right */}
        <rect x={102} y={19} width={8} height={62} rx={2} fill={colors.fill} fillOpacity={0.9} stroke={colors.stroke} strokeWidth={2} />

        {/* Inlet line — left */}
        <line x1={0} y1={50} x2={10} y2={50} stroke={colors.stroke} strokeWidth={2.5} />

        {/* Outlet line — right */}
        <line x1={110} y1={50} x2={120} y2={50} stroke={colors.stroke} strokeWidth={2.5} />

        {/* SC label */}
        <text
          x={60}
          y={92}
          textAnchor="middle"
          fontSize={10}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          SC
        </text>

        {label && (
          <text x={60} y={10} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['screwCompressor']}
        viewBoxWidth={120}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default ScrewCompressorSymbol;
