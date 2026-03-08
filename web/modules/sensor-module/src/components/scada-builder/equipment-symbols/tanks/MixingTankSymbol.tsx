import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const MixingTankSymbol: React.FC<EquipmentSymbolProps> = ({
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
        {/* Motor housing */}
        <rect
          x={40}
          y={5}
          width={20}
          height={12}
          rx={2}
          fill={colors.stroke}
          fillOpacity={0.3}
          stroke={colors.stroke}
          strokeWidth={2}
        />
        {/* Motor label */}
        <text
          x={50}
          y={14}
          textAnchor="middle"
          fontSize={6}
          fill={colors.stroke}
          fontFamily="sans-serif"
          fontWeight="bold"
        >
          M
        </text>

        {/* Dome top cap */}
        <path
          d="M 20 25 Q 50 10 80 25"
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Shaft through dome */}
        <line
          x1={50}
          y1={17}
          x2={50}
          y2={85}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Tank body */}
        <rect
          x={20}
          y={25}
          width={60}
          height={85}
          rx={3}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Flat bottom */}
        <line
          x1={20}
          y1={110}
          x2={80}
          y2={110}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Liquid level indicator (running state) */}
        {state === 'running' && (
          <g>
            <clipPath id={`${uid}-clip`}>
              <rect x={21} y={25} width={58} height={84} />
            </clipPath>
            <rect
              x={21}
              y={50}
              width={58}
              height={59}
              fill="#93c5fd"
              fillOpacity={0.4}
              clipPath={`url(#${uid}-clip)`}
            />
            {/* Liquid surface with turbulence (mixing effect) */}
            <path
              d="M 22 50 Q 30 46 38 50 Q 46 54 50 50 Q 54 46 62 50 Q 70 54 78 50"
              fill="none"
              stroke="#60a5fa"
              strokeWidth={1.2}
              opacity={0.7}
              clipPath={`url(#${uid}-clip)`}
            />
          </g>
        )}

        {/* Shaft (on top of liquid, inside tank) */}
        <line
          x1={50}
          y1={25}
          x2={50}
          y2={85}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Impeller / Agitator blades */}
        {state === 'running' ? (
          <g stroke={colors.stroke} strokeWidth={2} fill="none">
            {/* Upper impeller — angled for rotation effect */}
            <path d="M 33 76 L 50 82 L 67 76" strokeLinejoin="round" />
            <path d="M 33 88 L 50 82 L 67 88" strokeLinejoin="round" />
            {/* Lower impeller */}
            <path d="M 36 92 L 50 97 L 64 92" strokeLinejoin="round" opacity={0.7} />
            <path d="M 36 102 L 50 97 L 64 102" strokeLinejoin="round" opacity={0.7} />
          </g>
        ) : (
          <g stroke={colors.stroke} strokeWidth={2} fill="none" opacity={0.4}>
            {/* Static impeller */}
            <path d="M 35 78 L 50 85 L 65 78" strokeLinejoin="round" />
            <path d="M 35 92 L 50 85 L 65 92" strokeLinejoin="round" />
          </g>
        )}

        {/* Hub at shaft end */}
        <circle
          cx={50}
          cy={85}
          r={3}
          fill={colors.stroke}
          fillOpacity={0.5}
        />

        {/* Top inlet nozzle */}
        <line
          x1={50}
          y1={0}
          x2={50}
          y2={5}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Left additive inlet nozzle */}
        <line
          x1={0}
          y1={42}
          x2={20}
          y2={42}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />
        <line
          x1={0}
          y1={39}
          x2={0}
          y2={45}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Right drain nozzle */}
        <line
          x1={80}
          y1={97}
          x2={100}
          y2={97}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />
        <line
          x1={100}
          y1={94}
          x2={100}
          y2={100}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Bottom outlet nozzle */}
        <line
          x1={50}
          y1={110}
          x2={50}
          y2={128}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />
        <line
          x1={44}
          y1={128}
          x2={56}
          y2={128}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Support legs */}
        <rect x={24} y={110} width={5} height={12} fill={colors.stroke} fillOpacity={0.5} rx={1} />
        <rect x={71} y={110} width={5} height={12} fill={colors.stroke} fillOpacity={0.5} rx={1} />

        {/* Baffles inside tank (thin vertical lines) */}
        <line
          x1={25}
          y1={30}
          x2={25}
          y2={107}
          stroke={colors.stroke}
          strokeWidth={1}
          opacity={0.3}
        />
        <line
          x1={75}
          y1={30}
          x2={75}
          y2={107}
          stroke={colors.stroke}
          strokeWidth={1}
          opacity={0.3}
        />

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
        points={CONNECTION_POINTS['mixingTank']}
        viewBoxWidth={100}
        viewBoxHeight={140}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default MixingTankSymbol;
