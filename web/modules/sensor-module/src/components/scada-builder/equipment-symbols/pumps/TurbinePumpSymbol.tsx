import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const TurbinePumpSymbol: React.FC<EquipmentSymbolProps> = ({
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
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 50)`}>
        {/* Pump casing — circle */}
        <circle
          cx={50}
          cy={50}
          r={30}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Turbine blades — radial vanes */}
        {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => {
          const rad = (angle * Math.PI) / 180;
          const x1 = 50 + 10 * Math.cos(rad);
          const y1 = 50 + 10 * Math.sin(rad);
          const x2 = 50 + 24 * Math.cos(rad);
          const y2 = 50 + 24 * Math.sin(rad);
          return (
            <line
              key={angle}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={colors.stroke}
              strokeWidth={state === 'running' ? 2 : 1.5}
              opacity={state === 'running' ? 1 : 0.5}
            />
          );
        })}

        {/* Center hub */}
        <circle
          cx={50}
          cy={50}
          r={6}
          fill={colors.stroke}
          fillOpacity={0.7}
        />

        {/* Inlet line — left */}
        <line x1={0} y1={50} x2={20} y2={50} stroke={colors.stroke} strokeWidth={2.5} />

        {/* Outlet line — top */}
        <line x1={50} y1={0} x2={50} y2={20} stroke={colors.stroke} strokeWidth={2.5} />

        {/* TP label */}
        <text
          x={50}
          y={92}
          textAnchor="middle"
          fontSize={10}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          TP
        </text>

        {label && (
          <text x={50} y={10} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['turbinePump']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default TurbinePumpSymbol;
