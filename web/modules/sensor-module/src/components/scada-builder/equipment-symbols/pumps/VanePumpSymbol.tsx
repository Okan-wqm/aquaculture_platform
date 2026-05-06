import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const VanePumpSymbol: React.FC<EquipmentSymbolProps> = ({
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
        {/* Cam ring (eccentric outer casing) */}
        <ellipse
          cx={50}
          cy={50}
          rx={30}
          ry={28}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Rotor — offset circle */}
        <circle
          cx={50}
          cy={52}
          r={17}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={1.5}
          strokeDasharray="2,2"
          opacity={0.5}
        />

        {/* Vanes — 4 radial blades from offset rotor */}
        {[0, 90, 180, 270].map((angle) => {
          const rad = (angle * Math.PI) / 180;
          const cx2 = 50, cy2 = 52;
          const x1 = cx2 + 6 * Math.cos(rad);
          const y1 = cy2 + 6 * Math.sin(rad);
          const x2 = cx2 + 22 * Math.cos(rad);
          const y2 = cy2 + 22 * Math.sin(rad);
          return (
            <line
              key={angle}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={colors.stroke}
              strokeWidth={2}
              opacity={state === 'running' ? 1 : 0.4}
            />
          );
        })}

        {/* Center shaft */}
        <circle cx={50} cy={52} r={5} fill={colors.stroke} fillOpacity={0.6} />

        {/* Inlet line — left */}
        <line x1={0} y1={50} x2={20} y2={50} stroke={colors.stroke} strokeWidth={2.5} />

        {/* Outlet line — right */}
        <line x1={80} y1={50} x2={100} y2={50} stroke={colors.stroke} strokeWidth={2.5} />

        {/* VP label */}
        <text
          x={50}
          y={93}
          textAnchor="middle"
          fontSize={10}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          VP
        </text>

        {label && (
          <text x={50} y={10} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['vanePump']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default VanePumpSymbol;
