/**
 * PushButtonRenderer - Large button visual + label with onCommand
 * Provides dramatic tactile feedback: color shift, scale, glow, and LED indicator.
 */

import React, { memo, useCallback } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const PushButtonRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing, onCommand }) => {
  const label = (config.label ?? 'START') as string;
  const color = (config.color ?? '#3b82f6') as string;
  const pressed = isEditing ? false : Boolean(value);

  const btnSize = Math.min(width * 0.6, height * 0.55, 80);
  const ledSize = Math.max(8, btnSize * 0.14);

  const handlePress = useCallback(() => {
    if (isEditing) return;
    onCommand?.('press', true);
  }, [isEditing, onCommand]);

  return (
    <div
      style={{
        width,
        height,
        padding: 8,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <div
        onClick={handlePress}
        style={{
          position: 'relative',
          width: btnSize,
          height: btnSize,
          borderRadius: 8,
          background: pressed ? '#22c55e' : color,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: pressed
            ? 'inset 0 3px 6px rgba(0,0,0,0.35), 0 0 12px rgba(34,197,94,0.5)'
            : `0 4px 8px rgba(0,0,0,0.25), 0 1px 2px rgba(0,0,0,0.15)`,
          cursor: isEditing ? 'default' : 'pointer',
          transform: pressed ? 'scale(0.96)' : 'scale(1)',
          transition: 'all 0.2s ease',
        }}
      >
        {/* LED indicator dot - top-right corner */}
        <div
          style={{
            position: 'absolute',
            top: ledSize * 0.4,
            right: ledSize * 0.4,
            width: ledSize,
            height: ledSize,
            borderRadius: '50%',
            background: pressed ? '#4ade80' : '#9ca3af',
            boxShadow: pressed
              ? '0 0 6px rgba(74,222,128,0.8), 0 0 2px rgba(74,222,128,0.6)'
              : '0 0 2px rgba(0,0,0,0.2)',
            border: '1px solid rgba(255,255,255,0.3)',
            transition: 'all 0.2s ease',
          }}
        />
        <span style={{ color: 'white', fontSize: Math.max(10, btnSize * 0.18), fontWeight: 700, userSelect: 'none' }}>
          {pressed ? 'AÇIK' : label}
        </span>
      </div>
    </div>
  );
};

PushButtonRenderer.displayName = 'PushButtonRenderer';
export default memo(PushButtonRenderer);
