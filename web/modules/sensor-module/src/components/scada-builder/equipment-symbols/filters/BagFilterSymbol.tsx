import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const BagFilterSymbol: React.FC<EquipmentSymbolProps> = ({
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
      viewBox="0 0 100 140"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 70)`}>
        {/* Filter housing — vertical vessel */}
        <rect
          x={22}
          y={20}
          width={56}
          height={90}
          rx={4}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Top dome */}
        <path
          d="M 22 20 Q 50 5 78 20"
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Bottom cone */}
        <path
          d="M 22 110 Q 50 125 78 110"
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Filter bags — vertical tubes inside */}
        {[35, 50, 65].map((cx) => (
          <g key={cx}>
            <rect
              x={cx - 5}
              y={28}
              width={10}
              height={70}
              rx={5}
              fill="white"
              fillOpacity={0.5}
              stroke={colors.stroke}
              strokeWidth={1.2}
              strokeDasharray="2,2"
            />
          </g>
        ))}

        {/* Filter grid/plate — horizontal separator */}
        <line x1={22} y1={100} x2={78} y2={100} stroke={colors.stroke} strokeWidth={2} />

        {/* Inlet — top */}
        <line x1={50} y1={0} x2={50} y2={12} stroke={colors.stroke} strokeWidth={2.5} />
        <line x1={44} y1={12} x2={56} y2={12} stroke={colors.stroke} strokeWidth={1.5} />

        {/* Outlet — bottom */}
        <line x1={50} y1={125} x2={50} y2={135} stroke={colors.stroke} strokeWidth={2.5} />
        <line x1={44} y1={125} x2={56} y2={125} stroke={colors.stroke} strokeWidth={1.5} />

        {/* BF label */}
        <text
          x={50}
          y={118}
          textAnchor="middle"
          fontSize={9}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          BF
        </text>

        {label && (
          <text x={50} y={138} textAnchor="middle" fontSize={8} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['bagFilter']}
        viewBoxWidth={100}
        viewBoxHeight={140}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default BagFilterSymbol;
