/**
 * SvgRectRenderer - SVG rectangle shape widget for SCADA screens
 *
 * Renders a configurable rectangle with fill, stroke, corner radius,
 * opacity, and optional label. Supports animation state for color,
 * rotation, blink, and visibility.
 *
 * Phase 6: Supports gradient fill and SVG filter effects via per-widget
 * <defs> blocks. When a gradient is active, it overrides the flat fill color.
 * Filter effects (blur, shadow, glow) are applied via SVG filter attribute.
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import SvgGradientDefs from '../widget-configs/SvgGradientDefs';
import type { GradientConfig, SvgFilterConfig } from '../../../types/scada-svg-properties.types';
import { DEFAULT_GRADIENT, DEFAULT_FILTER, buildGradientId, buildFilterId } from '../../../types/scada-svg-properties.types';

const SvgRectRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, animationState,
}) => {
  const flatFill = (animationState?.fill ?? config.fill ?? '#3b82f6') as string;
  const stroke = (animationState?.stroke ?? config.stroke ?? '#1d4ed8') as string;
  const strokeWidth = (config.strokeWidth ?? 2) as number;
  const rx = (config.cornerRadius ?? 0) as number;
  const opacity = (config.opacity ?? 1) as number;
  const label = (config.label ?? '') as string;
  const widgetId = (config._widgetId ?? 'rect-0') as string;

  // Gradient and filter configs -- fall back to defaults when absent
  const fillGradient = (config.fillGradient as GradientConfig) ?? DEFAULT_GRADIENT;
  const filterConfig = (config.filter as SvgFilterConfig) ?? DEFAULT_FILTER;

  // Determine the fill value: gradient URL takes precedence over flat color
  const useGradient = fillGradient.type !== 'none';
  const fillValue = useGradient
    ? `url(#${buildGradientId(widgetId, 'fill')})`
    : flatFill;

  // Determine whether to apply a filter
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

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={style}>
      <SvgGradientDefs
        widgetId={widgetId}
        fillGradient={fillGradient}
        filter={filterConfig}
      />
      <rect
        x={strokeWidth / 2}
        y={strokeWidth / 2}
        width={width - strokeWidth}
        height={height - strokeWidth}
        rx={rx}
        ry={rx}
        fill={fillValue}
        fillOpacity={useGradient ? undefined : opacity}
        stroke={stroke}
        strokeWidth={strokeWidth}
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

SvgRectRenderer.displayName = 'SvgRectRenderer';
export default memo(SvgRectRenderer);
