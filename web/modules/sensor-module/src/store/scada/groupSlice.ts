import type { ScadaSliceCreator, GroupSlice } from './types';
import { generateId } from './types';

export const createGroupSlice: ScadaSliceCreator<GroupSlice> = (set, get) => ({
  groupWidgets: (screenId, widgetIds) => {
    const groupId = generateId();
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const idSet = new Set(widgetIds);
      for (const widget of screen.widgets) {
        if (idSet.has(widget.id)) {
          widget.groupId = groupId;
        }
      }
      state.isDirty = true;
    });
    return groupId;
  },

  ungroupWidgets: (screenId, groupId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      for (const widget of screen.widgets) {
        if (widget.groupId === groupId) {
          widget.groupId = null;
        }
      }
      state.isDirty = true;
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
