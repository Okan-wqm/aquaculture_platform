import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const ConicalBottomTankSymbol: React.FC<EquipmentSymbolProps> = ({
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
        {/* Dome top cap */}
        <path
          d="M 20 15 Q 50 0 80 15"
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Cylindrical body */}
        <rect
          x={20}
          y={15}
          width={60}
          height={70}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Conical bottom */}
        <path
          d="M 20 85 L 50 125 L 80 85"
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Liquid level indicator (running state) */}
        {state === 'running' && (
          <g>
            {/* Liquid fill in rectangular section */}
            <clipPath id={`${uid}-body`}>
              <rect x={21} y={15} width={58} height={70} />
            </clipPath>
            <rect
              x={21}
              y={45}
              width={58}
              height={40}
              fill="#93c5fd"
              fillOpacity={0.4}
              clipPath={`url(#${uid}-body)`}
            />
            {/* Liquid fill in conical section */}
            <clipPath id={`${uid}-cone`}>
              <path d="M 20 85 L 50 125 L 80 85 Z" />
            </clipPath>
            <rect
              x={20}
              y={85}
              width={60}
              height={40}
              fill="#93c5fd"
              fillOpacity={0.4}
              clipPath={`url(#${uid}-cone)`}
            />
            {/* Liquid surface wave */}
            <path
              d="M 22 45 Q 35 42 50 45 Q 65 48 78 45"
              fill="none"
              stroke="#60a5fa"
              strokeWidth={1}
              opacity={0.7}
            />
          </g>
        )}

        {/* Top inlet nozzle */}
        <line
          x1={50}
          y1={0}
          x2={50}
          y2={7}
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

        {/* Bottom outlet nozzle (from cone tip) */}
        <line
          x1={50}
          y1={125}
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

        {/* Left level gauge nozzle */}
        <line
          x1={0}
          y1={70}
          x2={20}
          y2={70}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />
        <line
          x1={0}
          y1={67}
          x2={0}
          y2={73}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Support legs */}
        <line x1={28} y1={95} x2={22} y2={132} stroke={colors.stroke} strokeWidth={2} />
        <line x1={72} y1={95} x2={78} y2={132} stroke={colors.stroke} strokeWidth={2} />
        {/* Feet */}
        <line x1={18} y1={132} x2={26} y2={132} stroke={colors.stroke} strokeWidth={2} />
        <line x1={74} y1={132} x2={82} y2={132} stroke={colors.stroke} strokeWidth={2} />

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
        points={CONNECTION_POINTS['conicalBottomTank']}
        viewBoxWidth={100}
        viewBoxHeight={140}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default ConicalBottomTankSymbol;
