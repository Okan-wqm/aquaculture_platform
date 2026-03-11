/**
 * NumericInputRenderer - Input field + unit with onCommand support
 */

import React, { memo, useCallback } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const NumericInputRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing, onCommand }) => {
  const label = (config.label ?? 'Setpoint') as string;
  const unit = (config.unit ?? '') as string;
  const raw = isEditing ? (config.demoValue ?? 7.2) : Number(value ?? 0);
  const numValue = typeof raw === 'number' && !isNaN(raw) ? raw : 0;
  const safeValue = isNaN(numValue) ? 0 : numValue;

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (isEditing) return;
    const parsed = parseFloat(e.target.value);
    if (!isNaN(parsed)) {
      onCommand?.('setValue', parsed);
    }
  }, [isEditing, onCommand]);

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: 8,
        boxSizing: 'border-box' as const,
      }}
    >
      <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 500 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          type="text"
          readOnly={isEditing}
          disabled={isEditing}
          value={safeValue.toFixed((config.decimals ?? 1) as number)}
          onChange={handleChange}
          style={{
            width: Math.max(60, width * 0.5),
            height: 28,
            textAlign: 'center',
            fontSize: 16,
            fontWeight: 600,
            border: '1px solid #d1d5db',
            borderRadius: 4,
            background: isEditing ? '#f9fafb' : '#ffffff',
            color: '#111827',
            outline: 'none',
          }}
        />
        {unit && <span style={{ fontSize: 12, color: '#6b7280' }}>{unit}</span>}
      </div>
    </div>
  );
};

NumericInputRenderer.displayName = 'NumericInputRenderer';
export default memo(NumericInputRenderer);
