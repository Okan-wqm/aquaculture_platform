/**
 * SliderRenderer - Horizontal slider with real range input + value display
 */

import React, { memo, useCallback } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import { Slider, colors } from '@aquaculture/shared-ui';

const SliderRenderer: React.FC<WidgetRendererProps> = ({
  config,
  value,
  width,
  height,
  isEditing,
  onCommand,
}) => {
  const label = (config.label ?? 'Slider') as string;
  const unit = (config.unit ?? '') as string;
  const min = (config.min ?? 0) as number;
  const max = (config.max ?? 100) as number;
  const raw = isEditing ? (config.demoValue ?? 50) : Number(value ?? min);
  const numValue =
    typeof raw === 'number' && !isNaN(raw)
      ? raw
      : typeof value === 'string'
        ? parseFloat(value as string)
        : 0;
  const safeValue = isNaN(numValue) ? 0 : numValue;

  const handleSliderChange = useCallback(
    (next: number) => {
      if (isEditing) return;
      onCommand?.('setValue', next);
    },
    [isEditing, onCommand],
  );

  return (
    <div style={{ width, height, padding: 8, boxSizing: 'border-box', position: 'relative' }}>
      {/* Label */}
      <div
        style={{
          textAlign: 'center',
          fontSize: 10,
          color: colors.gray[400],
          fontWeight: 500,
          marginBottom: 2,
        }}
      >
        {label}
      </div>

      {/* Range input */}
      <div className="px-4 py-2">
        <Slider
          aria-label={label}
          min={min}
          max={max}
          value={safeValue}
          onChange={handleSliderChange}
          disabled={isEditing}
        />
      </div>

      {/* Value display */}
      <div
        style={{ textAlign: 'center', fontSize: 12, fontWeight: 600, color: colors.neutral[900] }}
      >
        {safeValue.toFixed(1)} {unit}
      </div>
    </div>
  );
};

SliderRenderer.displayName = 'SliderRenderer';
export default memo(SliderRenderer);
