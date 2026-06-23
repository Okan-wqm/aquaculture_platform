/**
 * CustomSvgRenderer - Renders user-uploaded SVG content as a SCADA widget
 *
 * Accepts raw SVG markup via `config.svgContent`, sanitises it using DOMPurify
 * with a strict SVG-only whitelist, then renders via `dangerouslySetInnerHTML`.
 * Supports animation state (visibility, rotation, blink) and an optional label overlay.
 */

import React, { memo, useMemo } from 'react';
import DOMPurify from 'dompurify';
import type { WidgetRendererProps } from '../WidgetRenderer';

// SVG sanitizasyon konfigurasyonu -- XSS vektorlerini engeller
// Security config: foreignObject, script, iframe gibi tehlikeli tag'lar yasakli
// FORBID_ATTR: xlink:href data-URI injection, formaction hijacking onler
const DOMPURIFY_CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['foreignObject', 'script', 'iframe', 'embed', 'object', 'base', 'form'],
  FORBID_ATTR: ['xlink:href', 'formaction', 'action', 'srcdoc'],
  ADD_TAGS: [
    'use', 'symbol', 'defs', 'clipPath', 'mask', 'pattern', 'marker',
    'linearGradient', 'radialGradient', 'stop', 'filter',
    'feGaussianBlur', 'feOffset', 'feMerge', 'feMergeNode', 'feFlood',
    'feComposite', 'feBlend', 'feColorMatrix',
  ],
  ALLOW_DATA_ATTR: false,
};

/**
 * DOMPurify ile SVG icerigini temizler -- regex yerine DOM-tabanli sanitizasyon
 * Enterprise-grade: DOMPurify DOM parser kullanir, regex bypass edilemez
 */
function sanitizeSvg(raw: string): string {
  return DOMPurify.sanitize(raw, DOMPURIFY_CONFIG) as unknown as string;
}

const CustomSvgRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, animationState,
}) => {
  const svgContent = (config.svgContent ?? '') as string;
  const label = (config.label ?? '') as string;

  // DOMPurify tabanli sanitizasyon -- regex bypass'larina karsi korunakli
  // Security: memoize edilerek her render'da tekrar sanitize edilmez.
  // Hook must run unconditionally (react-hooks/rules-of-hooks); it is
  // evaluated before the early "no SVG" return below so hook order is stable.
  const safeSvg = useMemo(() => sanitizeSvg(svgContent), [svgContent]);

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
