import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const AnimatedGearSymbol: React.FC<EquipmentSymbolProps> = ({
  state,
  width,
  height,
  rotation,
  showConnectionPoints,
  label,
}) => {
  const colors = EQUIPMENT_STATE_COLORS[state];
  const isRunning = state === 'running';

  // Gear tooth path helper — generates a gear outline
  const gearTeeth = 8;
  const outerR = 30;
  const innerR = 22;
  const toothW = 0.35; // tooth width in radians
  const points: string[] = [];

  for (let i = 0; i < gearTeeth; i++) {
    const baseAngle = (i * 2 * Math.PI) / gearTeeth;
    const angles = [
      baseAngle - toothW,
      baseAngle - toothW * 0.5,
      baseAngle + toothW * 0.5,
      baseAngle + toothW,
    ];
    const radii = [innerR, outerR, outerR, innerR];

    angles.forEach((a, j) => {
      const x = 50 + radii[j] * Math.cos(a);
      const y = 50 + radii[j] * Math.sin(a);
      points.push(`${i === 0 && j === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`);
    });
  }
  points.push('Z');
  const gearPath = points.join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <style>{`
          @keyframes gear-spin {
            from { transform: rotate(0deg); transform-origin: 50px 50px; }
            to   { transform: rotate(360deg); transform-origin: 50px 50px; }
          }
          @keyframes gear-spin-reverse {
            from { transform: rotate(0deg); transform-origin: 50px 50px; }
            to   { transform: rotate(-360deg); transform-origin: 50px 50px; }
          }
          .gear-rotate {
            animation: gear-spin 3s linear infinite;
            transform-origin: 50px 50px;
          }
          .gear-rotate-slow {
            animation: gear-spin-reverse 5s linear infinite;
            transform-origin: 50px 50px;
          }
        `}</style>
      </defs>

      <g transform={`rotate(${rotation || 0} 50 50)`}>
        {/* Main gear — rotates when running */}
        <g className={isRunning ? 'gear-rotate' : undefined}>
          <path
            d={gearPath}
            fill={colors.fill}
            fillOpacity={0.8}
            stroke={colors.stroke}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {/* Center bore */}
          <circle
            cx={50}
            cy={50}
            r={10}
            fill="white"
            fillOpacity={0.7}
            stroke={colors.stroke}
            strokeWidth={2}
          />
          {/* Hub spokes */}
          {[0, 90, 180, 270].map((a) => {
            const rad = (a * Math.PI) / 180;
            return (
              <line
                key={a}
                x1={50 + 10 * Math.cos(rad)}
                y1={50 + 10 * Math.sin(rad)}
                x2={50 + 18 * Math.cos(rad)}
                y2={50 + 18 * Math.sin(rad)}
                stroke={colors.stroke}
                strokeWidth={1.5}
              />
            );
          })}
        </g>

        {/* Shaft stubs */}
        <line x1={0} y1={50} x2={20} y2={50} stroke={colors.stroke} strokeWidth={2.5} />
        <line x1={80} y1={50} x2={100} y2={50} stroke={colors.stroke} strokeWidth={2.5} />

        {/* GR label */}
        <text
          x={50}
          y={96}
          textAnchor="middle"
          fontSize={9}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          GR
        </text>

        {label && (
          <text x={50} y={8} textAnchor="middle" fontSize={8} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['animatedGear']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default AnimatedGearSymbol;
