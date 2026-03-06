/**
 * Zustand store for Unified SCADA Editor mode management
 *
 * 5 editor modes: P&ID, HMI, PLC, Runtime, Debug
 * Controls which panels are visible, canvas editability, and mode transitions.
 */

import { create } from 'zustand';

export type EditorMode = 'pid' | 'hmi' | 'plc' | 'runtime' | 'debug';

interface EditorModeState {
  mode: EditorMode;
  previousMode: EditorMode | null;
  isCanvasEditable: boolean;
  isPidLocked: boolean;
  isBottomPanelOpen: boolean;
  leftPanelVisible: boolean;
  rightPanelVisible: boolean;

  setMode: (mode: EditorMode) => void;
  canSwitchTo: (target: EditorMode) => boolean;
  toggleBottomPanel: () => void;
  setBottomPanelOpen: (open: boolean) => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
}

export const useEditorModeStore = create<EditorModeState>((set, get) => ({
  mode: 'pid',
  previousMode: null,
  isCanvasEditable: true,
  isPidLocked: false,
  isBottomPanelOpen: false,
  leftPanelVisible: true,
  rightPanelVisible: true,

  setMode: (newMode) => {
    const current = get().mode;
    if (current === newMode) return;
    set({
      previousMode: current,
      mode: newMode,
      isCanvasEditable: newMode === 'pid' || newMode === 'hmi',
      isPidLocked: newMode !== 'pid',
      // Auto-open bottom panel in PLC mode
      isBottomPanelOpen: newMode === 'plc' ? true : get().isBottomPanelOpen,
    });
  },

  canSwitchTo: () => {
    // All transitions are currently allowed
    return true;
  },

  toggleBottomPanel: () =>
    set((state) => ({ isBottomPanelOpen: !state.isBottomPanelOpen })),

  setBottomPanelOpen: (open) => set({ isBottomPanelOpen: open }),

  toggleLeftPanel: () =>
    set((state) => ({ leftPanelVisible: !state.leftPanelVisible })),

  toggleRightPanel: () =>
    set((state) => ({ rightPanelVisible: !state.rightPanelVisible })),
}));
