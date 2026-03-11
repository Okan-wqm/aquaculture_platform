/**
 * PushButtonRenderer - Large button visual + label with onCommand
 */

import React, { memo, useCallback } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const PushButtonRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing, onCommand }) => {
  const label = (config.label ?? 'START') as string;
  const color = (config.color ?? '#3b82f6') as string;
  const pressed = isEditing ? false : Boolean(value);

  const btnSize = Math.min(width * 0.6, height * 0.55, 80);

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
          width: btnSize,
          height: btnSize,
          borderRadius: 8,
          background: pressed ? '#1d4ed8' : color,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: pressed
            ? 'inset 0 2px 4px rgba(0,0,0,0.3)'
            : '0 3px 6px rgba(0,0,0,0.2)',
          cursor: isEditing ? 'default' : 'pointer',
          transition: 'box-shadow 0.15s',
        }}
      >
        <span style={{ color: 'white', fontSize: Math.max(10, btnSize * 0.18), fontWeight: 700 }}>
          {label}
        </span>
      </div>
    </div>
  );
};

PushButtonRenderer.displayName = 'PushButtonRenderer';
export default memo(PushButtonRenderer);
