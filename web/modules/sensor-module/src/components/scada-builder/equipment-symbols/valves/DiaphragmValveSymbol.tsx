import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const DiaphragmValveSymbol: React.FC<EquipmentSymbolProps> = ({
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

  // Diaphragm dome position: up when open, pushed down when closed
  const diaphragmCy = isOpen ? 38 : isClosed ? 44 : 41;

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
        <line x1={0} y1={50} x2={20} y2={50} stroke="#6b7280" strokeWidth={3} strokeLinecap="round" />
        <line x1={80} y1={50} x2={100} y2={50} stroke="#6b7280" strokeWidth={3} strokeLinecap="round" />

        {/* Valve body — lower portion */}
        <path
          d="M 20 38 L 20 55 Q 20 62 27 62 L 73 62 Q 80 62 80 55 L 80 38 Z"
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Diaphragm membrane — curved */}
        <path
          d={`M 20 38 Q 50 ${diaphragmCy} 80 38`}
          fill={colors.fill}
          fillOpacity={0.5}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Bonnet / actuator body — upper */}
        <rect
          x={35}
          y={12}
          width={30}
          height={26}
          rx={3}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Handwheel */}
        <line x1={38} y1={12} x2={62} y2={12} stroke={colors.stroke} strokeWidth={2.5} strokeLinecap="round" />
        <circle cx={50} cy={12} r={2.5} fill={colors.stroke} fillOpacity={0.6} />

        {/* Stem line inside bonnet */}
        <line x1={50} y1={12} x2={50} y2={38} stroke={colors.stroke} strokeWidth={1.5} strokeDasharray="3,2" opacity={0.4} />

        {/* Closed indicator — full block */}
        {isClosed && (
          <rect
            x={22}
            y={44}
            width={56}
            height={4}
            rx={1}
            fill={colors.stroke}
            fillOpacity={0.3}
          />
        )}

        {label && (
          <text x={50} y={75} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['diaphragmValve']}
        viewBoxWidth={100}
        viewBoxHeight={80}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default DiaphragmValveSymbol;
