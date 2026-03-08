import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const HorizontalTankSymbol: React.FC<EquipmentSymbolProps> = ({
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
      viewBox="0 0 140 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 70 50)`}>
        {/* Tank body */}
        <rect
          x={25}
          y={25}
          width={90}
          height={50}
          rx={3}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Left elliptical head */}
        <path
          d="M 25 25 Q 10 50 25 75"
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Right elliptical head */}
        <path
          d="M 115 25 Q 130 50 115 75"
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Liquid level indicator (running state) */}
        {state === 'running' && (
          <g>
            {/* Liquid fill — ~55% full */}
            <clipPath id={`${uid}-clip`}>
              <rect x={14} y={25} width={112} height={50} rx={3} />
            </clipPath>
            <rect
              x={14}
              y={42}
              width={112}
              height={33}
              fill="#93c5fd"
              fillOpacity={0.4}
              clipPath={`url(#${uid}-clip)`}
            />
            {/* Liquid surface */}
            <path
              d="M 18 42 Q 45 39 70 42 Q 95 45 122 42"
              fill="none"
              stroke="#60a5fa"
              strokeWidth={1}
              opacity={0.7}
            />
          </g>
        )}

        {/* Top vent nozzle */}
        <rect
          x={65}
          y={20}
          width={10}
          height={5}
          fill={colors.fill}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />
        <line
          x1={70}
          y1={20}
          x2={70}
          y2={10}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />
        {/* Vent flange */}
        <line
          x1={65}
          y1={10}
          x2={75}
          y2={10}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Bottom drain nozzle */}
        <rect
          x={65}
          y={75}
          width={10}
          height={5}
          fill={colors.fill}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />
        <line
          x1={70}
          y1={80}
          x2={70}
          y2={90}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />
        {/* Drain flange */}
        <line
          x1={65}
          y1={90}
          x2={75}
          y2={90}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Left inlet nozzle */}
        <line
          x1={0}
          y1={50}
          x2={14}
          y2={50}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />
        <line
          x1={0}
          y1={47}
          x2={0}
          y2={53}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Right outlet nozzle */}
        <line
          x1={126}
          y1={50}
          x2={140}
          y2={50}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />
        <line
          x1={140}
          y1={47}
          x2={140}
          y2={53}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Saddle supports (legs) */}
        <path
          d="M 35 75 L 35 88 L 45 88 L 45 75"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2}
        />
        <line x1={33} y1={88} x2={47} y2={88} stroke={colors.stroke} strokeWidth={2} />

        <path
          d="M 95 75 L 95 88 L 105 88 L 105 75"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2}
        />
        <line x1={93} y1={88} x2={107} y2={88} stroke={colors.stroke} strokeWidth={2} />

        {/* Label */}
        {label && (
          <text
            x={70}
            y={97}
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
        points={CONNECTION_POINTS['horizontalTank']}
        viewBoxWidth={140}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default HorizontalTankSymbol;
