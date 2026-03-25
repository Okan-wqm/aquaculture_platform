/**
 * SVG Path/Polyline renderer -- renders arbitrary paths from an array of
 * PathPoints supporting line, quadratic, and cubic bezier segments.
 * The path d-attribute is computed via buildPathD() and memoized.
 *
 * When no points are provided (or fewer than 2), a dashed placeholder
 * rectangle is shown in edit mode to guide the user to draw a path.
 *
 * Phase 7A: Added SvgGradientDefs rendering (was missing -- gradient
 * config existed in SvgPathConfig but the renderer never consumed it),
 * SVG filter support, color-alternating blink, and recursiveColor
 * CSS variable consumption.
 */

import React, { memo, useMemo, useState, useEffect } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import { buildPathD, type PathPoint } from '../../../types/scada-path.types';
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

const SvgPathRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, isEditing, animationState,
}) => {
  const points = (config.points ?? []) as PathPoint[];
  const closed = (config.closed ?? false) as boolean;
  const stroke = (animationState?.stroke ?? config.stroke ?? '#1d4ed8') as string;
  const strokeWidth = (config.strokeWidth ?? 2) as number;
  const fillOpacity = (config.fillOpacity ?? 1) as number;
  const strokeOpacity = (config.strokeOpacity ?? 1) as number;
  const dashPattern = (config.dashPattern ?? 'solid') as StrokeDashPattern;
  const lineCap = (config.lineCap ?? 'round') as StrokeLineCap;
  const lineJoin = (config.lineJoin ?? 'round') as StrokeLineJoin;
  const widgetId = (config._widgetId ?? 'path-0') as string;

  // Gradient and filter configs
  const fillGradient = (config.fillGradient as GradientConfig) ?? DEFAULT_GRADIENT;
  const filterConfig = (config.filter as SvgFilterConfig) ?? DEFAULT_FILTER;

  // Recursive color CSS variable consumption
  const cssVarFill = animationState?.cssVariables?.['--scada-fill'];
  const cssVarStroke = animationState?.cssVariables?.['--scada-stroke'];
  const configFill = (animationState?.fill ?? cssVarFill ?? config.fill ?? 'none') as string;
  const effectiveStroke = cssVarStroke ?? stroke;

  // Color-alternating blink state
  const hasColorBlink = Boolean(
    animationState?.blinking &&
    animationState?.blinkFillA &&
    animationState?.blinkFillB,
  );
  const [blinkPhase, setBlinkPhase] = useState(false);

  useEffect(() => {
    if (!hasColorBlink || !animationState) return;
    const interval = setInterval(() => {
      setBlinkPhase((prev) => !prev);
    }, (animationState.blinkInterval ?? 1000) / 2);
    return () => clearInterval(interval);
  }, [hasColorBlink, animationState?.blinkInterval, animationState]);

  // Determine fill value considering gradient and blink
  const useGradient = closed && fillGradient.type !== 'none';
  let fillValue: string;
  if (hasColorBlink && closed) {
    fillValue = blinkPhase
      ? (animationState?.blinkFillB as string)
      : (animationState?.blinkFillA as string);
  } else if (useGradient) {
    fillValue = `url(#${buildGradientId(widgetId, 'fill')})`;
  } else {
    fillValue = closed ? configFill : 'none';
  }

  const useFilter = filterConfig.type !== 'none';
  const filterAttr = useFilter ? `url(#${buildFilterId(widgetId)})` : undefined;

  // Memoize the d-attribute to avoid recomputing on every render
  const pathD = useMemo(() => buildPathD(points, closed), [points, closed]);

  // Visibility from animation
  if (animationState && !animationState.visible) {
    return <div style={{ width, height, opacity: 0 }} />;
  }

  // Show placeholder when insufficient points
  if (!pathD) {
    if (!isEditing) {
      // Nothing to show in runtime mode
      return <div style={{ width, height }} />;
    }
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <rect
          x={4}
          y={4}
          width={width - 8}
          height={height - 8}
          fill="none"
          stroke="#d1d5db"
          strokeWidth={2}
          strokeDasharray="6 4"
          rx={6}
        />
        <text
          x={width / 2}
          y={height / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={12}
          fill="#9ca3af"
          fontFamily="sans-serif"
        >
          Draw path
        </text>
      </svg>
    );
  }

  // Animation styles
  const style: React.CSSProperties = {};
  if (animationState?.rotating) {
    const dir = animationState.rotationDirection === 'ccw' ? 'reverse' : 'normal';
    style.animation = `scada-rotate ${animationState.rotationSpeed}ms linear infinite ${dir}`;
    style.transformOrigin = 'center center';
  }
  if (animationState?.blinking && !hasColorBlink) {
    style.animation = `scada-blink ${animationState.blinkInterval}ms ease-in-out infinite`;
  }

  const dashArrayValue = DASH_PATTERN_MAP[dashPattern] || '';

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={style}>
      {/* Gradient and filter definitions -- was missing before Phase 7A */}
      <SvgGradientDefs
        widgetId={widgetId}
        fillGradient={closed ? fillGradient : undefined}
        filter={filterConfig}
      />
      <path
        d={pathD}
        fill={fillValue}
        fillOpacity={closed ? (useGradient ? undefined : fillOpacity) : undefined}
        stroke={effectiveStroke}
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
        strokeDasharray={dashArrayValue || undefined}
        strokeLinecap={lineCap}
        strokeLinejoin={lineJoin}
        filter={filterAttr}
      />
    </svg>
  );
};

SvgPathRenderer.displayName = 'SvgPathRenderer';
export default memo(SvgPathRenderer);
