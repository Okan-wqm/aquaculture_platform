/**
 * SvgTriangleRenderer - Directional triangle shape for SCADA screens
 *
 * Renders an SVG <polygon> with 3 points. The direction config
 * determines which way the triangle points: up, down, left, or right.
 * Commonly used for flow direction indicators and alert markers.
 *
 * Supports gradient fill and SVG filter effects via per-widget <defs>.
 */

import React, { memo, useMemo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import SvgGradientDefs from '../widget-configs/SvgGradientDefs';
import type { GradientConfig, SvgFilterConfig } from '../../../types/scada-svg-properties.types';
import { DEFAULT_GRADIENT, DEFAULT_FILTER, buildGradientId, buildFilterId } from '../../../types/scada-svg-properties.types';

type TriangleDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Computes 3-point triangle vertices for the given bounding box and direction.
 * The apex of the triangle points in the specified direction.
 */
function computeTrianglePoints(
  width: number,
  height: number,
  strokeWidth: number,
  direction: TriangleDirection,
): string {
  const pad = strokeWidth / 2;
  const l = pad;
  const r = width - pad;
  const t = pad;
  const b = height - pad;
  const mx = width / 2;
  const my = height / 2;

  switch (direction) {
    case 'up':
      return `${mx},${t} ${r},${b} ${l},${b}`;
    case 'down':
      return `${l},${t} ${r},${t} ${mx},${b}`;
    case 'left':
      return `${l},${my} ${r},${t} ${r},${b}`;
    case 'right':
      return `${l},${t} ${r},${my} ${l},${b}`;
    default:
      return `${mx},${t} ${r},${b} ${l},${b}`;
  }
}

const SvgTriangleRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, animationState,
}) => {
  const flatFill = (animationState?.fill ?? config.fill ?? '#10b981') as string;
  const stroke = (animationState?.stroke ?? config.stroke ?? '#059669') as string;
  const strokeWidth = (config.strokeWidth ?? 2) as number;
  const opacity = (config.opacity ?? 1) as number;
  const label = (config.label ?? '') as string;
  const widgetId = (config._widgetId ?? 'triangle-0') as string;
  const direction = ((config.direction as string) ?? 'up') as TriangleDirection;

  // Gradient and filter configs
  const fillGradient = (config.fillGradient as GradientConfig) ?? DEFAULT_GRADIENT;
  const filterConfig = (config.filter as SvgFilterConfig) ?? DEFAULT_FILTER;

  const useGradient = fillGradient.type !== 'none';
  const fillValue = useGradient
    ? `url(#${buildGradientId(widgetId, 'fill')})`
    : flatFill;

  const useFilter = filterConfig.type !== 'none';
  const filterAttr = useFilter ? `url(#${buildFilterId(widgetId)})` : undefined;

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

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const pointsStr = useMemo(
    () => computeTrianglePoints(width, height, strokeWidth, direction),
    [width, height, strokeWidth, direction],
  );

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={style}>
      <SvgGradientDefs
        widgetId={widgetId}
        fillGradient={fillGradient}
        filter={filterConfig}
      />
      <polygon
        points={pointsStr}
        fill={fillValue}
        fillOpacity={useGradient ? undefined : opacity}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        filter={filterAttr}
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

SvgTriangleRenderer.displayName = 'SvgTriangleRenderer';
export default memo(SvgTriangleRenderer);

/** Exported for unit testing */
export { computeTrianglePoints };
export type { TriangleDirection };
