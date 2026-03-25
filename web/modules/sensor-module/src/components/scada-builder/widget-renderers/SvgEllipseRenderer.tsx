/**
 * SVG Ellipse renderer -- renders an ellipse with configurable fill, stroke,
 * dash pattern, line cap/join, and per-color opacity.
 * Uses SVG <ellipse> element with rx/ry computed from widget dimensions.
 *
 * Separated from SvgCircleRenderer because the circle widget always uses
 * equal rx/ry and lacks dash-pattern / line-cap controls. This widget
 * exposes full SVG stroke styling for technical diagrams.
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import {
  DASH_PATTERN_MAP,
  type StrokeDashPattern,
  type StrokeLineCap,
  type StrokeLineJoin,
} from '../../../types/scada-svg-properties.types';

const SvgEllipseRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, animationState,
}) => {
  const fill = (animationState?.fill ?? config.fill ?? '#3b82f6') as string;
  const stroke = (animationState?.stroke ?? config.stroke ?? '#1d4ed8') as string;
  const strokeWidth = (config.strokeWidth ?? 2) as number;
  const fillOpacity = (config.fillOpacity ?? 1) as number;
  const strokeOpacity = (config.strokeOpacity ?? 1) as number;
  const dashPattern = (config.dashPattern ?? 'solid') as StrokeDashPattern;
  const lineCap = (config.lineCap ?? 'butt') as StrokeLineCap;
  const lineJoin = (config.lineJoin ?? 'miter') as StrokeLineJoin;
  const label = (config.label ?? '') as string;

  // Visibility from animation
  if (animationState && !animationState.visible) {
    return <div style={{ width, height, opacity: 0 }} />;
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

  const cx = width / 2;
  const cy = height / 2;
  const rx = (width - strokeWidth) / 2;
  const ry = (height - strokeWidth) / 2;

  const dashArrayValue = DASH_PATTERN_MAP[dashPattern] || '';

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={style}>
      <ellipse
        cx={cx}
        cy={cy}
        rx={Math.max(0, rx)}
        ry={Math.max(0, ry)}
        fill={fill}
        fillOpacity={fillOpacity}
        stroke={stroke}
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
        strokeDasharray={dashArrayValue || undefined}
        strokeLinecap={lineCap}
        strokeLinejoin={lineJoin}
      />
      {label && (
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={Math.min(width, height) * 0.15}
          fill={stroke}
          fontFamily="sans-serif"
          fontWeight={600}
        >
          {label}
        </text>
      )}
    </svg>
  );
};

SvgEllipseRenderer.displayName = 'SvgEllipseRenderer';
export default memo(SvgEllipseRenderer);
