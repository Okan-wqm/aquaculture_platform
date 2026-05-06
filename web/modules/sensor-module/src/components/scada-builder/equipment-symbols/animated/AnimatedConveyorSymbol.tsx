import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS, FaultOverlay, MaintenanceOverlay } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const AnimatedConveyorSymbol: React.FC<EquipmentSymbolProps> = ({
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
      viewBox="0 0 140 80"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <style>{`
          @keyframes belt-move {
            from { stroke-dashoffset: 0; }
            to   { stroke-dashoffset: -20; }
          }
          @keyframes drum-spin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }
          .belt-animate {
            animation: belt-move 0.6s linear infinite;
          }
          .drum-left-spin {
            transform-origin: 20px 40px;
            animation: drum-spin 1s linear infinite;
          }
          .drum-right-spin {
            transform-origin: 120px 40px;
            animation: drum-spin 1s linear infinite;
          }
        `}</style>
        <clipPath id="conveyor-clip">
          <rect x={10} y={25} width={120} height={30} />
        </clipPath>
      </defs>

      <g transform={`rotate(${rotation || 0} 70 40)`}>
        {/* Frame / support structure */}
        <line x1={20} y1={55} x2={20} y2={70} stroke="#9ca3af" strokeWidth={2} />
        <line x1={70} y1={58} x2={70} y2={70} stroke="#9ca3af" strokeWidth={2} />
        <line x1={120} y1={55} x2={120} y2={70} stroke="#9ca3af" strokeWidth={2} />
        <line x1={10} y1={70} x2={130} y2={70} stroke="#9ca3af" strokeWidth={1.5} />

        {/* Drive drum — left */}
        <g className={isRunning ? 'drum-left-spin' : undefined}>
          <circle
            cx={20}
            cy={40}
            r={16}
            fill={colors.fill}
            fillOpacity={0.8}
            stroke={colors.stroke}
            strokeWidth={2.5}
          />
          {/* Drum spokes */}
          {[0, 60, 120, 180, 240, 300].map((a) => {
            const rad = (a * Math.PI) / 180;
            return (
              <line
                key={a}
                x1={20}
                y1={40}
                x2={20 + 12 * Math.cos(rad)}
                y2={40 + 12 * Math.sin(rad)}
                stroke={colors.stroke}
                strokeWidth={1.2}
                opacity={0.6}
              />
            );
          })}
          <circle cx={20} cy={40} r={3} fill={colors.stroke} fillOpacity={0.7} />
        </g>

        {/* Idler drum — right */}
        <g className={isRunning ? 'drum-right-spin' : undefined}>
          <circle
            cx={120}
            cy={40}
            r={16}
            fill={colors.fill}
            fillOpacity={0.8}
            stroke={colors.stroke}
            strokeWidth={2.5}
          />
          {[0, 60, 120, 180, 240, 300].map((a) => {
            const rad = (a * Math.PI) / 180;
            return (
              <line
                key={a}
                x1={120}
                y1={40}
                x2={120 + 12 * Math.cos(rad)}
                y2={40 + 12 * Math.sin(rad)}
                stroke={colors.stroke}
                strokeWidth={1.2}
                opacity={0.6}
              />
            );
          })}
          <circle cx={120} cy={40} r={3} fill={colors.stroke} fillOpacity={0.7} />
        </g>

        {/* Belt — top surface */}
        <line
          x1={20}
          y1={24}
          x2={120}
          y2={24}
          stroke={colors.stroke}
          strokeWidth={4}
          strokeLinecap="butt"
        />

        {/* Belt — bottom surface */}
        <line
          x1={20}
          y1={56}
          x2={120}
          y2={56}
          stroke={colors.stroke}
          strokeWidth={4}
          strokeLinecap="butt"
          opacity={0.4}
        />

        {/* Moving belt slats — animated dashes on top belt */}
        <line
          x1={20}
          y1={24}
          x2={120}
          y2={24}
          stroke="white"
          strokeWidth={2}
          strokeDasharray="8,12"
          strokeLinecap="butt"
          opacity={0.5}
          className={isRunning ? 'belt-animate' : undefined}
          clipPath="url(#conveyor-clip)"
        />

        {/* Material load on belt — when running */}
        {isRunning && (
          <rect
            x={55}
            y={16}
            width={30}
            height={8}
            rx={2}
            fill="#d97706"
            fillOpacity={0.5}
            stroke="#b45309"
            strokeWidth={1}
          />
        )}

        {/* CV label */}
        <text
          x={70}
          y={77}
          textAnchor="middle"
          fontSize={9}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          CV
        </text>

        {label && (
          <text x={70} y={10} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <FaultOverlay state={state} viewBoxWidth={140} viewBoxHeight={80} />
      <MaintenanceOverlay state={state} viewBoxWidth={140} viewBoxHeight={80} />

      <ConnectionPoints
        points={CONNECTION_POINTS['animatedConveyor']}
        viewBoxWidth={140}
        viewBoxHeight={80}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default AnimatedConveyorSymbol;
