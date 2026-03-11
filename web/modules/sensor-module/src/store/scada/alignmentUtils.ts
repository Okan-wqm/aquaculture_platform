/**
 * Pure utility functions for aligning and distributing SCADA widgets on the grid canvas.
 *
 * All functions accept an array of { id, position } and return a Map<id, newPosition>.
 * No store dependency — these are stateless helpers consumed by the widget slice or UI commands.
 */

import type { WidgetPosition } from './types';

export interface WidgetRect {
  id: string;
  position: WidgetPosition;
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                    */
/* ------------------------------------------------------------------ */

/** Clone a position, preserving w/h from the original. */
function clonePos(p: WidgetPosition): WidgetPosition {
  return { col: p.col, row: p.row, w: p.w, h: p.h };
}

/** Clamp a value to be >= 0. */
function clamp0(v: number): number {
  return Math.max(0, v);
}

/** Build and return an empty result map (identity — every widget keeps its position). */
function identityMap(widgets: WidgetRect[]): Map<string, WidgetPosition> {
  const map = new Map<string, WidgetPosition>();
  for (const w of widgets) {
    map.set(w.id, clonePos(w.position));
  }
  return map;
}

/* ------------------------------------------------------------------ */
/*  Alignment functions                                                */
/* ------------------------------------------------------------------ */

/** Align all widgets to the leftmost widget's column. */
export function alignLeft(widgets: WidgetRect[]): Map<string, WidgetPosition> {
  if (widgets.length < 2) return new Map();

  const minCol = Math.min(...widgets.map((w) => w.position.col));

  const result = new Map<string, WidgetPosition>();
  for (const w of widgets) {
    const pos = clonePos(w.position);
    pos.col = clamp0(minCol);
    result.set(w.id, pos);
  }
  return result;
}

/** Align all widgets to the rightmost widget's right edge. */
export function alignRight(widgets: WidgetRect[]): Map<string, WidgetPosition> {
  if (widgets.length < 2) return new Map();

  const maxRight = Math.max(...widgets.map((w) => w.position.col + w.position.w));

  const result = new Map<string, WidgetPosition>();
  for (const w of widgets) {
    const pos = clonePos(w.position);
    pos.col = clamp0(maxRight - pos.w);
    result.set(w.id, pos);
  }
  return result;
}

/** Align all widgets to the topmost widget's row. */
export function alignTop(widgets: WidgetRect[]): Map<string, WidgetPosition> {
  if (widgets.length < 2) return new Map();

  const minRow = Math.min(...widgets.map((w) => w.position.row));

  const result = new Map<string, WidgetPosition>();
  for (const w of widgets) {
    const pos = clonePos(w.position);
    pos.row = clamp0(minRow);
    result.set(w.id, pos);
  }
  return result;
}

/** Align all widgets to the bottommost widget's bottom edge. */
export function alignBottom(widgets: WidgetRect[]): Map<string, WidgetPosition> {
  if (widgets.length < 2) return new Map();

  const maxBottom = Math.max(...widgets.map((w) => w.position.row + w.position.h));

  const result = new Map<string, WidgetPosition>();
  for (const w of widgets) {
    const pos = clonePos(w.position);
    pos.row = clamp0(maxBottom - pos.h);
    result.set(w.id, pos);
  }
  return result;
}

/** Align all widgets to the horizontal center of the bounding box. */
export function alignCenterH(widgets: WidgetRect[]): Map<string, WidgetPosition> {
  if (widgets.length < 2) return new Map();

  const minCol = Math.min(...widgets.map((w) => w.position.col));
  const maxRight = Math.max(...widgets.map((w) => w.position.col + w.position.w));
  const centerCol = (minCol + maxRight) / 2;

  const result = new Map<string, WidgetPosition>();
  for (const w of widgets) {
    const pos = clonePos(w.position);
    pos.col = clamp0(Math.round(centerCol - pos.w / 2));
    result.set(w.id, pos);
  }
  return result;
}

/** Align all widgets to the vertical center of the bounding box. */
export function alignCenterV(widgets: WidgetRect[]): Map<string, WidgetPosition> {
  if (widgets.length < 2) return new Map();

  const minRow = Math.min(...widgets.map((w) => w.position.row));
  const maxBottom = Math.max(...widgets.map((w) => w.position.row + w.position.h));
  const centerRow = (minRow + maxBottom) / 2;

  const result = new Map<string, WidgetPosition>();
  for (const w of widgets) {
    const pos = clonePos(w.position);
    pos.row = clamp0(Math.round(centerRow - pos.h / 2));
    result.set(w.id, pos);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Distribution functions                                             */
/* ------------------------------------------------------------------ */

/** Distribute widgets evenly horizontally (equal spacing between them). */
export function distributeH(widgets: WidgetRect[]): Map<string, WidgetPosition> {
  if (widgets.length < 3) return new Map();

  // Sort by column position (left to right).
  const sorted = [...widgets].sort((a, b) => a.position.col - b.position.col);

  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const leftEdge = first.position.col;
  const rightEdge = last.position.col + last.position.w;

  // Total width consumed by all widgets.
  const totalWidgetWidth = sorted.reduce((sum, w) => sum + w.position.w, 0);

  // Total gap to distribute among (n-1) intervals.
  const totalGap = rightEdge - leftEdge - totalWidgetWidth;
  const gapBetween = totalGap / (sorted.length - 1);

  const result = new Map<string, WidgetPosition>();
  let currentCol = leftEdge;

  for (let i = 0; i < sorted.length; i++) {
    const pos = clonePos(sorted[i].position);
    if (i === 0) {
      // First widget stays in place.
      result.set(sorted[i].id, pos);
    } else if (i === sorted.length - 1) {
      // Last widget stays in place.
      result.set(sorted[i].id, pos);
    } else {
      pos.col = clamp0(Math.round(currentCol));
      result.set(sorted[i].id, pos);
    }
    currentCol += pos.w + gapBetween;
  }

  return result;
}

/** Distribute widgets evenly vertically (equal spacing between them). */
export function distributeV(widgets: WidgetRect[]): Map<string, WidgetPosition> {
  if (widgets.length < 3) return new Map();

  // Sort by row position (top to bottom).
  const sorted = [...widgets].sort((a, b) => a.position.row - b.position.row);

  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const topEdge = first.position.row;
  const bottomEdge = last.position.row + last.position.h;

  // Total height consumed by all widgets.
  const totalWidgetHeight = sorted.reduce((sum, w) => sum + w.position.h, 0);

  // Total gap to distribute among (n-1) intervals.
  const totalGap = bottomEdge - topEdge - totalWidgetHeight;
  const gapBetween = totalGap / (sorted.length - 1);

  const result = new Map<string, WidgetPosition>();
  let currentRow = topEdge;

  for (let i = 0; i < sorted.length; i++) {
    const pos = clonePos(sorted[i].position);
    if (i === 0) {
      // First widget stays in place.
      result.set(sorted[i].id, pos);
    } else if (i === sorted.length - 1) {
      // Last widget stays in place.
      result.set(sorted[i].id, pos);
    } else {
      pos.row = clamp0(Math.round(currentRow));
      result.set(sorted[i].id, pos);
    }
    currentRow += pos.h + gapBetween;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Size matching functions                                            */
/* ------------------------------------------------------------------ */

/** Match all widgets to the same width (maximum width in selection). */
export function matchWidth(widgets: WidgetRect[]): Map<string, WidgetPosition> {
  if (widgets.length < 2) return new Map();

  const maxW = Math.max(...widgets.map((w) => w.position.w));

  const result = new Map<string, WidgetPosition>();
  for (const w of widgets) {
    const pos = clonePos(w.position);
    pos.w = maxW;
    result.set(w.id, pos);
  }
  return result;
}

/** Match all widgets to the same height (maximum height in selection). */
export function matchHeight(widgets: WidgetRect[]): Map<string, WidgetPosition> {
  if (widgets.length < 2) return new Map();

  const maxH = Math.max(...widgets.map((w) => w.position.h));

  const result = new Map<string, WidgetPosition>();
  for (const w of widgets) {
    const pos = clonePos(w.position);
    pos.h = maxH;
    result.set(w.id, pos);
  }
  return result;
}
