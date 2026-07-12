/**
 * Zustand store for Unified SCADA Editor mode management
 *
 * 5 editor modes: P&ID, HMI, PLC, Runtime, Debug
 * Controls which panels are visible, canvas editability, and mode transitions.
 */

import { create } from 'zustand';
import { registerLogoutCleanup, onTenantChange } from '@aquaculture/shared-ui';

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
  reset: () => void;
}

const INITIAL_EDITOR_MODE_STATE = {
  mode: 'pid' as EditorMode,
  previousMode: null as EditorMode | null,
  isCanvasEditable: true,
  isPidLocked: false,
  isBottomPanelOpen: false,
  leftPanelVisible: true,
  rightPanelVisible: true,
};

export const useEditorModeStore = create<EditorModeState>((set, get) => ({
  ...INITIAL_EDITOR_MODE_STATE,

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

  canSwitchTo: (_target: EditorMode) => {
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

  reset: () => set({ ...INITIAL_EDITOR_MODE_STATE }),
}));

// SECURITY (SENSOR-HIGH-041): the editor-mode store is a single-active,
// tenant-owned view of the SCADA editor. Fully reset it on logout and on any
// tenant switch so tenant A's editor state never carries into tenant B's
// session. onTenantChange fires only on an actual A->B change, never first login.
registerLogoutCleanup(() => useEditorModeStore.getState().reset());
onTenantChange(() => useEditorModeStore.getState().reset());
