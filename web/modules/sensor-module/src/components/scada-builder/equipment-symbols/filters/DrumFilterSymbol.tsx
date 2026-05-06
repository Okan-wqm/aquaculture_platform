import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const DrumFilterSymbol: React.FC<EquipmentSymbolProps> = ({
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
        {/* Tank / trough body */}
        <rect
          x={10}
          y={45}
          width={100}
          height={45}
          rx={4}
          fill={colors.fill}
          fillOpacity={0.5}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Liquid surface */}
        <path
          d="M 10 58 Q 35 54 60 58 Q 85 62 110 58"
          fill="#93c5fd"
          fillOpacity={0.25}
          stroke="#60a5fa"
          strokeWidth={0.8}
        />

        {/* Rotating drum — circle partially submerged */}
        <circle
          cx={60}
          cy={55}
          r={32}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Drum filter mesh — radial segments */}
        {isRunning ? (
          <g stroke={colors.stroke} strokeWidth={1} opacity={0.5}>
            {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((angle) => {
              const rad = (angle * Math.PI) / 180;
              const x2 = 60 + 30 * Math.cos(rad);
              const y2 = 55 + 30 * Math.sin(rad);
              return <line key={angle} x1={60} y1={55} x2={x2} y2={y2} />;
            })}
          </g>
        ) : (
          <g stroke={colors.stroke} strokeWidth={1} opacity={0.25}>
            {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => {
              const rad = (angle * Math.PI) / 180;
              const x2 = 60 + 30 * Math.cos(rad);
              const y2 = 55 + 30 * Math.sin(rad);
              return <line key={angle} x1={60} y1={55} x2={x2} y2={y2} />;
            })}
          </g>
        )}

        {/* Drum center shaft */}
        <circle cx={60} cy={55} r={5} fill={colors.stroke} fillOpacity={0.7} />

        {/* Shaft bearing stubs */}
        <line x1={10} y1={55} x2={28} y2={55} stroke={colors.stroke} strokeWidth={3} strokeLinecap="round" />
        <line x1={92} y1={55} x2={110} y2={55} stroke={colors.stroke} strokeWidth={3} strokeLinecap="round" />

        {/* Scraper blade */}
        <line
          x1={60}
          y1={23}
          x2={90}
          y2={30}
          stroke={colors.stroke}
          strokeWidth={2}
          strokeLinecap="round"
        />

        {/* Inlet — left */}
        <line x1={0} y1={70} x2={10} y2={70} stroke={colors.stroke} strokeWidth={2.5} />

        {/* Outlet — bottom */}
        <line x1={60} y1={90} x2={60} y2={100} stroke={colors.stroke} strokeWidth={2.5} />

        {/* DF label */}
        <text
          x={60}
          y={96}
          textAnchor="middle"
          fontSize={9}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          DF
        </text>

        {label && (
          <text x={60} y={10} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['drumFilter']}
        viewBoxWidth={120}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default DrumFilterSymbol;
