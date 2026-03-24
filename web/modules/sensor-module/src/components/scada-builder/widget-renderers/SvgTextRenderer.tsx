/**
 * SvgTextRenderer - SVG text widget for SCADA screens
 *
 * Renders configurable SVG text with font size, weight, color, and
 * alignment. Supports showing a live tag value alongside (or in place
 * of) static text. Animation state controls color, blink, and visibility.
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

type TextAnchorValue = 'start' | 'middle' | 'end';

const SvgTextRenderer: React.FC<WidgetRendererProps> = ({
  config, value, width, height, animationState,
}) => {
  const text = (config.text ?? 'Text') as string;
  const fontSize = (config.fontSize ?? 16) as number;
  const fontWeight = (config.fontWeight ?? 'normal') as string;
  const color = (animationState?.fill ?? config.color ?? '#1f2937') as string;
  const textAlign = (config.textAlign ?? 'center') as 'left' | 'center' | 'right';
  const showValue = (config.showValue ?? false) as boolean;

  // Visibility from animation
  if (animationState && !animationState.visible) {
    return <div style={{ width, height, opacity: 0 }} />;
  }

  // Animation styles
  const style: React.CSSProperties = {};
  if (animationState?.blinking) {
    style.animation = `scada-blink ${animationState.blinkInterval}ms ease-in-out infinite`;
  }

  const anchorMap: Record<string, TextAnchorValue> = {
    left: 'start',
    center: 'middle',
    right: 'end',
  };
  const xMap: Record<string, number> = {
    left: 8,
    center: width / 2,
    right: width - 8,
  };

  const anchor = anchorMap[textAlign] ?? 'middle';
  const xPos = xMap[textAlign] ?? width / 2;

  const displayText = showValue && value !== undefined
    ? `${text}: ${String(value)}`
    : text;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={style}>
      <text
        x={xPos}
        y={height / 2}
        textAnchor={anchor}
        dominantBaseline="central"
        fontSize={fontSize}
        fontWeight={fontWeight}
        fill={color}
        fontFamily="sans-serif"
      >
        {displayText}
      </text>
    </svg>
  );
};

SvgTextRenderer.displayName = 'SvgTextRenderer';
export default memo(SvgTextRenderer);
