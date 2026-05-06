import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS, FaultOverlay, MaintenanceOverlay } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const CentrifugalPumpSymbol: React.FC<EquipmentSymbolProps> = ({
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
        {/* Pump body — circle */}
        <circle
          cx={45}
          cy={50}
          r={28}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Discharge triangle — pointing right */}
        <polygon
          points="65,35 85,50 65,65"
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Impeller blades inside the circle — 3 curved lines (fan blade effect) */}
        {state === 'running' ? (
          <g
            className="scada-pump-spinning"
            style={{ transformOrigin: '45px 50px' } as React.CSSProperties}
            stroke={colors.stroke}
            strokeWidth={1.5}
            fill="none"
          >
            {/* Blade 1 — top-left curve */}
            <path d="M 45 22 C 55 30, 55 40, 45 50" />
            {/* Blade 2 — bottom-left curve */}
            <path d="M 45 78 C 35 70, 35 60, 45 50" />
            {/* Blade 3 — right curve */}
            <path d="M 17 50 C 25 40, 35 40, 45 50" />
          </g>
        ) : (
          <g stroke={colors.stroke} strokeWidth={1.5} fill="none" opacity={0.4}>
            {/* Static blades — straight radial lines */}
            <line x1={45} y1={22} x2={45} y2={50} />
            <line x1={21} y1={62} x2={45} y2={50} />
            <line x1={69} y1={62} x2={45} y2={50} />
          </g>
        )}

        {/* Center hub */}
        <circle
          cx={45}
          cy={50}
          r={4}
          fill={colors.stroke}
          fillOpacity={0.6}
        />

        {/* Inlet line — left */}
        <line
          x1={0}
          y1={50}
          x2={17}
          y2={50}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Outlet line — right */}
        <line
          x1={85}
          y1={50}
          x2={100}
          y2={50}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* P label */}
        <text
          x={45}
          y={95}
          textAnchor="middle"
          fontSize={11}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          P
        </text>

        {/* Label */}
        {label && (
          <text
            x={50}
            y={10}
            textAnchor="middle"
            fontSize={9}
            fill="#374151"
            fontFamily="sans-serif"
          >
            {label}
          </text>
        )}
      </g>

      <FaultOverlay state={state} viewBoxWidth={100} viewBoxHeight={100} />
      <MaintenanceOverlay state={state} viewBoxWidth={100} viewBoxHeight={100} />

      {/* Connection points */}
      <ConnectionPoints
        points={CONNECTION_POINTS['centrifugalPump']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default CentrifugalPumpSymbol;
