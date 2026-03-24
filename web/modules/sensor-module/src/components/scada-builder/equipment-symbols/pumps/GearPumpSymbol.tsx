import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

/** Radial gear teeth lines around a circle */
const GearTeeth: React.FC<{
  cx: number;
  cy: number;
  r: number;
  teeth: number;
  stroke: string;
}> = ({ cx, cy, r, teeth, stroke }) => {
  const lines = [];
  for (let i = 0; i < teeth; i++) {
    const angle = (i * 2 * Math.PI) / teeth;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + (r + 4) * Math.cos(angle);
    const y2 = cy + (r + 4) * Math.sin(angle);
    lines.push(
      <line
        key={i}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
      />
    );
  }
  return <>{lines}</>;
};

const GearPumpSymbol: React.FC<EquipmentSymbolProps> = ({
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
        {/* Outer pump body */}
        <circle
          cx={50}
          cy={50}
          r={30}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Left gear — spinning when running */}
        <g
          className={state === 'running' ? 'scada-pump-spinning' : undefined}
          style={state === 'running' ? { transformOrigin: '40px 50px' } as React.CSSProperties : undefined}
        >
          <circle
            cx={40}
            cy={50}
            r={10}
            fill="none"
            stroke={colors.stroke}
            strokeWidth={1.5}
          />
          <GearTeeth cx={40} cy={50} r={10} teeth={6} stroke={colors.stroke} />
        </g>

        {/* Right gear — spinning when running */}
        <g
          className={state === 'running' ? 'scada-pump-spinning' : undefined}
          style={state === 'running' ? { transformOrigin: '60px 50px' } as React.CSSProperties : undefined}
        >
          <circle
            cx={60}
            cy={50}
            r={10}
            fill="none"
            stroke={colors.stroke}
            strokeWidth={1.5}
          />
          <GearTeeth cx={60} cy={50} r={10} teeth={6} stroke={colors.stroke} />
        </g>

        {/* Gear center dots */}
        <circle cx={40} cy={50} r={2.5} fill={colors.stroke} fillOpacity={0.6} />
        <circle cx={60} cy={50} r={2.5} fill={colors.stroke} fillOpacity={0.6} />

        {/* Meshing indication — dashed line between gears */}
        {state === 'running' && (
          <line
            x1={50}
            y1={40}
            x2={50}
            y2={60}
            stroke={colors.stroke}
            strokeWidth={1}
            strokeDasharray="2,2"
            opacity={0.5}
          />
        )}

        {/* Inlet line — left */}
        <line
          x1={0}
          y1={50}
          x2={20}
          y2={50}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Outlet line — right */}
        <line
          x1={80}
          y1={50}
          x2={100}
          y2={50}
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

      {/* Connection points */}
      <ConnectionPoints
        points={CONNECTION_POINTS['gearPump']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default GearPumpSymbol;
