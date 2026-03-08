import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const SiloSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];
  const uid = React.useId();

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 100 140"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 70)`}>
        {/* Conical roof (material inlet) */}
        <path
          d="M 25 20 L 50 5 L 75 20"
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Cylindrical body */}
        <rect
          x={25}
          y={20}
          width={50}
          height={80}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Conical hopper bottom (discharge cone) */}
        <path
          d="M 25 100 L 50 130 L 75 100"
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Material level indicator (running state) */}
        {state === 'running' && (
          <g>
            {/* Material in cylindrical section (~65% full) */}
            <clipPath id={`${uid}-body`}>
              <rect x={26} y={20} width={48} height={80} />
            </clipPath>
            <rect
              x={26}
              y={42}
              width={48}
              height={58}
              fill="#d4a574"
              fillOpacity={0.4}
              clipPath={`url(#${uid}-body)`}
            />
            {/* Material in cone section */}
            <clipPath id={`${uid}-cone`}>
              <path d="M 25 100 L 50 130 L 75 100 Z" />
            </clipPath>
            <rect
              x={25}
              y={100}
              width={50}
              height={30}
              fill="#d4a574"
              fillOpacity={0.4}
              clipPath={`url(#${uid}-cone)`}
            />
            {/* Material surface (irregular) */}
            <path
              d="M 27 42 Q 36 38 50 42 Q 62 46 73 42"
              fill="none"
              stroke="#b8860b"
              strokeWidth={1}
              opacity={0.6}
            />
          </g>
        )}

        {/* Top inlet nozzle */}
        <line
          x1={50}
          y1={0}
          x2={50}
          y2={5}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />
        <line
          x1={44}
          y1={0}
          x2={56}
          y2={0}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Bottom outlet nozzle */}
        <line
          x1={50}
          y1={130}
          x2={50}
          y2={140}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />
        <line
          x1={44}
          y1={140}
          x2={56}
          y2={140}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* External ladder (thin lines on right side) */}
        <line x1={76} y1={22} x2={76} y2={98} stroke={colors.stroke} strokeWidth={1} opacity={0.5} />
        <line x1={82} y1={22} x2={82} y2={98} stroke={colors.stroke} strokeWidth={1} opacity={0.5} />
        {/* Ladder rungs */}
        <line x1={76} y1={30} x2={82} y2={30} stroke={colors.stroke} strokeWidth={1} opacity={0.5} />
        <line x1={76} y1={40} x2={82} y2={40} stroke={colors.stroke} strokeWidth={1} opacity={0.5} />
        <line x1={76} y1={50} x2={82} y2={50} stroke={colors.stroke} strokeWidth={1} opacity={0.5} />
        <line x1={76} y1={60} x2={82} y2={60} stroke={colors.stroke} strokeWidth={1} opacity={0.5} />
        <line x1={76} y1={70} x2={82} y2={70} stroke={colors.stroke} strokeWidth={1} opacity={0.5} />
        <line x1={76} y1={80} x2={82} y2={80} stroke={colors.stroke} strokeWidth={1} opacity={0.5} />
        <line x1={76} y1={90} x2={82} y2={90} stroke={colors.stroke} strokeWidth={1} opacity={0.5} />

        {/* Support structure (diagonal legs) */}
        <line x1={30} y1={108} x2={22} y2={135} stroke={colors.stroke} strokeWidth={2} />
        <line x1={70} y1={108} x2={78} y2={135} stroke={colors.stroke} strokeWidth={2} />
        {/* Cross brace */}
        <line x1={26} y1={122} x2={74} y2={122} stroke={colors.stroke} strokeWidth={1} opacity={0.5} />
        {/* Feet */}
        <line x1={18} y1={135} x2={26} y2={135} stroke={colors.stroke} strokeWidth={2} />
        <line x1={74} y1={135} x2={82} y2={135} stroke={colors.stroke} strokeWidth={2} />

        {/* Label */}
        {label && (
          <text
            x={50}
            y={137}
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
        points={CONNECTION_POINTS['silo']}
        viewBoxWidth={100}
        viewBoxHeight={140}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default SiloSymbol;
