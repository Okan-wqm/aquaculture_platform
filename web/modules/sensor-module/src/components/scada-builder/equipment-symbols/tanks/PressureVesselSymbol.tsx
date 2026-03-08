import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const PressureVesselSymbol: React.FC<EquipmentSymbolProps> = ({
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
        {/* Vessel body with rounded dome heads */}
        <rect
          x={25}
          y={25}
          width={90}
          height={50}
          rx={25}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={3}
        />

        {/* Inner wall line — left dome (thick wall indication) */}
        <path
          d="M 38 30 Q 30 50 38 70"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={1.5}
          opacity={0.5}
        />

        {/* Inner wall line — right dome (thick wall indication) */}
        <path
          d="M 102 30 Q 110 50 102 70"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={1.5}
          opacity={0.5}
        />

        {/* Liquid level indicator (running state) */}
        {state === 'running' && (
          <g>
            <clipPath id={`${uid}-clip`}>
              <rect x={25} y={25} width={90} height={50} rx={25} />
            </clipPath>
            <rect
              x={25}
              y={45}
              width={90}
              height={30}
              fill="#93c5fd"
              fillOpacity={0.35}
              clipPath={`url(#${uid}-clip)`}
            />
            <path
              d="M 30 45 Q 55 42 70 45 Q 95 48 110 45"
              fill="none"
              stroke="#60a5fa"
              strokeWidth={1}
              opacity={0.6}
              clipPath={`url(#${uid}-clip)`}
            />
          </g>
        )}

        {/* Pressure gauge — manometer */}
        {/* Connection stem */}
        <line
          x1={70}
          y1={25}
          x2={70}
          y2={16}
          stroke={colors.stroke}
          strokeWidth={2}
        />
        {/* Gauge body */}
        <circle
          cx={70}
          cy={10}
          r={8}
          fill="#ffffff"
          stroke={colors.stroke}
          strokeWidth={1.5}
        />
        {/* Gauge inner ring */}
        <circle
          cx={70}
          cy={10}
          r={5.5}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={0.5}
          opacity={0.4}
        />
        {/* Gauge needle */}
        {state === 'running' ? (
          <line
            x1={70}
            y1={10}
            x2={74}
            y2={6}
            stroke="#ef4444"
            strokeWidth={1.2}
          />
        ) : (
          <line
            x1={70}
            y1={10}
            x2={65}
            y2={10}
            stroke="#9ca3af"
            strokeWidth={1.2}
          />
        )}
        {/* Gauge center dot */}
        <circle cx={70} cy={10} r={1.2} fill={colors.stroke} />
        {/* P label on gauge */}
        <text
          x={70}
          y={16}
          textAnchor="middle"
          fontSize={4}
          fill={colors.stroke}
          fontFamily="sans-serif"
          fontWeight="bold"
        >
          P
        </text>

        {/* Left inlet nozzle */}
        <line
          x1={0}
          y1={50}
          x2={18}
          y2={50}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        <line
          x1={0}
          y1={46}
          x2={0}
          y2={54}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Right outlet nozzle */}
        <line
          x1={122}
          y1={50}
          x2={140}
          y2={50}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        <line
          x1={140}
          y1={46}
          x2={140}
          y2={54}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Saddle supports */}
        <path
          d="M 40 75 L 40 88 L 52 88 L 52 75"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2}
        />
        <line x1={38} y1={88} x2={54} y2={88} stroke={colors.stroke} strokeWidth={2} />

        <path
          d="M 88 75 L 88 88 L 100 88 L 100 75"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2}
        />
        <line x1={86} y1={88} x2={102} y2={88} stroke={colors.stroke} strokeWidth={2} />

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
        points={CONNECTION_POINTS['pressureVessel']}
        viewBoxWidth={140}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default PressureVesselSymbol;
