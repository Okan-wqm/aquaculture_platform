/**
 * Pure node-change processing for ScreenCanvas.onNodesChange.
 *
 * Extracted from the React component so the drag pipeline is unit-testable:
 *   1. locked-widget filtering
 *   2. group drag propagation (siblings follow the dragged node's delta)
 *   3. drag start/end detection + SmartGuides tracking payload
 *   4. drag-end commit: grid-rounded store updates for the dragged widget
 *      AND its group siblings (one batch → one undo entry via moveWidgets)
 *
 * Everything here is pure: no store access, no React state. ScreenCanvas only
 * feeds inputs in and applies the outputs.
 */

import {
  GRID_CELL_W,
  GRID_CELL_H,
  gridToPixel,
  pixelToGrid,
} from '../../../constants/scada-widget-sizes';
import type { WidgetPosition } from '../../../store/scada/types';

/** Structural subset of xyflow's NodeChange (keeps the function testable). */
export interface NodeChangeLike {
  type: 'position' | 'select' | 'remove' | 'replace' | 'dimensions' | string;
  id: string;
  dragging?: boolean;
  selected?: boolean;
  position?: { x: number; y: number };
}

export interface WidgetLike {
  id: string;
  groupId?: string | null;
  locked?: boolean;
  position: WidgetPosition;
}

export interface LocalNodeLike {
  id: string;
  position: { x: number; y: number };
}

export interface DragCommitUpdate {
  id: string;
  position: WidgetPosition;
}

export interface ProcessNodeChangesResult {
  /** Original changes minus locked-widget position changes. */
  filteredChanges: NodeChangeLike[];
  /** Synthetic sibling position changes for group drag propagation. */
  groupDragChanges: NodeChangeLike[];
  /** True when any change started a drag (suppress store→local sync). */
  dragStarted: boolean;
  /** True when any change ended a drag (commit updates are populated). */
  dragEnded: boolean;
  /** SmartGuides tracking payload while dragging; null when idle. */
  guide: { nodeId: string; position: { x: number; y: number }; size: { w: number; h: number } } | null;
  /** Store writes for drag end (dragged widget + moved group siblings). */
  commitUpdates: DragCommitUpdate[];
  /** IDs of widgets newly selected via select changes. */
  selectedIds: string[];
}

/** Position rounding tolerance: skip store writes when the grid cell didn't change. */
function sameGridCell(a: WidgetPosition, b: WidgetPosition): boolean {
  return a.col === b.col && a.row === b.row;
}

export function processNodeChanges(args: {
  changes: NodeChangeLike[];
  widgets: WidgetLike[];
  localNodes: LocalNodeLike[];
}): ProcessNodeChangesResult {
  const { changes, widgets, localNodes } = args;

  const lockedIds = new Set(widgets.filter((w) => w.locked).map((w) => w.id));
  const widgetById = new Map(widgets.map((w) => [w.id, w]));
  const nodeById = new Map(localNodes.map((n) => [n.id, n]));

  // --- 1. Locked filter ------------------------------------------------
  const filteredChanges = changes.filter((change) => {
    if (change.type === 'position' && lockedIds.has(change.id)) return false;
    return true;
  });

  // --- 2. Group drag propagation ----------------------------------------
  const groupDragChanges: NodeChangeLike[] = [];
  for (const change of filteredChanges) {
    if (change.type === 'position' && change.dragging === true && change.position) {
      const draggedWidget = widgetById.get(change.id);
      if (draggedWidget?.groupId) {
        const prevNode = nodeById.get(change.id);
        if (prevNode) {
          const dx = change.position.x - prevNode.position.x;
          const dy = change.position.y - prevNode.position.y;
          if (dx !== 0 || dy !== 0) {
            const siblings = widgets.filter(
              (w) => w.groupId === draggedWidget.groupId
                && w.id !== change.id
                && !lockedIds.has(w.id),
            );
            for (const sibling of siblings) {
              const sibNode = nodeById.get(sibling.id);
              if (sibNode) {
                groupDragChanges.push({
                  type: 'position',
                  id: sibling.id,
                  dragging: true,
                  position: {
                    x: sibNode.position.x + dx,
                    y: sibNode.position.y + dy,
                  },
                });
              }
            }
          }
        }
      }
    }
  }

  // --- 3. Drag tracking + 4. Drag-end commit -----------------------------
  let dragStarted = false;
  let dragEnded = false;
  let guide: ProcessNodeChangesResult['guide'] = null;
  const commitUpdates: DragCommitUpdate[] = [];
  const selectedIds: string[] = [];

  for (const change of filteredChanges) {
    if (change.type === 'select' && change.selected) {
      selectedIds.push(change.id);
      continue;
    }

    if (change.type !== 'position' || !change.position) continue;

    if (change.dragging === true) {
      dragStarted = true;
      const sgWidget = widgetById.get(change.id);
      guide = {
        nodeId: change.id,
        position: { x: change.position.x, y: change.position.y },
        size: sgWidget
          ? { w: sgWidget.position.w, h: sgWidget.position.h }
          : { w: 1, h: 1 },
      };
      continue;
    }

    if (change.dragging === false) {
      dragEnded = true;
      const widget = widgetById.get(change.id);
      if (!widget) continue;

      // Dragged widget: convert pixel position back to grid
      const px = gridToPixel(widget.position);
      const newGrid = pixelToGrid(
        change.position.x,
        change.position.y,
        px.width,
        px.height,
      );
      if (!sameGridCell(widget.position, newGrid)) {
        commitUpdates.push({ id: change.id, position: newGrid });
      }

      // Group siblings: commit their propagated local positions too
      if (widget.groupId) {
        const siblings = widgets.filter(
          (w) => w.groupId === widget.groupId
            && w.id !== change.id
            && !lockedIds.has(w.id),
        );
        for (const sibling of siblings) {
          const sibNode = nodeById.get(sibling.id);
          if (!sibNode) continue;
          const sibPx = gridToPixel(sibling.position);
          const sibNewGrid = pixelToGrid(
            sibNode.position.x,
            sibNode.position.y,
            sibPx.width,
            sibPx.height,
          );
          if (!sameGridCell(sibling.position, sibNewGrid)) {
            commitUpdates.push({ id: sibling.id, position: sibNewGrid });
          }
        }
      }
    }
  }

  return {
    filteredChanges,
    groupDragChanges,
    dragStarted,
    dragEnded,
    guide,
    commitUpdates,
    selectedIds,
  };
}

/** Exposed for tests: pixel size of a grid cell. */
export const CELL_SIZE = { w: GRID_CELL_W, h: GRID_CELL_H };
