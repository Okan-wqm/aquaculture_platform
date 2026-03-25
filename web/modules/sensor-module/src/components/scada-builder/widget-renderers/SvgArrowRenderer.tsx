/**
 * SvgArrowRenderer - Solid arrow body shape for SCADA flow direction
 *
 * Renders a chevron-pointed arrow body as an SVG <polygon>. This is a
 * filled shape, not a line-based arrow marker. Configurable direction,
 * head width ratio, and body width ratio allow flexible arrow designs
 * suitable for process flow diagrams and P&ID overlays.
 *
 * Anatomy (right-pointing example):
 *   +--+           <- body top
 *   |  |\          <- head top
 *   |  | >         <- tip
 *   |  |/          <- head bottom
 *   +--+           <- body bottom
 *
 * Supports gradient fill and SVG filter effects via per-widget <defs>.
 */

import React, { memo, useMemo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import SvgGradientDefs from '../widget-configs/SvgGradientDefs';
import type { GradientConfig, SvgFilterConfig } from '../../../types/scada-svg-properties.types';
import { DEFAULT_GRADIENT, DEFAULT_FILTER, buildGradientId, buildFilterId } from '../../../types/scada-svg-properties.types';

type ArrowDirection = 'right' | 'left' | 'up' | 'down';

/**
 * Computes a 7-point arrow polygon for the given direction.
 * headWidthRatio: fraction of the short axis allocated to the arrowhead wings (0.3-1)
 * bodyWidthRatio: fraction of the short axis for the rectangular body (0.3-0.8)
 *
 * Returns SVG-compatible points string.
 */
function computeArrowPoints(
  width: number,
  height: number,
  strokeWidth: number,
  direction: ArrowDirection,
  headWidthRatio: number,
  bodyWidthRatio: number,
): string {
  const pad = strokeWidth / 2;
  const w = width - pad * 2;
  const h = height - pad * 2;

  // Normalize ratios
  const headR = Math.max(0.3, Math.min(1, headWidthRatio));
  const bodyR = Math.max(0.2, Math.min(0.8, bodyWidthRatio));

  // For horizontal arrows: body is the wider part, head is the pointed part
  // headFraction: how much of the length axis the arrowhead occupies
  const headFraction = headR * 0.5;

  if (direction === 'right' || direction === 'left') {
    const bodyHalf = (h * bodyR) / 2;
    const cy = h / 2;
    const headLen = w * headFraction;

    let points: Array<[number, number]>;

    if (direction === 'right') {
      const neckX = w - headLen;
      points = [
        [0, cy - bodyHalf],          // body top-left
        [neckX, cy - bodyHalf],      // body top-right (neck)
        [neckX, 0],                  // head top
        [w, cy],                     // tip
        [neckX, h],                  // head bottom
        [neckX, cy + bodyHalf],      // body bottom-right (neck)
        [0, cy + bodyHalf],          // body bottom-left
      ];
    } else {
      const neckX = headLen;
      points = [
        [w, cy - bodyHalf],          // body top-right
        [neckX, cy - bodyHalf],      // body top-left (neck)
        [neckX, 0],                  // head top
        [0, cy],                     // tip
        [neckX, h],                  // head bottom
        [neckX, cy + bodyHalf],      // body bottom-left (neck)
        [w, cy + bodyHalf],          // body bottom-right
      ];
    }

    return points.map(([x, y]) => `${(x + pad).toFixed(2)},${(y + pad).toFixed(2)}`).join(' ');
  }

  // Vertical arrows
  const bodyHalf = (w * bodyR) / 2;
  const cx = w / 2;
  const headLen = h * headFraction;

  let points: Array<[number, number]>;

  if (direction === 'down') {
    const neckY = h - headLen;
    points = [
      [cx - bodyHalf, 0],          // body top-left
      [cx + bodyHalf, 0],          // body top-right
      [cx + bodyHalf, neckY],      // body bottom-right (neck)
      [w, neckY],                  // head right
      [cx, h],                     // tip
      [0, neckY],                  // head left
      [cx - bodyHalf, neckY],      // body bottom-left (neck)
    ];
  } else {
    const neckY = headLen;
    points = [
      [cx - bodyHalf, h],          // body bottom-left
      [cx + bodyHalf, h],          // body bottom-right
      [cx + bodyHalf, neckY],      // body top-right (neck)
      [w, neckY],                  // head right
      [cx, 0],                     // tip
      [0, neckY],                  // head left
      [cx - bodyHalf, neckY],      // body top-left (neck)
    ];
  }

  return points.map(([x, y]) => `${(x + pad).toFixed(2)},${(y + pad).toFixed(2)}`).join(' ');
}

const SvgArrowRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, animationState,
}) => {
  const flatFill = (animationState?.fill ?? config.fill ?? '#6366f1') as string;
  const stroke = (animationState?.stroke ?? config.stroke ?? '#4f46e5') as string;
  const strokeWidth = (config.strokeWidth ?? 2) as number;
  const opacity = (config.opacity ?? 1) as number;
  const label = (config.label ?? '') as string;
  const widgetId = (config._widgetId ?? 'arrow-0') as string;
  const direction = ((config.direction as string) ?? 'right') as ArrowDirection;
  const headWidthRatio = (config.headWidthRatio as number) ?? 0.6;
  const bodyWidthRatio = (config.bodyWidthRatio as number) ?? 0.5;

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
    () => computeArrowPoints(width, height, strokeWidth, direction, headWidthRatio, bodyWidthRatio),
    [width, height, strokeWidth, direction, headWidthRatio, bodyWidthRatio],
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

SvgArrowRenderer.displayName = 'SvgArrowRenderer';
export default memo(SvgArrowRenderer);

/** Exported for unit testing */
export { computeArrowPoints };
export type { ArrowDirection };
