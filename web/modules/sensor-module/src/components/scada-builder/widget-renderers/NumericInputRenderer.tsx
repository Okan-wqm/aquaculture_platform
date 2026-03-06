/**
 * NumericInputRenderer - Input field + unit (disabled in edit mode)
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const NumericInputRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const label = config.label ?? 'Setpoint';
  const unit = config.unit ?? '';
  const numericValue = isEditing ? (config.demoValue ?? 7.2) : Number(value ?? 0);

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        padding: 8,
      }}
    >
      <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 500 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          type="text"
          readOnly
          disabled={isEditing}
          value={numericValue.toFixed(config.decimals ?? 1)}
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
