/**
 * SVG stroke and fill property types used across all SVG shape widgets.
 * These map directly to SVG presentation attributes for consistent rendering.
 */

export type StrokeDashPattern = 'solid' | 'dotted' | 'dashed' | 'dashDot' | 'dashDotDot';
export type StrokeLineCap = 'butt' | 'round' | 'square';
export type StrokeLineJoin = 'miter' | 'round' | 'bevel';

/** Maps logical dash pattern names to SVG stroke-dasharray attribute values */
export const DASH_PATTERN_MAP: Record<StrokeDashPattern, string> = {
  solid: '',
  dotted: '2 4',
  dashed: '8 4',
  dashDot: '8 4 2 4',
  dashDotDot: '8 4 2 4 2 4',
};

/** All available dash pattern options for dropdowns */
export const DASH_PATTERN_OPTIONS: StrokeDashPattern[] = [
  'solid',
  'dotted',
  'dashed',
  'dashDot',
  'dashDotDot',
];

/** All available line cap options */
export const LINE_CAP_OPTIONS: StrokeLineCap[] = ['butt', 'round', 'square'];

/** All available line join options */
export const LINE_JOIN_OPTIONS: StrokeLineJoin[] = ['miter', 'round', 'bevel'];

/* ------------------------------------------------------------------ */
/*  Gradient definitions                                               */
/* ------------------------------------------------------------------ */

/**
 * SVG gradient definitions for fill and stroke properties.
 * Gradients are rendered as <linearGradient>/<radialGradient> inside
 * per-widget <defs> blocks -- no global defs needed, avoiding
 * cross-widget collisions in multi-tenant SCADA screens.
 */

export type GradientType = 'none' | 'linear' | 'radial';

export interface GradientStop {
  /** Position along the gradient axis (0 to 1) */
  offset: number;
  /** CSS color string (hex format preferred for SVG compat) */
  color: string;
  /** Opacity at this stop (0 to 1) */
  opacity: number;
}

export interface GradientConfig {
  type: GradientType;
  /** Angle in degrees for linear gradient (0 = left-to-right, 90 = top-to-bottom) */
  angle: number;
  /** Stops defining color transitions -- minimum 2 required */
  stops: GradientStop[];
}

export const DEFAULT_GRADIENT: GradientConfig = {
  type: 'none',
  angle: 0,
  stops: [
    { offset: 0, color: '#3b82f6', opacity: 1 },
    { offset: 1, color: '#1d4ed8', opacity: 1 },
  ],
};

/** All available gradient type options for dropdowns */
export const GRADIENT_TYPE_OPTIONS: GradientType[] = ['none', 'linear', 'radial'];

/**
 * Builds an SVG gradient element ID unique to the widget.
 * The ID is scoped per-widget and per-target (fill vs stroke) to prevent
 * collisions when multiple widgets render gradients simultaneously.
 */
export function buildGradientId(widgetId: string, target: 'fill' | 'stroke'): string {
  return `grad-${widgetId}-${target}`;
}

/**
 * Converts a linear gradient angle (degrees) to SVG x1/y1/x2/y2 coordinates.
 * SVG linearGradient uses a coordinate system where (0,0) is top-left and
 * (1,1) is bottom-right. The angle rotates clockwise from the right (0 deg).
 */
export function angleToGradientCoords(angleDeg: number): {
  x1: string;
  y1: string;
  x2: string;
  y2: string;
} {
  const rad = (angleDeg * Math.PI) / 180;
  const x2 = Math.cos(rad);
  const y2 = Math.sin(rad);
  // Map from [-1,1] to [0%,100%] for SVG gradient coordinates
  return {
    x1: `${50 - x2 * 50}%`,
    y1: `${50 - y2 * 50}%`,
    x2: `${50 + x2 * 50}%`,
    y2: `${50 + y2 * 50}%`,
  };
}

/* ------------------------------------------------------------------ */
/*  SVG Filter definitions                                             */
/* ------------------------------------------------------------------ */

/**
 * SVG filter effect definitions for visual enhancements.
 * Filters are rendered as <filter> elements in per-widget <defs> blocks
 * and referenced via the filter="url(#...)" attribute for cross-browser
 * SVG compatibility (CSS filters do not work inside SVG in all browsers).
 */
export type SvgFilterType = 'none' | 'blur' | 'dropShadow' | 'glow';

/** All available filter type options for dropdowns */
export const SVG_FILTER_TYPE_OPTIONS: SvgFilterType[] = ['none', 'blur', 'dropShadow', 'glow'];

export interface SvgFilterConfig {
  type: SvgFilterType;
  /** Gaussian blur radius in pixels (used by blur and dropShadow) */
  blurRadius?: number;
  /** Shadow offset X in pixels */
  shadowX?: number;
  /** Shadow offset Y in pixels */
  shadowY?: number;
  /** Shadow/glow color (hex or CSS color string) */
  shadowColor?: string;
  /** Shadow/glow opacity (0 to 1) */
  shadowOpacity?: number;
}

export const DEFAULT_FILTER: SvgFilterConfig = { type: 'none' };

/**
 * Builds an SVG filter element ID unique to the widget.
 * Scoped to prevent filter collisions across widgets.
 */
export function buildFilterId(widgetId: string): string {
  return `filter-${widgetId}`;
}
