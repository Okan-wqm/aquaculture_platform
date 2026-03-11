/**
 * NumericDisplayRenderer - Large number + unit + label. NaN-safe.
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const NumericDisplayRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const unit = (config.unit ?? '') as string;
  const label = (config.label ?? 'Value') as string;
  const decimals = (config.decimals ?? 1) as number;
  const raw = isEditing ? (config.demoValue ?? 25.4) : Number(value ?? 0);
  const numValue = typeof raw === 'number' && !isNaN(raw) ? raw : 0;
  const safeValue = isNaN(numValue) ? 0 : numValue;

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
      }}
    >
      <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </span>
      <span style={{ fontSize: Math.min(height * 0.4, 48), fontWeight: 700, color: '#111827', lineHeight: 1 }}>
        {safeValue.toFixed(decimals)}
      </span>
      {unit && (
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{unit}</span>
      )}
    </div>
  );
};

NumericDisplayRenderer.displayName = 'NumericDisplayRenderer';
export default memo(NumericDisplayRenderer);
