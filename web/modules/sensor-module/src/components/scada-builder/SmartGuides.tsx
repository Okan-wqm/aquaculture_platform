/**
 * SmartGuides - Visual alignment guides shown during widget drag.
 *
 * Renders horizontal and vertical guide lines when the dragged widget
 * aligns with other widgets on the canvas. Uses absolute positioning
 * within the ReactFlow canvas container.
 */

import React, { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useScadaPackageStore } from '../../store/scada';
import { GRID_CELL_W, GRID_CELL_H } from '../../constants/scada-widget-sizes';

interface SmartGuidesProps {
  /** Currently dragging widget ID, or null when not dragging */
  draggingWidgetId: string | null;
  /** Current drag position in pixels */
  dragPosition: { x: number; y: number } | null;
  /** Size of dragging widget in grid units */
  dragSize: { w: number; h: number } | null;
  /** Snap threshold in pixels */
  threshold?: number;
}

interface GuideLine {
  orientation: 'horizontal' | 'vertical';
  position: number; // px value for top or left
  start: number;    // px value for where line starts
  end: number;      // px value for where line ends
}

export const SmartGuides: React.FC<SmartGuidesProps> = ({
  draggingWidgetId,
  dragPosition,
  dragSize,
  threshold = 8,
}) => {
  const { screens, activeScreenId } = useScadaPackageStore(
    useShallow((s) => ({
      screens: s.screens,
      activeScreenId: s.activeScreenId,
    })),
  );

  const guides = useMemo((): GuideLine[] => {
    if (!draggingWidgetId || !dragPosition || !dragSize) return [];

    const screen = screens.find((s) => s.id === activeScreenId);
    if (!screen) return [];

    const lines: GuideLine[] = [];
    const dragLeft = dragPosition.x;
    const dragRight = dragPosition.x + dragSize.w * GRID_CELL_W;
    const dragTop = dragPosition.y;
    const dragBottom = dragPosition.y + dragSize.h * GRID_CELL_H;
    const dragCenterX = (dragLeft + dragRight) / 2;
    const dragCenterY = (dragTop + dragBottom) / 2;

    for (const widget of screen.widgets) {
      if (widget.id === draggingWidgetId) continue;

      const wLeft = widget.position.col * GRID_CELL_W;
      const wRight = (widget.position.col + widget.position.w) * GRID_CELL_W;
      const wTop = widget.position.row * GRID_CELL_H;
      const wBottom = (widget.position.row + widget.position.h) * GRID_CELL_H;
      const wCenterX = (wLeft + wRight) / 2;
      const wCenterY = (wTop + wBottom) / 2;

      const allX = [
        { drag: dragLeft, other: wLeft },
        { drag: dragRight, other: wRight },
        { drag: dragLeft, other: wRight },
        { drag: dragRight, other: wLeft },
        { drag: dragCenterX, other: wCenterX },
      ];

      const allY = [
        { drag: dragTop, other: wTop },
        { drag: dragBottom, other: wBottom },
        { drag: dragTop, other: wBottom },
        { drag: dragBottom, other: wTop },
        { drag: dragCenterY, other: wCenterY },
      ];

      // Vertical guides (x-axis alignment)
      for (const { drag, other } of allX) {
        if (Math.abs(drag - other) <= threshold) {
          const minY = Math.min(dragTop, wTop) - 20;
          const maxY = Math.max(dragBottom, wBottom) + 20;
          lines.push({
            orientation: 'vertical',
            position: other,
            start: minY,
            end: maxY,
          });
        }
      }

      // Horizontal guides (y-axis alignment)
      for (const { drag, other } of allY) {
        if (Math.abs(drag - other) <= threshold) {
          const minX = Math.min(dragLeft, wLeft) - 20;
          const maxX = Math.max(dragRight, wRight) + 20;
          lines.push({
            orientation: 'horizontal',
            position: other,
            start: minX,
            end: maxX,
          });
        }
      }
    }

    // Deduplicate guides (same orientation + position within threshold)
    const seen = new Set<string>();
    return lines.filter((line) => {
      const key = `${line.orientation}-${Math.round(line.position / 4) * 4}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [draggingWidgetId, dragPosition, dragSize, screens, activeScreenId, threshold]);

  if (guides.length === 0) return null;

  return (
    <svg
      className="absolute inset-0 pointer-events-none z-[100]"
      style={{ width: '100%', height: '100%', overflow: 'visible' }}
    >
      {guides.map((guide, i) =>
        guide.orientation === 'vertical' ? (
          <line
            key={`v-${i}`}
            x1={guide.position}
            y1={guide.start}
            x2={guide.position}
            y2={guide.end}
            stroke="#06b6d4"
            strokeWidth={1}
            strokeDasharray="4 3"
            opacity={0.7}
          />
        ) : (
          <line
            key={`h-${i}`}
            x1={guide.start}
            y1={guide.position}
            x2={guide.end}
            y2={guide.position}
            stroke="#06b6d4"
            strokeWidth={1}
            strokeDasharray="4 3"
            opacity={0.7}
          />
        ),
      )}
    </svg>
  );
};
