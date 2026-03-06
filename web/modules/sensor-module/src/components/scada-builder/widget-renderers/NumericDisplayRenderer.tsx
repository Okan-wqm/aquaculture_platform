/**
 * NumericDisplayRenderer - Large number + unit + label
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const NumericDisplayRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const unit = config.unit ?? '';
  const label = config.label ?? 'Value';
  const decimals = config.decimals ?? 1;
  const numericValue = isEditing ? (config.demoValue ?? 25.4) : Number(value ?? 0);

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
        gap: 2,
      }}
    >
      <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </span>
      <span style={{ fontSize: Math.min(height * 0.4, 48), fontWeight: 700, color: '#111827', lineHeight: 1 }}>
        {numericValue.toFixed(decimals)}
      </span>
      {unit && (
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{unit}</span>
      )}
    </div>
  );
};

NumericDisplayRenderer.displayName = 'NumericDisplayRenderer';
export default memo(NumericDisplayRenderer);
