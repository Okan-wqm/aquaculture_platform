/**
 * dragCommitUtils tests — the pure ScreenCanvas.onNodesChange pipeline:
 * locked filtering, group drag delta propagation, drag-end commit
 * computation (grid rounding, skip-when-same-grid), selection extraction.
 */

import { describe, it, expect } from 'vitest';
import { processNodeChanges, type NodeChangeLike, type WidgetLike } from '../dragCommitUtils';
import { GRID_CELL_W, GRID_CELL_H, gridToPixel } from '../../../../constants/scada-widget-sizes';

function widget(overrides?: Partial<WidgetLike>): WidgetLike {
  return {
    id: 'w1',
    groupId: null,
    locked: false,
    position: { col: 0, row: 0, w: 2, h: 2 },
    ...overrides,
  };
}

function node(id: string, x: number, y: number) {
  return { id, position: { x, y } };
}

describe('processNodeChanges', () => {
  it('filters position changes for locked widgets but keeps selection changes', () => {
    const widgets = [widget({ id: 'locked', locked: true }), widget({ id: 'free' })];
    const changes: NodeChangeLike[] = [
      { type: 'position', id: 'locked', dragging: true, position: { x: 10, y: 10 } },
      { type: 'select', id: 'locked', selected: true },
      { type: 'position', id: 'free', dragging: true, position: { x: 5, y: 5 } },
    ];
    const result = processNodeChanges({ changes, widgets, localNodes: [] });
    expect(result.filteredChanges).toHaveLength(2);
    expect(result.selectedIds).toEqual(['locked']);
  });

  it('propagates the drag delta to unlocked group siblings only', () => {
    const widgets = [
      widget({ id: 'dragged', groupId: 'g1' }),
      widget({ id: 'sibling', groupId: 'g1' }),
      widget({ id: 'lockedSibling', groupId: 'g1', locked: true }),
      widget({ id: 'outsider', groupId: 'g2' }),
    ];
    const start = gridToPixel({ col: 0, row: 0, w: 2, h: 2 });
    const changes: NodeChangeLike[] = [
      { type: 'position', id: 'dragged', dragging: true, position: { x: start.x + 120, y: start.y + 100 } },
    ];
    const result = processNodeChanges({
      changes,
      widgets,
      localNodes: [
        node('dragged', start.x, start.y),
        node('sibling', start.x, start.y),
        node('lockedSibling', start.x, start.y),
        node('outsider', start.x, start.y),
      ],
    });

    expect(result.groupDragChanges).toHaveLength(1);
    expect(result.groupDragChanges[0].id).toBe('sibling');
    expect(result.groupDragChanges[0].position).toEqual({ x: start.x + 120, y: start.y + 100 });
  });

  it('drag-end commits the grid-rounded position for the dragged widget', () => {
    const w = widget({ id: 'dragged' });
    const startPx = gridToPixel(w.position);
    const endPx = { x: startPx.x + GRID_CELL_W * 2 + 30, y: startPx.y + GRID_CELL_H };

    const result = processNodeChanges({
      changes: [{ type: 'position', id: 'dragged', dragging: false, position: endPx }],
      widgets: [w],
      localNodes: [node('dragged', startPx.x, startPx.y)],
    });

    expect(result.dragEnded).toBe(true);
    expect(result.commitUpdates).toHaveLength(1);
    const pos = result.commitUpdates[0].position;
    expect(pos.col).toBe(2);
    expect(pos.row).toBe(1);
  });

  it('skips the store write when the drag stayed within the same grid cell (skip-when-same)', () => {
    const w = widget({ id: 'dragged' });
    const startPx = gridToPixel(w.position);

    const result = processNodeChanges({
      changes: [{ type: 'position', id: 'dragged', dragging: false, position: { x: startPx.x + 5, y: startPx.y + 5 } }],
      widgets: [w],
      localNodes: [node('dragged', startPx.x, startPx.y)],
    });

    expect(result.dragEnded).toBe(true);
    expect(result.commitUpdates).toHaveLength(0);
  });

  it('group commit includes dragged widget AND moved siblings as ONE update list', () => {
    const widgets = [
      widget({ id: 'dragged', groupId: 'g1' }),
      widget({ id: 'sibling', groupId: 'g1', position: { col: 4, row: 4, w: 2, h: 2 } }),
    ];
    const draggedPx = gridToPixel(widgets[0].position);
    const siblingPx = gridToPixel(widgets[1].position);

    const result = processNodeChanges({
      changes: [{
        type: 'position',
        id: 'dragged',
        dragging: false,
        position: { x: draggedPx.x + GRID_CELL_W * 3, y: draggedPx.y + GRID_CELL_H * 2 },
      }],
      widgets,
      localNodes: [
        node('dragged', draggedPx.x, draggedPx.y),
        // sibling followed the drag visually (+3 cols, +2 rows from ITS start)
        node('sibling', siblingPx.x + GRID_CELL_W * 3, siblingPx.y + GRID_CELL_H * 2),
      ],
    });

    expect(result.commitUpdates).toHaveLength(2);
    const byId = Object.fromEntries(result.commitUpdates.map((u) => [u.id, u.position]));
    expect(byId.dragged).toMatchObject({ col: 3, row: 2 });
    expect(byId.sibling).toMatchObject({ col: 7, row: 6 });
  });

  it('tracks SmartGuides payload while dragging', () => {
    const w = widget({ id: 'dragged', position: { col: 1, row: 1, w: 3, h: 4 } });
    const result = processNodeChanges({
      changes: [{ type: 'position', id: 'dragged', dragging: true, position: { x: 100, y: 200 } }],
      widgets: [w],
      localNodes: [node('dragged', 0, 0)],
    });
    expect(result.dragStarted).toBe(true);
    expect(result.guide).toEqual({
      nodeId: 'dragged',
      position: { x: 100, y: 200 },
      size: { w: 3, h: 4 },
    });
  });
});
