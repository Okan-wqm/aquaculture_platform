/**
 * Universal SVG transform model applied at the ScadaWidgetNode container level.
 * All widget types (not just SVG shapes) benefit from transforms without
 * modifying individual renderers — the CSS transform is applied on the wrapper div.
 */
export interface SvgTransform {
  /** Rotation in degrees, clamped to [0, 360] */
  rotation: number;
  /** Horizontal scale multiplier, clamped to [0.1, 10] */
  scaleX: number;
  /** Vertical scale multiplier, clamped to [0.1, 10] */
  scaleY: number;
  /** Horizontal skew in degrees, clamped to [-89, 89] */
  skewX: number;
  /** Vertical skew in degrees, clamped to [-89, 89] */
  skewY: number;
  /** Transform origin X as ratio (0 = left, 0.5 = center, 1 = right) */
  originX: number;
  /** Transform origin Y as ratio (0 = top, 0.5 = center, 1 = bottom) */
  originY: number;
}

export const DEFAULT_SVG_TRANSFORM: SvgTransform = {
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  skewX: 0,
  skewY: 0,
  originX: 0.5,
  originY: 0.5,
};

/**
 * Builds a CSS transform string from an SvgTransform object.
 * Returns empty string when all values are at defaults — avoids
 * unnecessary GPU compositing layers on unchanged widgets.
 */
export function buildTransformCSS(t: SvgTransform): string {
  const parts: string[] = [];
  if (t.rotation !== 0) parts.push(`rotate(${t.rotation}deg)`);
  if (t.scaleX !== 1 || t.scaleY !== 1) parts.push(`scale(${t.scaleX}, ${t.scaleY})`);
  if (t.skewX !== 0) parts.push(`skewX(${t.skewX}deg)`);
  if (t.skewY !== 0) parts.push(`skewY(${t.skewY}deg)`);
  return parts.join(' ');
}

/**
 * Builds CSS transform-origin from origin ratios.
 * Returns undefined when at center (default) to avoid setting the property.
 */
export function buildTransformOrigin(t: SvgTransform): string | undefined {
  if (t.originX === 0.5 && t.originY === 0.5) return undefined;
  return `${t.originX * 100}% ${t.originY * 100}%`;
}

/**
 * Clamps transform values to safe bounds to prevent rendering artifacts.
 * Rotation wraps to [0, 360), scale clamped to [0.1, 10], skew to (-89, 89).
 */
export function clampTransform(t: Partial<SvgTransform>): Partial<SvgTransform> {
  const result: Partial<SvgTransform> = { ...t };
  if (result.rotation !== undefined) {
    result.rotation = ((result.rotation % 360) + 360) % 360;
  }
  if (result.scaleX !== undefined) {
    result.scaleX = Math.max(0.1, Math.min(10, result.scaleX));
  }
  if (result.scaleY !== undefined) {
    result.scaleY = Math.max(0.1, Math.min(10, result.scaleY));
  }
  if (result.skewX !== undefined) {
    result.skewX = Math.max(-89, Math.min(89, result.skewX));
  }
  if (result.skewY !== undefined) {
    result.skewY = Math.max(-89, Math.min(89, result.skewY));
  }
  return result;
}
