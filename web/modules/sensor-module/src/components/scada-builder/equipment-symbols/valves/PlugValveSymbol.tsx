import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const PlugValveSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];
  const isOpen = state === 'open';
  const isClosed = state === 'closed';

  // Plug rotates 90° when closed — indicator line angle
  const plugAngle = isClosed ? 90 : 0;

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 100 80"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 40)`}>
        {/* Pipe stubs */}
        <line x1={0} y1={40} x2={22} y2={40} stroke="#6b7280" strokeWidth={3} strokeLinecap="round" />
        <line x1={78} y1={40} x2={100} y2={40} stroke="#6b7280" strokeWidth={3} strokeLinecap="round" />

        {/* Plug body — tapered trapezoid */}
        <path
          d="M 22 28 L 78 28 L 78 52 L 22 52 Z"
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Plug taper lines */}
        <line x1={28} y1={28} x2={32} y2={52} stroke={colors.stroke} strokeWidth={1} opacity={0.4} />
        <line x1={72} y1={28} x2={68} y2={52} stroke={colors.stroke} strokeWidth={1} opacity={0.4} />

        {/* Bore hole through plug */}
        <ellipse
          cx={50}
          cy={40}
          rx={isOpen ? 10 : 4}
          ry={6}
          fill="white"
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={1.5}
          transform={`rotate(${plugAngle} 50 40)`}
        />

        {/* Stem / wrench square on top */}
        <rect
          x={44}
          y={14}
          width={12}
          height={14}
          rx={2}
          fill={colors.fill}
          stroke={colors.stroke}
          strokeWidth={2}
        />
        <line x1={50} y1={14} x2={50} y2={28} stroke={colors.stroke} strokeWidth={2} />

        {/* Wrench nut indicator */}
        <line x1={40} y1={16} x2={60} y2={16} stroke={colors.stroke} strokeWidth={2} strokeLinecap="round" />

        {/* Closed indicator — bore aligned vertical (blocking flow) */}
        {isClosed && (
          <line
            x1={50}
            y1={28}
            x2={50}
            y2={52}
            stroke={colors.stroke}
            strokeWidth={3}
            opacity={0.4}
            strokeLinecap="round"
          />
        )}

        {label && (
          <text x={50} y={75} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['plugValve']}
        viewBoxWidth={100}
        viewBoxHeight={80}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default PlugValveSymbol;
