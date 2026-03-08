import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const CheckValveSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];
  const isOpen = state === 'open';

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
        <line
          x1={0} y1={40} x2={25} y2={40}
          stroke="#6b7280" strokeWidth={3} strokeLinecap="round"
        />
        <line
          x1={75} y1={40} x2={100} y2={40}
          stroke="#6b7280" strokeWidth={3} strokeLinecap="round"
        />

        {/* Flow direction triangle — pointing right */}
        <path
          d="M 25 20 L 55 40 L 25 60 Z"
          fill={colors.fill}
          fillOpacity={0.8}
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Barrier / flap — vertical line at triangle tip */}
        {isOpen ? (
          // Flap swung open — angled line (hinged at top)
          <line
            x1={55} y1={20} x2={68} y2={35}
            stroke={colors.stroke} strokeWidth={2.5} strokeLinecap="round"
          />
        ) : (
          // Flap closed — vertical barrier blocking flow
          <line
            x1={55} y1={20} x2={55} y2={60}
            stroke={colors.stroke} strokeWidth={3} strokeLinecap="round"
          />
        )}

        {/* Hinge point at top of barrier */}
        <circle
          cx={55} cy={20} r={2}
          fill={colors.stroke} fillOpacity={0.7}
        />

        {/* Flow direction arrow (small) — inside triangle area */}
        <path
          d="M 32 40 L 44 40"
          stroke={colors.stroke}
          strokeWidth={1.5}
          strokeLinecap="round"
          markerEnd="url(#checkArrow)"
        />
        <defs>
          <marker
            id="checkArrow"
            viewBox="0 0 6 6"
            refX={5} refY={3}
            markerWidth={5} markerHeight={5}
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 6 3 L 0 6 Z" fill={colors.stroke} />
          </marker>
        </defs>

        {/* Downstream housing line — extends barrier area */}
        <line
          x1={55} y1={20} x2={75} y2={20}
          stroke={colors.stroke} strokeWidth={1.5}
        />
        <line
          x1={55} y1={60} x2={75} y2={60}
          stroke={colors.stroke} strokeWidth={1.5}
        />
        <line
          x1={75} y1={20} x2={75} y2={60}
          stroke={colors.stroke} strokeWidth={1.5}
          strokeDasharray={isOpen ? 'none' : '4 2'}
        />

        {/* Label */}
        {label && (
          <text
            x={50} y={75}
            textAnchor="middle" fontSize={9}
            fill="#374151" fontFamily="sans-serif"
          >
            {label}
          </text>
        )}
      </g>

      {/* Connection points */}
      <ConnectionPoints
        points={CONNECTION_POINTS['checkValve']}
        viewBoxWidth={100}
        viewBoxHeight={80}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default CheckValveSymbol;
