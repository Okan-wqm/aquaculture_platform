import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const SubmersiblePumpSymbol: React.FC<EquipmentSymbolProps> = ({
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
        {/* Vertical pump body / column pipe */}
        <rect
          x={35}
          y={10}
          width={30}
          height={55}
          rx={3}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Internal shaft line through body */}
        <line
          x1={50}
          y1={12}
          x2={50}
          y2={62}
          stroke={colors.stroke}
          strokeWidth={1.5}
          strokeDasharray="5,3"
          opacity={0.4}
        />

        {/* Motor housing — bottom circle */}
        <circle
          cx={50}
          cy={78}
          r={15}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Motor winding detail — concentric circle */}
        <circle
          cx={50}
          cy={78}
          r={9}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={1.5}
          opacity={0.5}
        />

        {/* Motor center shaft */}
        <circle
          cx={50}
          cy={78}
          r={3}
          fill={colors.stroke}
          fillOpacity={0.6}
        />

        {/* Impeller indication at motor-body junction */}
        {state === 'running' ? (
          <g
            className="scada-pump-spinning"
            style={{ transformOrigin: '50px 68px' } as React.CSSProperties}
            stroke={colors.stroke}
            strokeWidth={1.5}
            fill="none"
          >
            {/* Spinning impeller arcs */}
            <path d="M 42 68 C 44 72, 48 72, 50 68" />
            <path d="M 50 68 C 52 72, 56 72, 58 68" />
            <path d="M 45 70 C 47 66, 53 66, 55 70" />
          </g>
        ) : (
          <g stroke={colors.stroke} strokeWidth={1} fill="none" opacity={0.3}>
            <line x1={42} y1={68} x2={58} y2={68} />
            <line x1={45} y1={65} x2={55} y2={71} />
          </g>
        )}

        {/* Connection body-to-motor */}
        <line
          x1={50}
          y1={65}
          x2={50}
          y2={63}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Outlet pipe — exits from top */}
        <line
          x1={50}
          y1={0}
          x2={50}
          y2={10}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Outlet flange at top */}
        <line
          x1={42}
          y1={10}
          x2={58}
          y2={10}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Inlet arrows at bottom (water entry) */}
        <polygon
          points="38,90 42,86 42,94"
          fill={colors.stroke}
          fillOpacity={0.5}
        />
        <polygon
          points="62,90 58,86 58,94"
          fill={colors.stroke}
          fillOpacity={0.5}
        />

        {/* Inlet line — bottom */}
        <line
          x1={50}
          y1={93}
          x2={50}
          y2={100}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Water level indication lines around motor */}
        <line
          x1={28}
          y1={88}
          x2={72}
          y2={88}
          stroke={colors.stroke}
          strokeWidth={1}
          strokeDasharray="3,3"
          opacity={0.3}
        />
        <line
          x1={30}
          y1={92}
          x2={70}
          y2={92}
          stroke={colors.stroke}
          strokeWidth={1}
          strokeDasharray="3,3"
          opacity={0.2}
        />

        {/* P label */}
        <text
          x={78}
          y={50}
          textAnchor="start"
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
        points={CONNECTION_POINTS['submersiblePump']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default SubmersiblePumpSymbol;
