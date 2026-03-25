/**
 * Path/polyline data model for the svgPath widget.
 * Supports three segment types: straight lines, quadratic bezier,
 * and cubic bezier curves with editable control points.
 */

export type PathPointType = 'line' | 'cubic' | 'quadratic';

export interface PathPoint {
  /** X coordinate relative to widget bounds (0 to width) */
  x: number;
  /** Y coordinate relative to widget bounds (0 to height) */
  y: number;
  /** Segment type from this point to the next */
  type: PathPointType;
  /** Control point 1 for quadratic/cubic curves — relative to this point */
  cp1?: { x: number; y: number };
  /** Control point 2 for cubic curves — relative to next point */
  cp2?: { x: number; y: number };
}

/**
 * Generates an SVG path `d` attribute string from an array of PathPoints.
 * Handles line, quadratic bezier (Q), and cubic bezier (C) segments.
 */
export function buildPathD(points: PathPoint[], closed: boolean): string {
  if (points.length < 2) return '';
  const parts: string[] = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 0; i < points.length - 1; i++) {
    const curr = points[i];
    const next = points[i + 1];
    switch (curr.type) {
      case 'line':
        parts.push(`L ${next.x} ${next.y}`);
        break;
      case 'quadratic': {
        const cx = curr.x + (curr.cp1?.x ?? 0);
        const cy = curr.y + (curr.cp1?.y ?? 0);
        parts.push(`Q ${cx} ${cy} ${next.x} ${next.y}`);
        break;
      }
      case 'cubic': {
        const c1x = curr.x + (curr.cp1?.x ?? 0);
        const c1y = curr.y + (curr.cp1?.y ?? 0);
        const c2x = next.x + (curr.cp2?.x ?? 0);
        const c2y = next.y + (curr.cp2?.y ?? 0);
        parts.push(`C ${c1x} ${c1y} ${c2x} ${c2y} ${next.x} ${next.y}`);
        break;
      }
    }
  }
  if (closed) parts.push('Z');
  return parts.join(' ');
}

/**
 * Validates and clamps all path point coordinates to widget bounds.
 * Rejects NaN/Infinity values — critical for preventing SVG rendering crashes.
 */
export function clampPathPoints(points: PathPoint[], width: number, height: number): PathPoint[] {
  return points.map((p) => ({
    ...p,
    x: Number.isFinite(p.x) ? Math.max(0, Math.min(width, p.x)) : 0,
    y: Number.isFinite(p.y) ? Math.max(0, Math.min(height, p.y)) : 0,
  }));
}
