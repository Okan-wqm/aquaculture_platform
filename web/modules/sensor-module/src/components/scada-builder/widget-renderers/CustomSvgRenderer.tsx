/**
 * CustomSvgRenderer - Renders user-uploaded SVG content as a SCADA widget
 *
 * Accepts raw SVG markup via `config.svgContent`, sanitises it by stripping
 * `<script>` tags and inline event handlers, then renders via `dangerouslySetInnerHTML`.
 * Supports animation state (visibility, rotation, blink) and an optional label overlay.
 */

import React, { memo, useMemo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const CustomSvgRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, animationState,
}) => {
  const svgContent = (config.svgContent ?? '') as string;
  const label = (config.label ?? '') as string;

  if (!svgContent) {
    return (
      <div style={{
        width, height, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#f8fafc', border: '2px dashed #d1d5db', borderRadius: 8,
        color: '#9ca3af', fontSize: 11, textAlign: 'center', padding: 8,
      }}>
        No SVG uploaded
      </div>
    );
  }

  // Animation styles
  const style: React.CSSProperties = { width, height, position: 'relative' };
  if (animationState && !animationState.visible) {
    style.opacity = 0;
    style.pointerEvents = 'none';
  }
  if (animationState?.rotating) {
    const dir = animationState.rotationDirection === 'ccw' ? 'reverse' : 'normal';
    style.animation = `scada-rotate ${animationState.rotationSpeed}ms linear infinite ${dir}`;
    style.transformOrigin = 'center center';
  }
  if (animationState?.blinking) {
    style.animation = `scada-blink ${animationState.blinkInterval}ms ease-in-out infinite`;
  }

  // Sanitize: strip script tags and inline event handlers for safety
  const safeSvg = useMemo(() => {
    return svgContent
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
  }, [svgContent]);

  return (
    <div style={style}>
      <div
        style={{ width: '100%', height: '100%' }}
        dangerouslySetInnerHTML={{ __html: safeSvg }}
      />
      {label && (
        <div style={{
          position: 'absolute', bottom: 2, left: 0, right: 0,
          textAlign: 'center', fontSize: 10, color: '#6b7280',
        }}>
          {label}
        </div>
      )}
    </div>
  );
};

CustomSvgRenderer.displayName = 'CustomSvgRenderer';
export default memo(CustomSvgRenderer);
