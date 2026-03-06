/**
 * SliderRenderer - Horizontal slider with real range input + value display
 */

import React, { memo, useCallback } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const SliderRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing, onCommand }) => {
  const label = config.label ?? 'Slider';
  const unit = config.unit ?? '';
  const min = config.min ?? 0;
  const max = config.max ?? 100;
  const raw = isEditing ? (config.demoValue ?? 50) : Number(value ?? min);
  const numValue = typeof raw === 'number' && !isNaN(raw) ? raw : (typeof value === 'string' ? parseFloat(value as string) : 0);
  const safeValue = isNaN(numValue) ? 0 : numValue;

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (isEditing) return;
    onCommand?.('setValue', Number(e.target.value));
  }, [isEditing, onCommand]);

  return (
    <div style={{ width, height, padding: 8, boxSizing: 'border-box', position: 'relative' }}>
      {/* Label */}
      <div style={{ textAlign: 'center', fontSize: 10, color: '#6b7280', fontWeight: 500, marginBottom: 2 }}>
        {label}
      </div>

      {/* Range input */}
      <div style={{ padding: '8px 16px' }}>
        <input
          type="range"
          min={min}
          max={max}
          value={safeValue}
          onChange={handleChange}
          disabled={isEditing}
          className="w-full"
          style={{ width: '100%', cursor: isEditing ? 'default' : 'pointer' }}
        />
      </div>

      {/* Value display */}
      <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 600, color: '#111827' }}>
        {safeValue.toFixed(1)} {unit}
      </div>
    </div>
  );
};

SliderRenderer.displayName = 'SliderRenderer';
export default memo(SliderRenderer);
