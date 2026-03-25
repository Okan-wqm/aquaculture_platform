/**
 * SvgRectRenderer - SVG rectangle shape widget for SCADA screens
 *
 * Renders a configurable rectangle with fill, stroke, corner radius,
 * opacity, and optional label. Supports animation state for color,
 * rotation, blink, visibility, fill level, and recursive color.
 *
 * Phase 6: Supports gradient fill and SVG filter effects via per-widget
 * <defs> blocks. When a gradient is active, it overrides the flat fill color.
 *
 * Phase 7A: Added three critical animation rendering fixes:
 * 1. fillLevel visualization using SVG clipPath from bottom
 * 2. Color-alternating blink (industrial standard) with opacity fallback
 * 3. recursiveColor CSS variable consumption as fill override
 */

import React, { memo, useState, useEffect } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import SvgGradientDefs from '../widget-configs/SvgGradientDefs';
import type { GradientConfig, SvgFilterConfig } from '../../../types/scada-svg-properties.types';
import { DEFAULT_GRADIENT, DEFAULT_FILTER, buildGradientId, buildFilterId } from '../../../types/scada-svg-properties.types';

const SvgRectRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, animationState,
}) => {
  const stroke = (animationState?.stroke ?? config.stroke ?? '#1d4ed8') as string;
  const strokeWidth = (config.strokeWidth ?? 2) as number;
  const rx = (config.cornerRadius ?? 0) as number;
  const opacity = (config.opacity ?? 1) as number;
  const label = (config.label ?? '') as string;
  const widgetId = (config._widgetId ?? 'rect-0') as string;

  // Gradient and filter configs -- fall back to defaults when absent
  const fillGradient = (config.fillGradient as GradientConfig) ?? DEFAULT_GRADIENT;
  const filterConfig = (config.filter as SvgFilterConfig) ?? DEFAULT_FILTER;

  /**
   * Recursive color animation sets CSS custom properties that cascade
   * to all SVG children. For built-in shapes, we read the CSS variable
   * values directly from animationState.cssVariables and apply them
   * as fill/stroke overrides. This avoids the need for shapes to
   * reference var(--scada-fill) in their SVG markup.
   *
   * Priority: animationState.fill > cssVariables > config.fill
   */
  const cssVarFill = animationState?.cssVariables?.['--scada-fill'];
  const cssVarStroke = animationState?.cssVariables?.['--scada-stroke'];
  const flatFill = (animationState?.fill ?? cssVarFill ?? config.fill ?? '#3b82f6') as string;
  const effectiveStroke = cssVarStroke ?? stroke;

  /**
   * SCADA blink animation alternates between two configured fill/stroke
   * colors at a specified interval. This replaces the previous opacity
   * fade which discards the user's configured blink colors.
   *
   * When blinkFillA/B are set, the renderer alternates between them.
   * When they are NOT set, fall back to opacity blink (backward compat).
   */
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

  // Determine the fill value: gradient URL takes precedence over flat color
  const useGradient = fillGradient.type !== 'none';
  let fillValue: string;
  if (hasColorBlink) {
    // Color-alternating blink overrides all other fill sources
    fillValue = blinkPhase
      ? (animationState?.blinkFillB as string)
      : (animationState?.blinkFillA as string);
  } else if (useGradient) {
    fillValue = `url(#${buildGradientId(widgetId, 'fill')})`;
  } else {
    fillValue = flatFill;
  }

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
  // Opacity blink fallback: only when color blink is NOT configured
  if (animationState?.blinking && !hasColorBlink) {
    style.animation = `scada-blink ${animationState.blinkInterval}ms ease-in-out infinite`;
  }

  /**
   * Fill level visualization using SVG clipPath.
   * A rectangle clipped from the bottom of the shape represents the
   * fill percentage -- commonly used for tank levels, silo contents,
   * and any capacity indicator rendered as an SVG shape.
   *
   * The fill level rect uses animationState.fillColor (defaulting to
   * a semi-transparent blue) and its height is proportional to fillPercent.
   */
  const fillPercent = animationState?.fillPercent;
  const hasFillLevel = fillPercent !== undefined && fillPercent !== null;
  const fillLevelColor = (animationState?.fillColor ?? 'rgba(59, 130, 246, 0.5)') as string;
  const clipId = `fill-clip-${widgetId}`;

  // Compute inner rect dimensions (accounting for stroke)
  const innerX = strokeWidth / 2;
  const innerY = strokeWidth / 2;
  const innerW = width - strokeWidth;
  const innerH = height - strokeWidth;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={style}>
      <SvgGradientDefs
        widgetId={widgetId}
        fillGradient={fillGradient}
        filter={filterConfig}
      />

      {/* ClipPath definition for fill level -- clips to bottom percentage */}
      {hasFillLevel && (
        <defs>
          <clipPath id={clipId}>
            <rect
              x={innerX}
              y={innerY + innerH * (1 - (fillPercent / 100))}
              width={innerW}
              height={innerH * (fillPercent / 100)}
              rx={rx}
              ry={rx}
            />
          </clipPath>
        </defs>
      )}

      {/* Fill level overlay -- rendered behind the main shape stroke */}
      {hasFillLevel && (
        <rect
          x={innerX}
          y={innerY}
          width={innerW}
          height={innerH}
          rx={rx}
          ry={rx}
          fill={fillLevelColor}
          clipPath={`url(#${clipId})`}
          data-testid="fill-level-overlay"
        />
      )}

      <rect
        x={innerX}
        y={innerY}
        width={innerW}
        height={innerH}
        rx={rx}
        ry={rx}
        fill={fillValue}
        fillOpacity={useGradient ? undefined : (hasFillLevel ? 0.3 : opacity)}
        stroke={effectiveStroke}
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
          fill={effectiveStroke}
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
