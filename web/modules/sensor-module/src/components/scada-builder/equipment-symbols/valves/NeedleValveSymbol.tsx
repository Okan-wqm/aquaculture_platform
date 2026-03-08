import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const NeedleValveSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];
  const isOpen = state === 'open';

  // Needle position: open = retracted upward, closed = seated into orifice
  const needleTipY = isOpen ? 30 : 42;
  const stemTopY = isOpen ? 4 : 10;

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 100 80"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 40)`}>
        {/* Pipe stubs */}
        <line
          x1={0} y1={40} x2={20} y2={40}
          stroke="#6b7280" strokeWidth={3} strokeLinecap="round"
        />
        <line
          x1={80} y1={40} x2={100} y2={40}
          stroke="#6b7280" strokeWidth={3} strokeLinecap="round"
        />

        {/* Bowtie body — left triangle */}
        <path
          d="M 20 20 L 50 40 L 20 60 Z"
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Bowtie body — right triangle */}
        <path
          d="M 80 20 L 50 40 L 80 60 Z"
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Stem — vertical line from handwheel down to needle */}
        <line
          x1={50} y1={stemTopY} x2={50} y2={needleTipY - 8}
          stroke={colors.stroke} strokeWidth={2} strokeLinecap="round"
        />

        {/* Needle tip — conical point */}
        <path
          d={`M 47 ${needleTipY - 8} L 50 ${needleTipY} L 53 ${needleTipY - 8} Z`}
          fill={colors.stroke}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={1}
          strokeLinejoin="round"
        />

        {/* Handwheel — small circle at top */}
        <circle
          cx={50} cy={stemTopY} r={3.5}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2}
        />
        <circle
          cx={50} cy={stemTopY} r={1.2}
          fill={colors.stroke}
        />

        {/* Orifice seat — small gap indicator at center */}
        <line
          x1={46} y1={40} x2={54} y2={40}
          stroke={colors.stroke} strokeWidth={1.5}
          opacity={0.5}
        />

        {/* Label */}
        {label && (
          <text
            x={50} y={75}
            textAnchor="middle" fontSize={9}
            fill="#374151" fontFamily="sans-serif"
          >
            {label}
          </text>
        )}
      </g>

      {/* Connection points */}
      <ConnectionPoints
        points={CONNECTION_POINTS['needleValve']}
        viewBoxWidth={100}
        viewBoxHeight={80}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default NeedleValveSymbol;
