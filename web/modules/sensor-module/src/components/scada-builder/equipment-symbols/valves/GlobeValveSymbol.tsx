import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const GlobeValveSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];
  const isOpen = state === 'open';

  // Plug position: open = raised, closed = seated
  const plugTipY = isOpen ? 34 : 40;

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

        {/* Globe — circle at center representing the globe body */}
        <circle
          cx={50} cy={40} r={8}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Globe interior — horizontal seat line */}
        <line
          x1={42} y1={40} x2={58} y2={40}
          stroke={colors.stroke} strokeWidth={1.5}
        />

        {/* Plug/disc — moves up/down with state */}
        <line
          x1={50} y1={plugTipY} x2={50} y2={plugTipY - 6}
          stroke={colors.stroke} strokeWidth={2} strokeLinecap="round"
        />

        {/* Stem — from plug up to handwheel */}
        <line
          x1={50} y1={plugTipY - 6} x2={50} y2={5}
          stroke={colors.stroke} strokeWidth={2} strokeLinecap="round"
        />

        {/* Handwheel — circle at top */}
        <circle
          cx={50} cy={4} r={4}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Handwheel center */}
        <circle
          cx={50} cy={4} r={1.5}
          fill={colors.stroke}
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
        points={CONNECTION_POINTS['globeValve']}
        viewBoxWidth={100}
        viewBoxHeight={80}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default GlobeValveSymbol;
