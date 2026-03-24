/**
 * SvgLineRenderer - SVG line shape widget for SCADA screens
 *
 * Renders a configurable line (horizontal, vertical, or diagonal).
 * Supports stroke color, width, dash pattern, and animation state
 * for color, blink, and visibility.
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

type LineDirection = 'horizontal' | 'vertical' | 'diagonal-tl' | 'diagonal-tr';

function getLineCoords(
  direction: LineDirection,
  width: number,
  height: number,
  pad: number,
): { x1: number; y1: number; x2: number; y2: number } {
  switch (direction) {
    case 'vertical':
      return { x1: width / 2, y1: pad, x2: width / 2, y2: height - pad };
    case 'diagonal-tl':
      return { x1: pad, y1: pad, x2: width - pad, y2: height - pad };
    case 'diagonal-tr':
      return { x1: width - pad, y1: pad, x2: pad, y2: height - pad };
    case 'horizontal':
    default:
      return { x1: pad, y1: height / 2, x2: width - pad, y2: height / 2 };
  }
}

const SvgLineRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, animationState,
}) => {
  const stroke = (animationState?.stroke ?? config.stroke ?? '#1d4ed8') as string;
  const strokeWidth = (config.strokeWidth ?? 3) as number;
  const direction = (config.lineDirection ?? 'horizontal') as LineDirection;
  const dashArray = (config.dashArray ?? '') as string;

  // Visibility from animation
  if (animationState && !animationState.visible) {
    return <div style={{ width, height, opacity: 0 }} />;
  }

  // Animation styles
  const style: React.CSSProperties = {};
  if (animationState?.blinking) {
    style.animation = `scada-blink ${animationState.blinkInterval}ms ease-in-out infinite`;
  }

  const pad = strokeWidth / 2;
  const { x1, y1, x2, y2 } = getLineCoords(direction, width, height, pad);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={style}>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={dashArray || undefined}
      />
    </svg>
  );
};

SvgLineRenderer.displayName = 'SvgLineRenderer';
export default memo(SvgLineRenderer);
