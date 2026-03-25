/**
 * SVG marker system for arrow heads and decorators on edges/lines.
 * Markers are rendered as <marker> defs scoped per-screen to avoid
 * cross-screen ID collisions in the shared ReactFlow SVG layer.
 */

export type MarkerShape = 'arrow' | 'circle' | 'diamond' | 'square';
export type MarkerPosition = 'start' | 'mid' | 'end';

export interface MarkerConfig {
  shape: MarkerShape;
  /** Marker size in pixels, clamped to [4, 20] */
  size: number;
  /** Fill color (CSS color string) */
  fill: string;
  /** When true, renders only the outline (stroke) without fill */
  outline: boolean;
}

export interface EdgeMarkers {
  start?: MarkerConfig;
  mid?: MarkerConfig;
  end?: MarkerConfig;
}

/** Default marker for new edges — small arrow at the end */
export const DEFAULT_END_MARKER: MarkerConfig = {
  shape: 'arrow',
  size: 8,
  fill: '#6b7280',
  outline: false,
};
