/**
 * Renders SVG <marker> definitions in a <defs> block.
 * Scoped per-screen using screenId prefix to avoid ID collisions
 * when multiple screens share the ReactFlow SVG layer.
 *
 * Supports 4 marker shapes: arrow, circle, diamond, square.
 * Each marker has configurable size, fill, and outline mode.
 */

import React, { useMemo } from 'react';

export type MarkerShape = 'arrow' | 'circle' | 'diamond' | 'square';

export interface MarkerConfig {
  shape: MarkerShape;
  size: number;
  fill: string;
  /** When true, renders the shape with stroke only (no fill) */
  outline?: boolean;
}

interface SvgMarkerDefsProps {
  screenId: string;
  markers: MarkerConfig[];
}

/**
 * Builds a deterministic marker ID from config properties.
 * Ensures multiple edges referencing the same marker share one <marker> definition.
 */
export function buildMarkerId(screenId: string, config: MarkerConfig): string {
  return `marker-${screenId}-${config.shape}-${config.size}-${config.fill.replace('#', '')}`;
}

/** Marker viewBox size — all shapes are defined in a 10x10 coordinate space */
const VB = 10;

/** Shape renderers — each returns SVG child elements for the marker content */
const MARKER_SHAPES: Record<MarkerShape, (fill: string, outline: boolean) => React.ReactElement> = {
  arrow: (fill, outline) => (
    <path
      d="M 0 0 L 10 5 L 0 10 z"
      fill={outline ? 'none' : fill}
      stroke={outline ? fill : 'none'}
      strokeWidth={outline ? 1 : 0}
    />
  ),
  circle: (fill, outline) => (
    <circle
      cx="5"
      cy="5"
      r="4"
      fill={outline ? 'none' : fill}
      stroke={outline ? fill : 'none'}
      strokeWidth={outline ? 1 : 0}
    />
  ),
  diamond: (fill, outline) => (
    <path
      d="M 5 0 L 10 5 L 5 10 L 0 5 z"
      fill={outline ? 'none' : fill}
      stroke={outline ? fill : 'none'}
      strokeWidth={outline ? 1 : 0}
    />
  ),
  square: (fill, outline) => (
    <rect
      x="1"
      y="1"
      width="8"
      height="8"
      fill={outline ? 'none' : fill}
      stroke={outline ? fill : 'none'}
      strokeWidth={outline ? 1 : 0}
    />
  ),
};

/**
 * Deduplicate marker configs by their generated ID.
 * Multiple edges may reference identical markers — rendering them once
 * is both correct and avoids unnecessary DOM elements.
 */
function deduplicateMarkers(
  screenId: string,
  markers: MarkerConfig[],
): Array<{ id: string; config: MarkerConfig }> {
  const seen = new Set<string>();
  const result: Array<{ id: string; config: MarkerConfig }> = [];
  for (const m of markers) {
    const id = buildMarkerId(screenId, m);
    if (!seen.has(id)) {
      seen.add(id);
      result.push({ id, config: m });
    }
  }
  return result;
}

export const SvgMarkerDefs: React.FC<SvgMarkerDefsProps> = ({ screenId, markers }) => {
  const uniqueMarkers = useMemo(
    () => deduplicateMarkers(screenId, markers),
    [screenId, markers],
  );

  if (uniqueMarkers.length === 0) return null;

  return (
    <svg
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
      aria-hidden="true"
    >
      <defs>
        {uniqueMarkers.map(({ id, config }) => (
          <marker
            key={id}
            id={id}
            viewBox={`0 0 ${VB} ${VB}`}
            refX={config.shape === 'arrow' ? VB : VB / 2}
            refY={VB / 2}
            markerWidth={config.size}
            markerHeight={config.size}
            orient="auto-start-reverse"
          >
            {MARKER_SHAPES[config.shape](config.fill, config.outline ?? false)}
          </marker>
        ))}
      </defs>
    </svg>
  );
};
