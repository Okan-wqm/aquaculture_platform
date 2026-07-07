import React, { useCallback } from 'react';
import {
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  GripHorizontal,
  GripVertical,
  Focus,
} from 'lucide-react';
import { useScadaPackageStore } from '../../store/scada';
import type { WidgetPosition } from '../../store/scada/types';
import {
  alignLeft,
  alignRight,
  alignTop,
  alignBottom,
  alignCenterH,
  alignCenterV,
  distributeH,
  distributeV,
} from '../../store/scada/alignmentUtils';
import { GRID_CELL_W, GRID_CELL_H } from '../../constants/scada-widget-sizes';

type WidgetRect = { id: string; position: WidgetPosition };
type AlignFn = (widgets: WidgetRect[]) => Map<string, WidgetPosition>;

export const AlignmentToolbar: React.FC = () => {
  const selectedWidgetIds = useScadaPackageStore((s) => s.selectedWidgetIds);

  const getSelectedRects = useCallback((): WidgetRect[] => {
    const state = useScadaPackageStore.getState();
    const screen = state.screens.find((s) => s.id === state.activeScreenId);
    if (!screen) return [];

    const selectedSet = new Set(state.selectedWidgetIds);
    return screen.widgets
      .filter((w) => selectedSet.has(w.id))
      .map((w) => ({ id: w.id, position: { ...w.position } }));
  }, []);

  const handleAlign = useCallback((alignFn: AlignFn) => {
    const state = useScadaPackageStore.getState();
    const rects = getSelectedRects();
    if (rects.length === 0) return;

    const updates = alignFn(rects);
    updates.forEach((pos, id) => {
      state.updateWidgetPosition(state.activeScreenId, id, pos);
    });
  }, [getSelectedRects]);

  const handleZoomToSelection = useCallback(() => {
    const rects = getSelectedRects();
    if (rects.length === 0) return;

    const minX = Math.min(...rects.map((r) => r.position.col * GRID_CELL_W));
    const minY = Math.min(...rects.map((r) => r.position.row * GRID_CELL_H));
    const maxX = Math.max(...rects.map((r) => (r.position.col + r.position.w) * GRID_CELL_W));
    const maxY = Math.max(...rects.map((r) => (r.position.row + r.position.h) * GRID_CELL_H));

    window.dispatchEvent(
      new CustomEvent('scada-zoom-to-bounds', {
        detail: { minX, minY, maxX, maxY, padding: 50 },
      }),
    );
  }, [getSelectedRects]);

  if (selectedWidgetIds.length < 2) return null;

  const canDistribute = selectedWidgetIds.length >= 3;

  return (
    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-0.5 bg-white rounded-lg shadow-lg border border-gray-200 px-2 py-1">
      {/* Count badge */}
      <span className="text-xs text-gray-500 mr-1.5 select-none whitespace-nowrap">
        {selectedWidgetIds.length} selected
      </span>

      {/* Align Left */}
      <button
        className="p-1.5 rounded hover:bg-gray-100 text-gray-600 hover:text-gray-900"
        title="Align Left"
        onClick={() => handleAlign(alignLeft)}
      >
        <AlignStartVertical className="w-4 h-4" />
      </button>

      {/* Align Center Horizontal */}
      <button
        className="p-1.5 rounded hover:bg-gray-100 text-gray-600 hover:text-gray-900"
        title="Align Center Horizontally"
        onClick={() => handleAlign(alignCenterH)}
      >
        <AlignCenterVertical className="w-4 h-4" />
      </button>

      {/* Align Right */}
      <button
        className="p-1.5 rounded hover:bg-gray-100 text-gray-600 hover:text-gray-900"
        title="Align Right"
        onClick={() => handleAlign(alignRight)}
      >
        <AlignEndVertical className="w-4 h-4" />
      </button>

      {/* Separator */}
      <div className="w-px h-5 bg-gray-200 mx-1" />

      {/* Align Top */}
      <button
        className="p-1.5 rounded hover:bg-gray-100 text-gray-600 hover:text-gray-900"
        title="Align Top"
        onClick={() => handleAlign(alignTop)}
      >
        <AlignStartHorizontal className="w-4 h-4" />
      </button>

      {/* Align Center Vertical */}
      <button
        className="p-1.5 rounded hover:bg-gray-100 text-gray-600 hover:text-gray-900"
        title="Align Center Vertically"
        onClick={() => handleAlign(alignCenterV)}
      >
        <AlignCenterHorizontal className="w-4 h-4" />
      </button>

      {/* Align Bottom */}
      <button
        className="p-1.5 rounded hover:bg-gray-100 text-gray-600 hover:text-gray-900"
        title="Align Bottom"
        onClick={() => handleAlign(alignBottom)}
      >
        <AlignEndHorizontal className="w-4 h-4" />
      </button>

      {/* Separator */}
      <div className="w-px h-5 bg-gray-200 mx-1" />

      {/* Distribute Horizontal */}
      <button
        className={`p-1.5 rounded ${
          canDistribute
            ? 'hover:bg-gray-100 text-gray-600 hover:text-gray-900'
            : 'text-gray-500 cursor-not-allowed'
        }`}
        title="Distribute Horizontally"
        disabled={!canDistribute}
        onClick={() => handleAlign(distributeH)}
      >
        <GripHorizontal className="w-4 h-4" />
      </button>

      {/* Distribute Vertical */}
      <button
        className={`p-1.5 rounded ${
          canDistribute
            ? 'hover:bg-gray-100 text-gray-600 hover:text-gray-900'
            : 'text-gray-500 cursor-not-allowed'
        }`}
        title="Distribute Vertically"
        disabled={!canDistribute}
        onClick={() => handleAlign(distributeV)}
      >
        <GripVertical className="w-4 h-4" />
      </button>

      {/* Separator */}
      <div className="w-px h-5 bg-gray-200 mx-1" />

      {/* Zoom to Selection */}
      <button
        className="p-1.5 rounded hover:bg-gray-100 text-gray-600 hover:text-gray-900"
        title="Focus on Selection"
        onClick={handleZoomToSelection}
      >
        <Focus className="w-4 h-4" />
      </button>
    </div>
  );
};
