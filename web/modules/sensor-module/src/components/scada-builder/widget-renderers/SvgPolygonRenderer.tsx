/**
 * SvgPolygonRenderer - Regular polygon shape for SCADA screens
 *
 * Generates an SVG <polygon> programmatically from center, radius, and
 * side count. Supports 3-12 sides and an optional star mode that
 * alternates between outer and inner radius to create star shapes.
 *
 * Point calculation:
 *   for i in 0..sides:
 *     angle = 2*PI*i/sides - PI/2   (start from top)
 *     x = cx + r * cos(angle)
 *     y = cy + r * sin(angle)
 *
 * Star mode interleaves outer and inner radius vertices, producing
 * 2*sides points total (e.g. 5-sided star = 10 vertices).
 *
 * Supports gradient fill and SVG filter effects via per-widget <defs>.
 */

import React, { memo, useMemo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import SvgGradientDefs from '../widget-configs/SvgGradientDefs';
import type { GradientConfig, SvgFilterConfig } from '../../../types/scada-svg-properties.types';
import { DEFAULT_GRADIENT, DEFAULT_FILTER, buildGradientId, buildFilterId } from '../../../types/scada-svg-properties.types';

/**
 * Computes regular polygon vertices within a width x height box using the
 * box center, radius, and side count. Returns an SVG-compatible points string.
 *
 * When starMode is true, vertices alternate between outerRadius and
 * innerRadius * outerRadius, doubling the total vertex count.
 */
function computePolygonPoints(
  width: number,
  height: number,
  outerRadius: number,
  sides: number,
  starMode: boolean,
  innerRadiusRatio: number,
): string {
  const points: string[] = [];
  const totalVertices = starMode ? sides * 2 : sides;
  const cx = width / 2;
  const cy = height / 2;

  for (let i = 0; i < totalVertices; i++) {
    const angle = (2 * Math.PI * i) / totalVertices - Math.PI / 2;
    // In star mode, even indices use outer radius, odd indices use inner
    const r = starMode && i % 2 === 1
      ? outerRadius * innerRadiusRatio
      : outerRadius;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }

  return points.join(' ');
}

const SvgPolygonRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, animationState,
}) => {
  const flatFill = (animationState?.fill ?? config.fill ?? '#3b82f6') as string;
  const stroke = (animationState?.stroke ?? config.stroke ?? '#1d4ed8') as string;
  const strokeWidth = (config.strokeWidth ?? 2) as number;
  const opacity = (config.opacity ?? 1) as number;
  const label = (config.label ?? '') as string;
  const widgetId = (config._widgetId ?? 'polygon-0') as string;
  const sides = Math.max(3, Math.min(12, (config.sides as number) ?? 6));
  const starMode = (config.starMode as boolean) ?? false;
  const innerRadiusRatio = Math.max(0.1, Math.min(0.9, (config.innerRadius as number) ?? 0.5));

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

  const cx = width / 2;
  const cy = height / 2;
  const outerRadius = Math.min(width, height) / 2 - strokeWidth;

  // Memoize points string to avoid recomputation on every render
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const pointsStr = useMemo(
    () => computePolygonPoints(width, height, outerRadius, sides, starMode, innerRadiusRatio),
    [width, height, outerRadius, sides, starMode, innerRadiusRatio],
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

SvgPolygonRenderer.displayName = 'SvgPolygonRenderer';
export default memo(SvgPolygonRenderer);

/** Exported for unit testing -- computes polygon point coordinates */
export { computePolygonPoints };
