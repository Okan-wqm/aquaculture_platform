/**
 * SCADA Widget Size Constants & Grid ↔ Pixel Conversion
 *
 * Editor uses pixel coordinates (ReactFlow), storage/deploy uses grid units.
 * Edge runtime (scada-edge.html) renders via CSS Grid with { col, row, w, h }.
 *
 * Grid: 12 columns x 8 rows, each cell = GRID_CELL_W x GRID_CELL_H pixels.
 */

import type { WidgetPosition } from '../types/scada-package.types';

// Grid cell dimensions in pixels
export const GRID_CELL_W = 120;
export const GRID_CELL_H = 100;

// ReactFlow snap grid (matches cell size)
export const SNAP_GRID: [number, number] = [GRID_CELL_W, GRID_CELL_H];

// Grid dimensions
export const GRID_COLS = 12;
export const GRID_ROWS = 8;

/* ------------------------------------------------------------------ */
/*  Grid ↔ Pixel conversion                                           */
/* ------------------------------------------------------------------ */

export function gridToPixel(pos: WidgetPosition) {
  return {
    x: pos.col * GRID_CELL_W,
    y: pos.row * GRID_CELL_H,
    width: pos.w * GRID_CELL_W,
    height: pos.h * GRID_CELL_H,
  };
}

export function pixelToGrid(
  x: number,
  y: number,
  width: number,
  height: number,
): WidgetPosition {
  return {
    col: Math.max(0, Math.round(x / GRID_CELL_W)),
    row: Math.max(0, Math.round(y / GRID_CELL_H)),
    w: Math.max(1, Math.round(width / GRID_CELL_W)),
    h: Math.max(1, Math.round(height / GRID_CELL_H)),
  };
}

/* ------------------------------------------------------------------ */
/*  Per-widget size definitions (grid units)                           */
/* ------------------------------------------------------------------ */

export interface WidgetSizeDef {
  defaultW: number;
  defaultH: number;
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
}

export const WIDGET_SIZES: Record<string, WidgetSizeDef> = {
  // small (2x2)
  numericDisplay:    { defaultW: 2, defaultH: 2, minW: 1, minH: 1, maxW: 4,  maxH: 3 },
  statusIndicator:   { defaultW: 2, defaultH: 2, minW: 1, minH: 1, maxW: 3,  maxH: 3 },
  toggleSwitch:      { defaultW: 2, defaultH: 2, minW: 1, minH: 1, maxW: 3,  maxH: 2 },
  pushButton:        { defaultW: 2, defaultH: 2, minW: 1, minH: 1, maxW: 3,  maxH: 3 },
  numericInput:      { defaultW: 2, defaultH: 2, minW: 1, minH: 1, maxW: 4,  maxH: 2 },
  // medium (3x3)
  gauge:             { defaultW: 3, defaultH: 3, minW: 2, minH: 2, maxW: 4,  maxH: 4 },
  calibrationStatus: { defaultW: 3, defaultH: 3, minW: 2, minH: 2, maxW: 4,  maxH: 3 },
  // tall (2x4)
  emergencyStop:     { defaultW: 2, defaultH: 4, minW: 1, minH: 2, maxW: 3,  maxH: 5 },
  tankLevel:         { defaultW: 2, defaultH: 4, minW: 1, minH: 2, maxW: 3,  maxH: 6 },
  // wide (3x2)
  slider:            { defaultW: 3, defaultH: 2, minW: 2, minH: 1, maxW: 6,  maxH: 2 },
  // large (6x4)
  trendChart:        { defaultW: 6, defaultH: 4, minW: 3, minH: 2, maxW: 12, maxH: 8 },
  alarmList:         { defaultW: 6, defaultH: 4, minW: 3, minH: 2, maxW: 12, maxH: 8 },
  calibrationWizard: { defaultW: 6, defaultH: 4, minW: 3, minH: 3, maxW: 8,  maxH: 6 },
  calibrationHistory:{ defaultW: 6, defaultH: 4, minW: 3, minH: 2, maxW: 12, maxH: 8 },
  // banner (12x2)
  alarmBanner:       { defaultW: 12, defaultH: 2, minW: 4, minH: 1, maxW: 12, maxH: 3 },
  // full (12x6)
  processView:       { defaultW: 12, defaultH: 6, minW: 4, minH: 3, maxW: 12, maxH: 8 },
};

const DEFAULT_SIZE: WidgetSizeDef = {
  defaultW: 2, defaultH: 2, minW: 1, minH: 1, maxW: 12, maxH: 8,
};

export function getWidgetSize(widgetType: string): WidgetSizeDef {
  return WIDGET_SIZES[widgetType] || DEFAULT_SIZE;
}

/** Convert grid-unit size constraints to pixel constraints */
export function getWidgetPixelConstraints(widgetType: string) {
  const s = getWidgetSize(widgetType);
  return {
    defaultW: s.defaultW * GRID_CELL_W,
    defaultH: s.defaultH * GRID_CELL_H,
    minW: s.minW * GRID_CELL_W,
    minH: s.minH * GRID_CELL_H,
    maxW: s.maxW * GRID_CELL_W,
    maxH: s.maxH * GRID_CELL_H,
  };
}
