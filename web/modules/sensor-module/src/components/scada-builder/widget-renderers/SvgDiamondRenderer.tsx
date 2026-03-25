/**
 * SvgDiamondRenderer - Diamond/rhombus shape for SCADA screens
 *
 * Renders an SVG <polygon> with 4 points at the midpoints of each edge,
 * forming a diamond (rotated square). Commonly used in flowcharts and
 * P&ID diagrams as decision nodes.
 *
 * Supports gradient fill and SVG filter effects via per-widget <defs>.
 */

import React, { memo, useMemo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import SvgGradientDefs from '../widget-configs/SvgGradientDefs';
import type { GradientConfig, SvgFilterConfig } from '../../../types/scada-svg-properties.types';
import { DEFAULT_GRADIENT, DEFAULT_FILTER, buildGradientId, buildFilterId } from '../../../types/scada-svg-properties.types';

/**
 * Computes diamond vertices from the bounding box midpoints.
 * Returns top, right, bottom, left in SVG points format.
 */
function computeDiamondPoints(
  width: number,
  height: number,
  strokeWidth: number,
): string {
  const pad = strokeWidth / 2;
  const mx = width / 2;
  const my = height / 2;
  return `${mx},${pad} ${width - pad},${my} ${mx},${height - pad} ${pad},${my}`;
}

const SvgDiamondRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, animationState,
}) => {
  const flatFill = (animationState?.fill ?? config.fill ?? '#f59e0b') as string;
  const stroke = (animationState?.stroke ?? config.stroke ?? '#d97706') as string;
  const strokeWidth = (config.strokeWidth ?? 2) as number;
  const opacity = (config.opacity ?? 1) as number;
  const label = (config.label ?? '') as string;
  const widgetId = (config._widgetId ?? 'diamond-0') as string;

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
    () => computeDiamondPoints(width, height, strokeWidth),
    [width, height, strokeWidth],
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
          fontSize={Math.min(width, height) * 0.13}
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

SvgDiamondRenderer.displayName = 'SvgDiamondRenderer';
export default memo(SvgDiamondRenderer);

/** Exported for unit testing */
export { computeDiamondPoints };
