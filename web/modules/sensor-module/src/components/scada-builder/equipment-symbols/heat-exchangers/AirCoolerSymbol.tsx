import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const AirCoolerSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];
  const isRunning = state === 'running';

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 140 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 70 50)`}>
        {/* Bottom tube bundle (finned section) */}
        <rect
          x={20}
          y={55}
          width={100}
          height={30}
          rx={2}
          fill={colors.fill}
          fillOpacity={0.6}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Tubes inside bundle */}
        <line
          x1={25}
          y1={63}
          x2={115}
          y2={63}
          stroke={isRunning ? '#ef4444' : colors.stroke}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          opacity={isRunning ? 0.7 : 0.4}
        />
        <line
          x1={25}
          y1={70}
          x2={115}
          y2={70}
          stroke={isRunning ? '#ef4444' : colors.stroke}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          opacity={isRunning ? 0.7 : 0.4}
        />
        <line
          x1={25}
          y1={77}
          x2={115}
          y2={77}
          stroke={isRunning ? '#ef4444' : colors.stroke}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          opacity={isRunning ? 0.7 : 0.4}
        />

        {/* Fin lines on tube bundle (vertical tick marks) */}
        {[28, 36, 44, 52, 60, 68, 76, 84, 92, 100, 108].map((x) => (
          <line
            key={x}
            x1={x}
            y1={56}
            x2={x}
            y2={84}
            stroke={colors.stroke}
            strokeWidth={0.8}
            opacity={0.3}
          />
        ))}

        {/* Fan housing — rectangular frame */}
        <rect
          x={45}
          y={8}
          width={50}
          height={42}
          rx={2}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2}
          opacity={0.6}
        />

        {/* Fan circle */}
        <circle
          cx={70}
          cy={29}
          r={18}
          fill={colors.fill}
          fillOpacity={0.3}
          stroke={colors.stroke}
          strokeWidth={2}
        />

        {/* Fan blades */}
        {isRunning ? (
          <g stroke={colors.stroke} strokeWidth={1.5} fill="none" opacity={0.7}>
            {/* Curved blades — running position */}
            <path d="M 70 11 Q 80 18 70 29" />
            <path d="M 88 29 Q 81 39 70 29" />
            <path d="M 70 47 Q 60 40 70 29" />
            <path d="M 52 29 Q 59 19 70 29" />
          </g>
        ) : (
          <g stroke={colors.stroke} strokeWidth={1.5} fill="none" opacity={0.4}>
            {/* Straight blades — stopped position */}
            <line x1={70} y1={11} x2={70} y2={29} />
            <line x1={88} y1={29} x2={70} y2={29} />
            <line x1={70} y1={47} x2={70} y2={29} />
            <line x1={52} y1={29} x2={70} y2={29} />
          </g>
        )}

        {/* Fan center hub */}
        <circle
          cx={70}
          cy={29}
          r={3}
          fill={colors.stroke}
          fillOpacity={0.6}
        />

        {/* Air flow direction arrows (upward) */}
        {isRunning && (
          <g fill="#60a5fa" opacity={0.6}>
            <polygon points="56,10 58,4 60,10" />
            <polygon points="69,6 71,0 73,6" />
            <polygon points="80,10 82,4 84,10" />
          </g>
        )}

        {/* Support structure between fan and bundle */}
        <line x1={45} y1={50} x2={45} y2={55} stroke={colors.stroke} strokeWidth={1.5} opacity={0.5} />
        <line x1={95} y1={50} x2={95} y2={55} stroke={colors.stroke} strokeWidth={1.5} opacity={0.5} />

        {/* Nozzle — inlet (left) */}
        <line
          x1={0}
          y1={70}
          x2={20}
          y2={70}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="10,67 16,70 10,73" fill="#ef4444" opacity={0.8} />
        )}

        {/* Nozzle — outlet (right) */}
        <line
          x1={120}
          y1={70}
          x2={140}
          y2={70}
          stroke={colors.stroke}
          strokeWidth={3}
        />
        {isRunning && (
          <polygon points="128,67 134,70 128,73" fill="#3b82f6" opacity={0.8} />
        )}

        {/* P&ID label — AC */}
        <text
          x={70}
          y={96}
          textAnchor="middle"
          fontSize={10}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          AC
        </text>

        {/* Label */}
        {label && (
          <text
            x={25}
            y={7}
            textAnchor="start"
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
        points={CONNECTION_POINTS['airCooler']}
        viewBoxWidth={140}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default AirCoolerSymbol;
