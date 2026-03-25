/**
 * SvgCircleRenderer - SVG circle / ellipse shape widget for SCADA screens
 *
 * Renders a circle when width === height, otherwise an ellipse.
 * Supports fill, stroke, opacity, label, and animation state for
 * color, rotation, blink, visibility, fill level, and recursive color.
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

const SvgCircleRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, animationState,
}) => {
  const stroke = (animationState?.stroke ?? config.stroke ?? '#1d4ed8') as string;
  const strokeWidth = (config.strokeWidth ?? 2) as number;
  const opacity = (config.opacity ?? 1) as number;
  const label = (config.label ?? '') as string;
  const widgetId = (config._widgetId ?? 'circle-0') as string;

  // Gradient and filter configs
  const fillGradient = (config.fillGradient as GradientConfig) ?? DEFAULT_GRADIENT;
  const filterConfig = (config.filter as SvgFilterConfig) ?? DEFAULT_FILTER;

  // Recursive color CSS variable consumption -- higher priority than config, lower than animationState.fill
  const cssVarFill = animationState?.cssVariables?.['--scada-fill'];
  const cssVarStroke = animationState?.cssVariables?.['--scada-stroke'];
  const flatFill = (animationState?.fill ?? cssVarFill ?? config.fill ?? '#3b82f6') as string;
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

  const useGradient = fillGradient.type !== 'none';
  let fillValue: string;
  if (hasColorBlink) {
    fillValue = blinkPhase
      ? (animationState?.blinkFillB as string)
      : (animationState?.blinkFillA as string);
  } else if (useGradient) {
    fillValue = `url(#${buildGradientId(widgetId, 'fill')})`;
  } else {
    fillValue = flatFill;
  }

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
  if (animationState?.blinking && !hasColorBlink) {
    style.animation = `scada-blink ${animationState.blinkInterval}ms ease-in-out infinite`;
  }

  const cx = width / 2;
  const cy = height / 2;
  const rx = (width - strokeWidth) / 2;
  const ry = (height - strokeWidth) / 2;

  // Fill level visualization using clipPath for circular shapes
  const fillPercent = animationState?.fillPercent;
  const hasFillLevel = fillPercent !== undefined && fillPercent !== null;
  const fillLevelColor = (animationState?.fillColor ?? 'rgba(59, 130, 246, 0.5)') as string;
  const clipId = `fill-clip-${widgetId}`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={style}>
      <SvgGradientDefs
        widgetId={widgetId}
        fillGradient={fillGradient}
        filter={filterConfig}
      />

      {/* ClipPath for fill level -- restricts to bottom percentage of bounding box */}
      {hasFillLevel && (
        <defs>
          <clipPath id={clipId}>
            <rect
              x={0}
              y={height * (1 - (fillPercent / 100))}
              width={width}
              height={height * (fillPercent / 100)}
            />
          </clipPath>
        </defs>
      )}

      {/* Fill level overlay -- ellipse clipped to fill percentage */}
      {hasFillLevel && (
        <ellipse
          cx={cx}
          cy={cy}
          rx={rx}
          ry={ry}
          fill={fillLevelColor}
          clipPath={`url(#${clipId})`}
          data-testid="fill-level-overlay"
        />
      )}

      <ellipse
        cx={cx}
        cy={cy}
        rx={rx}
        ry={ry}
        fill={fillValue}
        fillOpacity={useGradient ? undefined : (hasFillLevel ? 0.3 : opacity)}
        stroke={effectiveStroke}
        strokeWidth={strokeWidth}
        filter={filterAttr}
      />
      {label && (
        <text
          x={cx}
          y={cy}
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

SvgCircleRenderer.displayName = 'SvgCircleRenderer';
export default memo(SvgCircleRenderer);
