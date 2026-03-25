/**
 * SVG Path/Polyline renderer -- renders arbitrary paths from an array of
 * PathPoints supporting line, quadratic, and cubic bezier segments.
 * The path d-attribute is computed via buildPathD() and memoized.
 *
 * When no points are provided (or fewer than 2), a dashed placeholder
 * rectangle is shown in edit mode to guide the user to draw a path.
 */

import React, { memo, useMemo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import { buildPathD, type PathPoint } from '../../../types/scada-path.types';
import {
  DASH_PATTERN_MAP,
  type StrokeDashPattern,
  type StrokeLineCap,
  type StrokeLineJoin,
} from '../../../types/scada-svg-properties.types';

const SvgPathRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, isEditing, animationState,
}) => {
  const points = (config.points ?? []) as PathPoint[];
  const closed = (config.closed ?? false) as boolean;
  const fill = (animationState?.fill ?? config.fill ?? 'none') as string;
  const stroke = (animationState?.stroke ?? config.stroke ?? '#1d4ed8') as string;
  const strokeWidth = (config.strokeWidth ?? 2) as number;
  const fillOpacity = (config.fillOpacity ?? 1) as number;
  const strokeOpacity = (config.strokeOpacity ?? 1) as number;
  const dashPattern = (config.dashPattern ?? 'solid') as StrokeDashPattern;
  const lineCap = (config.lineCap ?? 'round') as StrokeLineCap;
  const lineJoin = (config.lineJoin ?? 'round') as StrokeLineJoin;

  // Memoize the d-attribute to avoid recomputing on every render
  const pathD = useMemo(() => buildPathD(points, closed), [points, closed]);

  // Visibility from animation
  if (animationState && !animationState.visible) {
    return <div style={{ width, height, opacity: 0 }} />;
  }

  // Show placeholder when insufficient points
  if (!pathD) {
    if (!isEditing) {
      // Nothing to show in runtime mode
      return <div style={{ width, height }} />;
    }
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <rect
          x={4}
          y={4}
          width={width - 8}
          height={height - 8}
          fill="none"
          stroke="#d1d5db"
          strokeWidth={2}
          strokeDasharray="6 4"
          rx={6}
        />
        <text
          x={width / 2}
          y={height / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={12}
          fill="#9ca3af"
          fontFamily="sans-serif"
        >
          Draw path
        </text>
      </svg>
    );
  }

  // Animation styles
  const style: React.CSSProperties = {};
  if (animationState?.rotating) {
    const dir = animationState.rotationDirection === 'ccw' ? 'reverse' : 'normal';
    style.animation = `scada-rotate ${animationState.rotationSpeed}ms linear infinite ${dir}`;
    style.transformOrigin = 'center center';
  }
  if (animationState?.blinking) {
    style.animation = `scada-blink ${animationState.blinkInterval}ms ease-in-out infinite`;
  }

  const dashArrayValue = DASH_PATTERN_MAP[dashPattern] || '';

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={style}>
      <path
        d={pathD}
        fill={closed ? fill : 'none'}
        fillOpacity={closed ? fillOpacity : undefined}
        stroke={stroke}
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
        strokeDasharray={dashArrayValue || undefined}
        strokeLinecap={lineCap}
        strokeLinejoin={lineJoin}
      />
    </svg>
  );
};

SvgPathRenderer.displayName = 'SvgPathRenderer';
export default memo(SvgPathRenderer);
