import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const VacuumPumpSymbol: React.FC<EquipmentSymbolProps> = ({
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
        {/* Main pump body — circle */}
        <circle
          cx={50}
          cy={55}
          r={30}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Vacuum symbol — inward pointing arrows forming V shape */}
        {state === 'running' ? (
          <g
            className="scada-pump-spinning"
            style={{ transformOrigin: '50px 55px' } as React.CSSProperties}
            stroke={colors.stroke}
            strokeWidth={2}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {/* V shape — suction symbol */}
            <polyline points="36,42 50,62 64,42" />
            {/* Inward arrow heads at the top of V arms */}
            <polyline points="38,48 36,42 42,43" />
            <polyline points="62,48 64,42 58,43" />
          </g>
        ) : (
          <g stroke={colors.stroke} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.4}>
            {/* Static V shape */}
            <polyline points="36,42 50,62 64,42" />
          </g>
        )}

        {/* Underline of V for emphasis */}
        <line
          x1={38}
          y1={68}
          x2={62}
          y2={68}
          stroke={colors.stroke}
          strokeWidth={1.5}
          opacity={0.4}
        />

        {/* Gauge / manometer at the top — mini circle */}
        <circle
          cx={50}
          cy={18}
          r={7}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Gauge needle */}
        <line
          x1={50}
          y1={18}
          x2={state === 'running' ? 54 : 50}
          y2={state === 'running' ? 14 : 12}
          stroke={colors.stroke}
          strokeWidth={1.5}
          strokeLinecap="round"
        />

        {/* Gauge center dot */}
        <circle
          cx={50}
          cy={18}
          r={1.5}
          fill={colors.stroke}
        />

        {/* Gauge tick marks */}
        <line x1={44} y1={15} x2={45} y2={16} stroke={colors.stroke} strokeWidth={1} opacity={0.5} />
        <line x1={56} y1={15} x2={55} y2={16} stroke={colors.stroke} strokeWidth={1} opacity={0.5} />
        <line x1={50} y1={11} x2={50} y2={12.5} stroke={colors.stroke} strokeWidth={1} opacity={0.5} />

        {/* Connection pipe from gauge to pump body */}
        <line
          x1={50}
          y1={25}
          x2={50}
          y2={25}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />

        {/* Inlet line — left */}
        <line
          x1={0}
          y1={55}
          x2={20}
          y2={55}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Outlet line — right */}
        <line
          x1={80}
          y1={55}
          x2={100}
          y2={55}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* P label */}
        <text
          x={50}
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
            y={8}
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
        points={CONNECTION_POINTS['vacuumPump']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default VacuumPumpSymbol;
