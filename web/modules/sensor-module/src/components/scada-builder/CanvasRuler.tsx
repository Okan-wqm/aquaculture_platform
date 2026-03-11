/**
 * CanvasRuler - Horizontal and vertical rulers for the SCADA canvas.
 *
 * Shows grid column/row numbers along the top and left edges.
 * Helps users position widgets precisely on the 12-column grid.
 */

import React, { useMemo } from 'react';
import { GRID_CELL_W, GRID_CELL_H } from '../../constants/scada-widget-sizes';

interface CanvasRulerProps {
  /** Current viewport offset in pixels */
  viewportX: number;
  viewportY: number;
  /** Current zoom level */
  zoom: number;
  /** Visible canvas dimensions in pixels */
  canvasWidth: number;
  canvasHeight: number;
  /** Ruler thickness in pixels */
  thickness?: number;
}

const RULER_BG = '#f8fafc';
const RULER_BORDER = '#e2e8f0';
const TICK_COLOR = '#94a3b8';
const LABEL_COLOR = '#64748b';

export const CanvasRuler: React.FC<CanvasRulerProps> = ({
  viewportX,
  viewportY,
  zoom,
  canvasWidth,
  canvasHeight,
  thickness = 20,
}) => {
  // Calculate visible grid range for horizontal ruler
  const hTicks = useMemo(() => {
    const ticks: Array<{ col: number; x: number }> = [];
    const cellW = GRID_CELL_W * zoom;
    const startCol = Math.floor(-viewportX / (GRID_CELL_W * zoom));
    const endCol = Math.ceil((canvasWidth - viewportX) / (GRID_CELL_W * zoom));

    for (let col = Math.max(0, startCol - 1); col <= endCol + 1; col++) {
      const x = col * cellW + viewportX * zoom;
      if (x >= -cellW && x <= canvasWidth + cellW) {
        ticks.push({ col, x: col * GRID_CELL_W * zoom + viewportX });
      }
    }
    return ticks;
  }, [viewportX, zoom, canvasWidth]);

  // Calculate visible grid range for vertical ruler
  const vTicks = useMemo(() => {
    const ticks: Array<{ row: number; y: number }> = [];
    const cellH = GRID_CELL_H * zoom;
    const startRow = Math.floor(-viewportY / (GRID_CELL_H * zoom));
    const endRow = Math.ceil((canvasHeight - viewportY) / (GRID_CELL_H * zoom));

    for (let row = Math.max(0, startRow - 1); row <= endRow + 1; row++) {
      const y = row * cellH + viewportY * zoom;
      if (y >= -cellH && y <= canvasHeight + cellH) {
        ticks.push({ row, y: row * GRID_CELL_H * zoom + viewportY });
      }
    }
    return ticks;
  }, [viewportY, zoom, canvasHeight]);

  return (
    <>
      {/* Horizontal ruler (top) */}
      <div
        className="absolute top-0 left-0 right-0 z-30 pointer-events-none overflow-hidden"
        style={{
          height: thickness,
          background: RULER_BG,
          borderBottom: `1px solid ${RULER_BORDER}`,
          marginLeft: thickness,
        }}
      >
        <svg width={canvasWidth} height={thickness}>
          {hTicks.map(({ col, x }) => (
            <g key={`h-${col}`}>
              <line
                x1={x}
                y1={thickness - 6}
                x2={x}
                y2={thickness}
                stroke={TICK_COLOR}
                strokeWidth={1}
              />
              <text
                x={x + 3}
                y={thickness - 8}
                fill={LABEL_COLOR}
                fontSize={9}
                fontFamily="monospace"
              >
                {col}
              </text>
            </g>
          ))}
        </svg>
      </div>

      {/* Vertical ruler (left) */}
      <div
        className="absolute top-0 left-0 bottom-0 z-30 pointer-events-none overflow-hidden"
        style={{
          width: thickness,
          background: RULER_BG,
          borderRight: `1px solid ${RULER_BORDER}`,
          marginTop: thickness,
        }}
      >
        <svg width={thickness} height={canvasHeight}>
          {vTicks.map(({ row, y }) => (
            <g key={`v-${row}`}>
              <line
                x1={thickness - 6}
                y1={y}
                x2={thickness}
                y2={y}
                stroke={TICK_COLOR}
                strokeWidth={1}
              />
              <text
                x={2}
                y={y + 11}
                fill={LABEL_COLOR}
                fontSize={9}
                fontFamily="monospace"
              >
                {row}
              </text>
            </g>
          ))}
        </svg>
      </div>

      {/* Corner square */}
      <div
        className="absolute top-0 left-0 z-30 pointer-events-none"
        style={{
          width: thickness,
          height: thickness,
          background: RULER_BG,
          borderRight: `1px solid ${RULER_BORDER}`,
          borderBottom: `1px solid ${RULER_BORDER}`,
        }}
      />
    </>
  );
};
