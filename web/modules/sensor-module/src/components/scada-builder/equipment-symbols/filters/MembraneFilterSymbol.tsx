import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const MembraneFilterSymbol: React.FC<EquipmentSymbolProps> = ({
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
        {/* Pressure vessel — horizontal cylinder */}
        <rect
          x={10}
          y={28}
          width={100}
          height={44}
          rx={5}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* End caps */}
        <ellipse cx={10} cy={50} rx={6} ry={22} fill={colors.fill} fillOpacity={0.9} stroke={colors.stroke} strokeWidth={2} />
        <ellipse cx={110} cy={50} rx={6} ry={22} fill={colors.fill} fillOpacity={0.9} stroke={colors.stroke} strokeWidth={2} />

        {/* Membrane module dividers — vertical lines inside vessel */}
        {[35, 55, 75, 95].map((x) => (
          <line
            key={x}
            x1={x}
            y1={30}
            x2={x}
            y2={70}
            stroke={colors.stroke}
            strokeWidth={1.2}
            strokeDasharray={isRunning ? 'none' : '3,2'}
            opacity={isRunning ? 0.7 : 0.35}
          />
        ))}

        {/* Permeate collector tube — center horizontal */}
        <line
          x1={16}
          y1={50}
          x2={104}
          y2={50}
          stroke={colors.stroke}
          strokeWidth={1.5}
          strokeDasharray="4,2"
          opacity={0.4}
        />

        {/* Feed inlet — left */}
        <line x1={0} y1={50} x2={10} y2={50} stroke={colors.stroke} strokeWidth={2.5} />

        {/* Retentate outlet — right */}
        <line x1={110} y1={50} x2={120} y2={50} stroke={colors.stroke} strokeWidth={2.5} />

        {/* Permeate outlet — bottom center */}
        <line x1={60} y1={72} x2={60} y2={85} stroke={colors.stroke} strokeWidth={2} />
        <line x1={54} y1={85} x2={66} y2={85} stroke={colors.stroke} strokeWidth={1.5} />

        {/* UF label */}
        <text
          x={60}
          y={18}
          textAnchor="middle"
          fontSize={9}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          MF
        </text>

        {label && (
          <text x={60} y={96} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['membraneFilter']}
        viewBoxWidth={120}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default MembraneFilterSymbol;
