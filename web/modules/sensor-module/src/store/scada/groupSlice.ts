import { original } from 'immer';
import type { ScadaSliceCreator, GroupSlice, ScadaStore, HistoryEntry } from './types';
import { generateId } from './types';
import { appendHistory } from './historySlice';

export const createGroupSlice: ScadaSliceCreator<GroupSlice> = (set, get) => ({
  groupWidgets: (screenId, widgetIds) => {
    const groupId = generateId();
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const prev = original(state) ?? state;
      const prevScreen = prev.screens.find((s) => s.id === screenId);
      if (!prevScreen) return;

      const idSet = new Set(widgetIds);
      const entries: HistoryEntry[] = [];
      for (const widget of screen.widgets) {
        if (idSet.has(widget.id)) {
          const before = prevScreen.widgets.find((w) => w.id === widget.id);
          if (before) {
            entries.push({
              type: 'WIDGET_UPDATE',
              screenId,
              widgetId: widget.id,
              before,
              after: { ...before, groupId },
            });
          }
          widget.groupId = groupId;
        }
      }
      if (entries.length === 0) return;
      state.isDirty = true;
      appendHistory(state, {
        type: 'BATCH',
        label: `Group ${entries.length} widgets`,
        entries,
      });
    });
    return groupId;
  },

  ungroupWidgets: (screenId, groupId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const prev = original(state) ?? state;
      const prevScreen = prev.screens.find((s) => s.id === screenId);
      if (!prevScreen) return;

      const entries: HistoryEntry[] = [];
      for (const widget of screen.widgets) {
        if (widget.groupId === groupId) {
          const before = prevScreen.widgets.find((w) => w.id === widget.id);
          if (before) {
            entries.push({
              type: 'WIDGET_UPDATE',
              screenId,
              widgetId: widget.id,
              before,
              after: { ...before, groupId: null },
            });
          }
          widget.groupId = null;
        }
      }
      if (entries.length === 0) return;
      state.isDirty = true;
      appendHistory(state, {
        type: 'BATCH',
        label: 'Ungroup widgets',
        entries,
      });
    }),

  getGroupMembers: (screenId, groupId) => {
    const state = get();
    const screen = state.screens.find((s) => s.id === screenId);
    if (!screen) return [];
    return screen.widgets
      .filter((w) => w.groupId === groupId)
      .map((w) => w.id);
  },
});
