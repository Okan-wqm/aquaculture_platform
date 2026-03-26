/**
 * ProgressBarRenderer - Horizontal linear progress bar for SCADA screens.
 *
 * Simpler than TankLevel -- designed for compact inline indicators
 * showing percentage completion, fill levels, or process progress.
 *
 * Features:
 * - Configurable color zones (green/yellow/red ranges) via
 *   the RangeColorMapping system. Each zone defines a value range
 *   and associated color; the first matching zone wins.
 * - Smooth CSS transition on value changes for visual continuity.
 * - Optional percentage label positioned inside, above, or below the bar.
 * - Min/max range mapping: raw tag value is normalized to 0-100%.
 *
 * Performance: Pure CSS rendering with no canvas or SVG overhead.
 * The transition property is hardware-accelerated (width transform).
 */

import React, { memo, useMemo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ColorZone {
  min: number;
  max: number;
  color: string;
}

type LabelPosition = 'inside' | 'above' | 'below';

/* ------------------------------------------------------------------ */
/*  Zone color resolution                                              */
/* ------------------------------------------------------------------ */

/**
 * Resolves the fill color based on the current percentage value.
 * Evaluates zones in order -- first matching zone wins. Falls back
 * to the default fillColor if no zone matches. This ordering allows
 * operators to define escalating severity thresholds.
 */
function resolveZoneColor(
  percent: number,
  zones: ColorZone[],
  defaultColor: string,
): string {
  for (const zone of zones) {
    if (percent >= zone.min && percent <= zone.max) {
      return zone.color;
    }
  }
  return defaultColor;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const ProgressBarRenderer: React.FC<WidgetRendererProps> = ({
  config,
  value,
  width,
  height,
  isEditing,
}) => {
  const tagName = (config.tagName ?? '') as string;
  const min = (config.min ?? 0) as number;
  const max = (config.max ?? 100) as number;
  const showLabel = (config.showLabel ?? true) as boolean;
  const showPercentage = (config.showPercentage ?? true) as boolean;
  const barHeight = (config.height ?? 24) as number;
  const backgroundColor = (config.backgroundColor ?? '#e5e7eb') as string;
  const fillColor = (config.fillColor ?? '#3b82f6') as string;
  const zones = (config.zones ?? []) as ColorZone[];
  const borderRadius = (config.borderRadius ?? 4) as number;
  const labelPosition = (config.labelPosition ?? 'inside') as LabelPosition;
  const label = (config.label ?? tagName) as string;

  // Resolve raw value: in edit mode use a demo value, in runtime use the tag value
  const rawValue = isEditing
    ? (config.demoValue ?? 65) as number
    : (typeof value === 'number' ? value : Number(value ?? 0));
  const safeValue = isNaN(rawValue) ? 0 : rawValue;

  // Normalize to percentage
  const range = max - min || 1; // Prevent division by zero
  const percent = Math.max(0, Math.min(100, ((safeValue - min) / range) * 100));

  // Resolve the active fill color from zone definitions
  const activeFillColor = useMemo(
    () => resolveZoneColor(percent, zones, fillColor),
    [percent, zones, fillColor],
  );

  const percentText = `${Math.round(percent)}%`;

  // Label font size proportional to bar height, with sensible bounds
  const labelFontSize = Math.max(9, Math.min(14, barHeight * 0.55));

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: 8,
        boxSizing: 'border-box',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
      data-testid="progress-bar-widget"
    >
      {/* Label above the bar */}
      {showLabel && labelPosition === 'above' && (
        <div
          style={{
            fontSize: labelFontSize,
            color: '#374151',
            marginBottom: 4,
            fontWeight: 500,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
          }}
        >
          <span data-testid="progress-label">{label}</span>
          {showPercentage && (
            <span style={{ fontSize: labelFontSize - 1, color: '#6b7280' }} data-testid="progress-percent">
              {percentText}
            </span>
          )}
        </div>
      )}

      {/* Progress bar track */}
      <div
        style={{
          width: '100%',
          height: barHeight,
          backgroundColor,
          borderRadius,
          overflow: 'hidden',
          position: 'relative',
          flexShrink: 0,
        }}
        data-testid="progress-track"
      >
        {/* Fill bar */}
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            backgroundColor: activeFillColor,
            borderRadius,
            transition: 'width 0.4s ease, background-color 0.3s ease',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            paddingRight: percent > 15 ? 6 : 0,
            boxSizing: 'border-box',
            minWidth: 0,
          }}
          data-testid="progress-fill"
        />

        {/* Inside label: rendered as an overlay on the track */}
        {showLabel && labelPosition === 'inside' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: labelFontSize,
              fontWeight: 600,
              // Use contrasting text color based on fill percentage
              color: percent > 50 ? '#ffffff' : '#374151',
              pointerEvents: 'none',
              textShadow: percent > 50 ? '0 1px 2px rgba(0,0,0,0.2)' : 'none',
            }}
            data-testid="progress-inside-label"
          >
            {showPercentage ? percentText : label}
          </div>
        )}
      </div>

      {/* Label below the bar */}
      {showLabel && labelPosition === 'below' && (
        <div
          style={{
            fontSize: labelFontSize,
            color: '#374151',
            marginTop: 4,
            fontWeight: 500,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
          }}
        >
          <span data-testid="progress-label">{label}</span>
          {showPercentage && (
            <span style={{ fontSize: labelFontSize - 1, color: '#6b7280' }} data-testid="progress-percent">
              {percentText}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

ProgressBarRenderer.displayName = 'ProgressBarRenderer';
export default memo(ProgressBarRenderer);
