import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const PinchValveSymbol: React.FC<EquipmentSymbolProps> = ({
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

  // Pinch gap: open = wide, closed = fully pinched
  const pinchY = isClosed ? 40 : isOpen ? 30 : 34;
  const pinchYBottom = isClosed ? 40 : isOpen ? 50 : 46;

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
        <line x1={0} y1={40} x2={20} y2={40} stroke="#6b7280" strokeWidth={3} strokeLinecap="round" />
        <line x1={80} y1={40} x2={100} y2={40} stroke="#6b7280" strokeWidth={3} strokeLinecap="round" />

        {/* Sleeve body — outer rectangle */}
        <rect
          x={20}
          y={25}
          width={60}
          height={30}
          rx={4}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Hose/sleeve — upper wall */}
        <path
          d={`M 20 35 Q 50 ${pinchY} 80 35`}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Hose/sleeve — lower wall */}
        <path
          d={`M 20 45 Q 50 ${pinchYBottom} 80 45`}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Pinch actuator — top bar */}
        <rect
          x={40}
          y={10}
          width={20}
          height={6}
          rx={2}
          fill={colors.fill}
          stroke={colors.stroke}
          strokeWidth={1.5}
        />
        {/* Actuator stem */}
        <line x1={50} y1={16} x2={50} y2={25} stroke={colors.stroke} strokeWidth={2} />

        {/* Closed indicator */}
        {isClosed && (
          <line
            x1={20}
            y1={40}
            x2={80}
            y2={40}
            stroke={colors.stroke}
            strokeWidth={3}
            strokeLinecap="round"
            opacity={0.5}
          />
        )}

        {label && (
          <text x={50} y={75} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['pinchValve']}
        viewBoxWidth={100}
        viewBoxHeight={80}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default PinchValveSymbol;
