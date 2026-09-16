/**
 * Viewport-aware cascade insert position for template/FUXA widget inserts.
 *
 * Previously every insert landed at a fixed {col: 2, row: 2} — off-screen
 * whenever the user had panned away, and stacked directly on top of the
 * previous insert. This helper:
 *   1. anchors to the VISIBLE viewport origin (screenViewports entry), so
 *      the new widget appears where the user is looking;
 *   2. cascades by one grid cell per existing widget (wrapping every 6) so
 *      consecutive inserts stay distinguishable.
 */

import { GRID_CELL_W, GRID_CELL_H } from '../../constants/scada-widget-sizes';

export interface ViewportLike {
  x: number;
  y: number;
  zoom: number;
}

export function cascadeInsertPosition(args: {
  viewport?: ViewportLike | null;
  widgetCount: number;
  baseCol?: number;
  baseRow?: number;
}): { col: number; row: number } {
  const baseCol = args.baseCol ?? 2;
  const baseRow = args.baseRow ?? 2;

  let col = baseCol;
  let row = baseRow;
  const vp = args.viewport;
  if (vp) {
    const zoom = vp.zoom > 0 ? vp.zoom : 1;
    // flow-space coordinate of the top-left visible corner
    col = Math.max(0, Math.round(-vp.x / zoom / GRID_CELL_W) + baseCol);
    row = Math.max(0, Math.round(-vp.y / zoom / GRID_CELL_H) + baseRow);
  }

  const cascade = args.widgetCount % 6;
  return { col: col + cascade, row: row + cascade };
}
