import React from 'react';
import type { EquipmentConnectionPoint } from '../../../types/scada-widget.types';
import { CONNECTION_POINT_COLORS } from './types';

/** Renders connection point circles on SVG edges */
export const ConnectionPoints: React.FC<{
  points: EquipmentConnectionPoint[];
  viewBoxWidth: number;
  viewBoxHeight: number;
  show: boolean;
}> = ({ points, viewBoxWidth, viewBoxHeight, show }) => {
  if (!show) return null;

  return (
    <g className="connection-points">
      {points.map((pt) => {
        let cx: number, cy: number;
        switch (pt.side) {
          case 'top':
            cx = pt.offset * viewBoxWidth;
            cy = 0;
            break;
          case 'bottom':
            cx = pt.offset * viewBoxWidth;
            cy = viewBoxHeight;
            break;
          case 'left':
            cx = 0;
            cy = pt.offset * viewBoxHeight;
            break;
          case 'right':
            cx = viewBoxWidth;
            cy = pt.offset * viewBoxHeight;
            break;
        }
        return (
          <g key={pt.id}>
            <title>{pt.label}</title>
            <circle
              cx={cx}
              cy={cy}
              r={4}
              fill={CONNECTION_POINT_COLORS[pt.direction]}
              stroke="#ffffff"
              strokeWidth={1.5}
            />
          </g>
        );
      })}
    </g>
  );
};

/** Label rendered below SVG */
export const EquipmentLabel: React.FC<{
  label?: string;
  viewBoxWidth: number;
  viewBoxHeight: number;
}> = ({ label, viewBoxWidth, viewBoxHeight }) => {
  if (!label) return null;
  return (
    <text
      x={viewBoxWidth / 2}
      y={viewBoxHeight - 2}
      textAnchor="middle"
      fontSize={10}
      fill="#374151"
      fontFamily="sans-serif"
    >
      {label}
    </text>
  );
};
