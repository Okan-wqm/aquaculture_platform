/**
 * StaticTextRenderer - Simple text label / annotation for SCADA screens
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const StaticTextRenderer: React.FC<WidgetRendererProps> = ({ config, width, height }) => {
  const text = (config.text as string) || 'Text';
  const fontSize = (config.fontSize as number) || 14;
  const fontWeight = (config.fontWeight as string) || 'normal';
  const textAlign = (config.textAlign as string) || 'left';
  const color = (config.color as string) || '#1f2937';
  const backgroundColor = (config.backgroundColor as string) || 'transparent';
  const borderColor = (config.borderColor as string) || 'transparent';
  const borderWidth = (config.borderWidth as number) || 0;
  const padding = (config.padding as number) ?? 8;
  const verticalAlign = (config.verticalAlign as string) || 'middle';

  return (
    <div
      style={{
        width,
        height,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems:
          verticalAlign === 'top'
            ? 'flex-start'
            : verticalAlign === 'bottom'
              ? 'flex-end'
              : 'center',
        justifyContent:
          textAlign === 'left'
            ? 'flex-start'
            : textAlign === 'right'
              ? 'flex-end'
              : 'center',
        fontSize,
        fontWeight,
        color,
        backgroundColor,
        border: borderWidth > 0 ? `${borderWidth}px solid ${borderColor}` : 'none',
        padding,
        whiteSpace: 'pre-wrap',
        overflow: 'hidden',
      }}
    >
      {text}
    </div>
  );
};

StaticTextRenderer.displayName = 'StaticTextRenderer';
export default memo(StaticTextRenderer);
