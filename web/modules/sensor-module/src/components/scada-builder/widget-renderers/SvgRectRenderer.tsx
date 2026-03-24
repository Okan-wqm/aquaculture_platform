/**
 * SvgRectRenderer - SVG rectangle shape widget for SCADA screens
 *
 * Renders a configurable rectangle with fill, stroke, corner radius,
 * opacity, and optional label. Supports animation state for color,
 * rotation, blink, and visibility.
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const SvgRectRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, animationState,
}) => {
  const fill = (animationState?.fill ?? config.fill ?? '#3b82f6') as string;
  const stroke = (animationState?.stroke ?? config.stroke ?? '#1d4ed8') as string;
  const strokeWidth = (config.strokeWidth ?? 2) as number;
  const rx = (config.cornerRadius ?? 0) as number;
  const opacity = (config.opacity ?? 1) as number;
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

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={style}>
      <rect
        x={strokeWidth / 2}
        y={strokeWidth / 2}
        width={width - strokeWidth}
        height={height - strokeWidth}
        rx={rx}
        ry={rx}
        fill={fill}
        fillOpacity={opacity}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
      {label && (
        <text
          x={width / 2}
          y={height / 2}
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

SvgRectRenderer.displayName = 'SvgRectRenderer';
export default memo(SvgRectRenderer);
