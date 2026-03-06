/**
 * SliderRenderer - Horizontal slider + value display
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const SliderRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const label = config.label ?? 'Slider';
  const unit = config.unit ?? '';
  const min = config.min ?? 0;
  const max = config.max ?? 100;
  const numericValue = isEditing ? (config.demoValue ?? 50) : Number(value ?? min);
  const pct = Math.max(0, Math.min(1, (numericValue - min) / (max - min || 1)));

  const trackPadX = 16;
  const trackY = height * 0.45;
  const trackW = width - trackPadX * 2;
  const thumbX = trackPadX + trackW * pct;

  return (
    <div style={{ width, height, position: 'relative', padding: '6px 0' }}>
      {/* Label */}
      <div style={{ textAlign: 'center', fontSize: 10, color: '#6b7280', fontWeight: 500, marginBottom: 2 }}>
        {label}
      </div>

      <svg width={width} height={height * 0.5} style={{ display: 'block' }}>
        {/* Track background */}
        <rect x={trackPadX} y={trackY * 0.35} width={trackW} height={6} rx={3} fill="#e5e7eb" />
        {/* Track fill */}
        <rect x={trackPadX} y={trackY * 0.35} width={trackW * pct} height={6} rx={3} fill="#3b82f6" />
        {/* Thumb */}
        <circle cx={thumbX} cy={trackY * 0.35 + 3} r={8} fill="#3b82f6" stroke="white" strokeWidth={2} />
      </svg>

      {/* Value display */}
      <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 600, color: '#111827' }}>
        {numericValue.toFixed(1)} {unit}
      </div>
    </div>
  );
};

SliderRenderer.displayName = 'SliderRenderer';
export default memo(SliderRenderer);
