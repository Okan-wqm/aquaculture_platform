/**
 * UndoRedoToolbar - Shows undo/redo buttons with stack depth indicators.
 */

import React from 'react';
import { Undo2, Redo2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useScadaPackageStore } from '../../store/scada';

export const UndoRedoToolbar: React.FC = () => {
  const { undoStack, redoStack, undo, redo, canUndo, canRedo } = useScadaPackageStore(
    useShallow((s) => ({
      undoStack: s.undoStack,
      redoStack: s.redoStack,
      undo: s.undo,
      redo: s.redo,
      canUndo: s.canUndo,
      canRedo: s.canRedo,
    })),
  );

  const undoCount = undoStack.length;
  const redoCount = redoStack.length;
  const canUndoNow = canUndo();
  const canRedoNow = canRedo();

  return (
    <div className="flex items-center gap-0.5">
      <button
        onClick={undo}
        disabled={!canUndoNow}
        title={`Undo (${undoCount})`}
        className={`relative flex items-center gap-1 px-2 py-1.5 text-sm rounded-lg transition-colors ${
          canUndoNow
            ? 'text-gray-700 hover:bg-gray-100'
            : 'text-gray-500 cursor-not-allowed'
        }`}
      >
        <Undo2 className="w-4 h-4" />
        {undoCount > 0 && (
          <span className="text-[10px] text-gray-500">{undoCount}</span>
        )}
      </button>
      <button
        onClick={redo}
        disabled={!canRedoNow}
        title={`Redo (${redoCount})`}
        className={`relative flex items-center gap-1 px-2 py-1.5 text-sm rounded-lg transition-colors ${
          canRedoNow
            ? 'text-gray-700 hover:bg-gray-100'
            : 'text-gray-500 cursor-not-allowed'
        }`}
      >
        <Redo2 className="w-4 h-4" />
        {redoCount > 0 && (
          <span className="text-[10px] text-gray-500">{redoCount}</span>
        )}
      </button>
    </div>
  );
};
