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
