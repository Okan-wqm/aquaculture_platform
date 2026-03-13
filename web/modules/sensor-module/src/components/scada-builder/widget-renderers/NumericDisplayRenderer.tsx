/**
 * NumericDisplayRenderer - Large number + unit + label. NaN-safe.
 *
 * Features:
 * - Threshold-based text coloring (green / amber / red)
 * - Min/max range violation coloring
 * - Smooth CSS transition on color changes
 * - Background flash animation on significant value change
 * - Trend indicator arrow (up / down) vs previous value
 */

import React, { memo, useRef, useEffect, useState, useCallback } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

/* ------------------------------------------------------------------ */
/*  Threshold color helpers                                            */
/* ------------------------------------------------------------------ */

const COLOR_NORMAL   = '#22c55e'; // green
const COLOR_WARNING  = '#eab308'; // amber
const COLOR_CRITICAL = '#ef4444'; // red
const COLOR_DEFAULT  = '#111827'; // dark (no thresholds configured)

function getThresholdColor(
  value: number,
  warningThreshold?: number | null,
  criticalThreshold?: number | null,
  min?: number | null,
  max?: number | null,
): string {
  // Min/max range violation always shows red
  if (min != null && value < min) return COLOR_CRITICAL;
  if (max != null && value > max) return COLOR_CRITICAL;

  // If no thresholds configured, use default
  if (warningThreshold == null && criticalThreshold == null) return COLOR_DEFAULT;

  // Threshold-based coloring
  if (criticalThreshold != null && value >= criticalThreshold) return COLOR_CRITICAL;
  if (warningThreshold != null && value >= warningThreshold) return COLOR_WARNING;

  return COLOR_NORMAL;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const NumericDisplayRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const unit = (config.unit ?? '') as string;
  const label = (config.label ?? 'Value') as string;
  const decimals = (config.decimals ?? 1) as number;
  const raw = isEditing ? (config.demoValue ?? 25.4) : Number(value ?? 0);
  const numValue = typeof raw === 'number' && !isNaN(raw) ? raw : 0;
  const safeValue = isNaN(numValue) ? 0 : numValue;

  // Thresholds from config
  const warningThreshold = config.warningThreshold as number | undefined;
  const criticalThreshold = config.criticalThreshold as number | undefined;
  const min = config.min as number | undefined;
  const max = config.max as number | undefined;

  const textColor = getThresholdColor(safeValue, warningThreshold, criticalThreshold, min, max);

  // --- Trend indicator: track previous value ---
  const prevValueRef = useRef<number | null>(null);
  const [trend, setTrend] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    if (prevValueRef.current !== null && prevValueRef.current !== safeValue) {
      setTrend(safeValue > prevValueRef.current ? 'up' : 'down');
    }
    prevValueRef.current = safeValue;
  }, [safeValue]);

  // --- Flash animation on value change ---
  const [flashing, setFlashing] = useState(false);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerFlash = useCallback(() => {
    setFlashing(true);
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    flashTimeoutRef.current = setTimeout(() => setFlashing(false), 400);
  }, []);

  // Track whether the value actually changed (not the first render)
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    triggerFlash();
  }, [safeValue, triggerFlash]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    };
  }, []);

  const fontSize = Math.min(height * 0.4, 48);

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 8,
        boxSizing: 'border-box' as const,
        gap: 2,
        backgroundColor: flashing ? 'rgba(255,255,255,0.7)' : 'transparent',
        transition: 'background-color 0.4s ease-out',
      }}
    >
      <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </span>

      <span
        style={{
          fontSize,
          fontWeight: 700,
          color: textColor,
          lineHeight: 1,
          transition: 'color 0.5s ease',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {safeValue.toFixed(decimals)}
        {trend && (
          <span
            style={{
              fontSize: Math.max(fontSize * 0.35, 10),
              color: trend === 'up' ? '#22c55e' : '#ef4444',
              lineHeight: 1,
              fontWeight: 700,
            }}
          >
            {trend === 'up' ? '\u25B2' : '\u25BC'}
          </span>
        )}
      </span>

      {unit && (
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{unit}</span>
      )}
    </div>
  );
};

NumericDisplayRenderer.displayName = 'NumericDisplayRenderer';
export default memo(NumericDisplayRenderer);
