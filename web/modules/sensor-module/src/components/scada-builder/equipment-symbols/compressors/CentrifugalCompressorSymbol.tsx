import React from 'react';
import type { EquipmentSymbolProps } from '../types';
import { EQUIPMENT_STATE_COLORS } from '../types';
import { CONNECTION_POINTS } from '../types';
import { ConnectionPoints } from '../shared';

const CentrifugalCompressorSymbol: React.FC<EquipmentSymbolProps> = ({
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
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`rotate(${rotation || 0} 50 50)`}>
        {/* Volute casing — large circle */}
        <circle
          cx={50}
          cy={52}
          r={30}
          fill={colors.fill}
          fillOpacity={0.7}
          stroke={colors.stroke}
          strokeWidth={2.5}
        />

        {/* Impeller blades — radial curved vanes */}
        {isRunning ? (
          <g stroke={colors.stroke} strokeWidth={1.8} fill="none">
            <path d="M 50 26 C 62 30, 70 42, 68 52" />
            <path d="M 68 52 C 72 62, 64 74, 55 78" />
            <path d="M 55 78 C 44 82, 32 76, 27 66" />
            <path d="M 27 66 C 20 56, 24 42, 32 36" />
            <path d="M 32 36 C 38 28, 46 24, 50 26" />
          </g>
        ) : (
          <g stroke={colors.stroke} strokeWidth={1.5} fill="none" opacity={0.35}>
            {[0, 60, 120, 180, 240, 300].map((angle) => {
              const rad = (angle * Math.PI) / 180;
              const x1 = 50 + 10 * Math.cos(rad);
              const y1 = 52 + 10 * Math.sin(rad);
              const x2 = 50 + 24 * Math.cos(rad);
              const y2 = 52 + 24 * Math.sin(rad);
              return <line key={angle} x1={x1} y1={y1} x2={x2} y2={y2} />;
            })}
          </g>
        )}

        {/* Center hub */}
        <circle cx={50} cy={52} r={6} fill={colors.stroke} fillOpacity={0.7} />

        {/* Discharge volute nozzle — right/upward */}
        <path
          d="M 80 52 L 92 52 L 92 30 L 100 30"
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Inlet line — left (axial) */}
        <line x1={0} y1={52} x2={20} y2={52} stroke={colors.stroke} strokeWidth={2.5} />

        {/* CC label */}
        <text
          x={50}
          y={96}
          textAnchor="middle"
          fontSize={10}
          fontWeight="bold"
          fill={colors.stroke}
          fontFamily="sans-serif"
        >
          CC
        </text>

        {label && (
          <text x={50} y={10} textAnchor="middle" fontSize={9} fill="#374151" fontFamily="sans-serif">
            {label}
          </text>
        )}
      </g>

      <ConnectionPoints
        points={CONNECTION_POINTS['centrifugalCompressor']}
        viewBoxWidth={100}
        viewBoxHeight={100}
        show={showConnectionPoints || false}
      />
    </svg>
  );
};

export default CentrifugalCompressorSymbol;
