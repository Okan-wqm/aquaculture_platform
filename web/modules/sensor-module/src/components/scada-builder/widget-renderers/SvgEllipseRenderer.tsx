/**
 * SVG Ellipse renderer -- renders an ellipse with configurable fill, stroke,
 * dash pattern, line cap/join, and per-color opacity.
 * Uses SVG <ellipse> element with rx/ry computed from widget dimensions.
 *
 * Separated from SvgCircleRenderer because the circle widget always uses
 * equal rx/ry and lacks dash-pattern / line-cap controls. This widget
 * exposes full SVG stroke styling for technical diagrams.
 *
 * Phase 6: Supports gradient fill and SVG filter effects via per-widget
 * <defs> blocks. When a gradient is active, it overrides the flat fill color.
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import SvgGradientDefs from '../widget-configs/SvgGradientDefs';
import type { GradientConfig, SvgFilterConfig } from '../../../types/scada-svg-properties.types';
import {
  DASH_PATTERN_MAP,
  DEFAULT_GRADIENT,
  DEFAULT_FILTER,
  buildGradientId,
  buildFilterId,
  type StrokeDashPattern,
  type StrokeLineCap,
  type StrokeLineJoin,
} from '../../../types/scada-svg-properties.types';

const SvgEllipseRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, animationState,
}) => {
  const flatFill = (animationState?.fill ?? config.fill ?? '#3b82f6') as string;
  const stroke = (animationState?.stroke ?? config.stroke ?? '#1d4ed8') as string;
  const strokeWidth = (config.strokeWidth ?? 2) as number;
  const fillOpacity = (config.fillOpacity ?? 1) as number;
  const strokeOpacity = (config.strokeOpacity ?? 1) as number;
  const dashPattern = (config.dashPattern ?? 'solid') as StrokeDashPattern;
  const lineCap = (config.lineCap ?? 'butt') as StrokeLineCap;
  const lineJoin = (config.lineJoin ?? 'miter') as StrokeLineJoin;
  const label = (config.label ?? '') as string;
  const widgetId = (config._widgetId ?? 'ellipse-0') as string;

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
  const rx = (width - strokeWidth) / 2;
  const ry = (height - strokeWidth) / 2;

  const dashArrayValue = DASH_PATTERN_MAP[dashPattern] || '';

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={style}>
      <SvgGradientDefs
        widgetId={widgetId}
        fillGradient={fillGradient}
        filter={filterConfig}
      />
      <ellipse
        cx={cx}
        cy={cy}
        rx={Math.max(0, rx)}
        ry={Math.max(0, ry)}
        fill={fillValue}
        fillOpacity={useGradient ? undefined : fillOpacity}
        stroke={stroke}
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
        strokeDasharray={dashArrayValue || undefined}
        strokeLinecap={lineCap}
        strokeLinejoin={lineJoin}
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

SvgEllipseRenderer.displayName = 'SvgEllipseRenderer';
export default memo(SvgEllipseRenderer);
