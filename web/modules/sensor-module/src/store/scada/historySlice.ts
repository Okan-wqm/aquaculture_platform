import type { ScadaSliceCreator, HistorySlice, HistoryEntry, ScadaStore } from './types';
import { MAX_UNDO_STACK, deepClone } from './types';

/* ------------------------------------------------------------------ */
/*  Apply undo / redo operations on Immer draft state                  */
/* ------------------------------------------------------------------ */

function applyUndo(state: ScadaStore, entry: HistoryEntry): void {
  switch (entry.type) {
    /* ---- Widget ---- */
    case 'WIDGET_ADD': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        screen.widgets = screen.widgets.filter((w) => w.id !== entry.widget.id);
      }
      break;
    }

    case 'WIDGET_REMOVE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        // Re-insert the widget
        screen.widgets.push(deepClone(entry.widget));
        // Re-insert the edges that were removed alongside the widget
        for (const edge of entry.removedEdges) {
          screen.edges.push(deepClone(edge));
        }
      }
      break;
    }

    case 'WIDGET_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const idx = screen.widgets.findIndex((w) => w.id === entry.widgetId);
        if (idx !== -1) {
          screen.widgets[idx] = deepClone(entry.before);
        }
      }
      break;
    }

    case 'WIDGET_MOVE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const widget = screen.widgets.find((w) => w.id === entry.widgetId);
        if (widget) {
          widget.position = deepClone(entry.from);
        }
      }
      break;
    }

    /* ---- Edge ---- */
    case 'EDGE_ADD': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        screen.edges = screen.edges.filter((e) => e.id !== entry.edge.id);
      }
      break;
    }

    case 'EDGE_REMOVE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        screen.edges.push(deepClone(entry.edge));
      }
      break;
    }

    case 'EDGE_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const edge = screen.edges.find((e) => e.id === entry.edgeId);
        if (edge) {
          edge.data = deepClone(entry.before);
        }
      }
      break;
    }

    /* ---- Screen ---- */
    case 'SCREEN_ADD': {
      const idx = state.screens.findIndex((s) => s.id === entry.screen.id);
      if (idx !== -1) {
        state.screens.splice(idx, 1);
        // If the removed screen was the active one, switch to the first remaining
        if (state.activeScreenId === entry.screen.id) {
          state.activeScreenId = state.screens[0]?.id ?? '';
        }
      }
      break;
    }

    case 'SCREEN_REMOVE': {
      // Re-insert the screen at its original position
      const insertIdx = Math.min(entry.index, state.screens.length);
      state.screens.splice(insertIdx, 0, deepClone(entry.screen));
      // If it was the active screen, restore that
      if (entry.wasActive) {
        state.activeScreenId = entry.screen.id;
      }
      break;
    }

    case 'SCREEN_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        Object.assign(screen, deepClone(entry.before));
      }
      break;
    }

    /* ---- Alarm ---- */
    case 'ALARM_ADD': {
      state.alarmRules = state.alarmRules.filter((r) => r.id !== entry.rule.id);
      break;
    }

    case 'ALARM_REMOVE': {
      const insertIdx = Math.min(entry.index, state.alarmRules.length);
      state.alarmRules.splice(insertIdx, 0, deepClone(entry.rule));
      break;
    }

    case 'ALARM_UPDATE': {
      const ruleIdx = state.alarmRules.findIndex((r) => r.id === entry.ruleId);
      if (ruleIdx !== -1) {
        state.alarmRules[ruleIdx] = deepClone(entry.before);
      }
      break;
    }

    /* ---- Batch ---- */
    case 'BATCH': {
      // Apply undo in REVERSE order
      for (let i = entry.entries.length - 1; i >= 0; i--) {
        applyUndo(state, entry.entries[i]);
      }
      break;
    }
  }

  state.isDirty = true;
}

function applyRedo(state: ScadaStore, entry: HistoryEntry): void {
  switch (entry.type) {
    /* ---- Widget ---- */
    case 'WIDGET_ADD': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        screen.widgets.push(deepClone(entry.widget));
      }
      break;
    }

    case 'WIDGET_REMOVE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        // Remove the widget
        screen.widgets = screen.widgets.filter((w) => w.id !== entry.widget.id);
        // Remove edges that were associated with the widget
        const removedEdgeIds = new Set(entry.removedEdges.map((e) => e.id));
        screen.edges = screen.edges.filter((e) => !removedEdgeIds.has(e.id));
      }
      break;
    }

    case 'WIDGET_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const idx = screen.widgets.findIndex((w) => w.id === entry.widgetId);
        if (idx !== -1) {
          screen.widgets[idx] = deepClone(entry.after);
        }
      }
      break;
    }

    case 'WIDGET_MOVE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const widget = screen.widgets.find((w) => w.id === entry.widgetId);
        if (widget) {
          widget.position = deepClone(entry.to);
        }
      }
      break;
    }

    /* ---- Edge ---- */
    case 'EDGE_ADD': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        screen.edges.push(deepClone(entry.edge));
      }
      break;
    }

    case 'EDGE_REMOVE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        screen.edges = screen.edges.filter((e) => e.id !== entry.edge.id);
      }
      break;
    }

    case 'EDGE_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const edge = screen.edges.find((e) => e.id === entry.edgeId);
        if (edge) {
          edge.data = deepClone(entry.after);
        }
      }
      break;
    }

    /* ---- Screen ---- */
    case 'SCREEN_ADD': {
      state.screens.push(deepClone(entry.screen));
      break;
    }

    case 'SCREEN_REMOVE': {
      const idx = state.screens.findIndex((s) => s.id === entry.screen.id);
      if (idx !== -1) {
        state.screens.splice(idx, 1);
        // If the removed screen was active, switch to first remaining
        if (state.activeScreenId === entry.screen.id) {
          state.activeScreenId = state.screens[0]?.id ?? '';
        }
      }
      break;
    }

    case 'SCREEN_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        Object.assign(screen, deepClone(entry.after));
      }
      break;
    }

    /* ---- Alarm ---- */
    case 'ALARM_ADD': {
      state.alarmRules.push(deepClone(entry.rule));
      break;
    }

    case 'ALARM_REMOVE': {
      state.alarmRules = state.alarmRules.filter((r) => r.id !== entry.rule.id);
      break;
    }

    case 'ALARM_UPDATE': {
      const ruleIdx = state.alarmRules.findIndex((r) => r.id === entry.ruleId);
      if (ruleIdx !== -1) {
        state.alarmRules[ruleIdx] = deepClone(entry.after);
      }
      break;
    }

    /* ---- Batch ---- */
    case 'BATCH': {
      // Apply redo in FORWARD order
      for (const sub of entry.entries) {
        applyRedo(state, sub);
      }
      break;
    }
  }

  state.isDirty = true;
}

/* ------------------------------------------------------------------ */
/*  Slice                                                              */
/* ------------------------------------------------------------------ */

export const createHistorySlice: ScadaSliceCreator<HistorySlice> = (set, get) => ({
  undoStack: [],
  redoStack: [],

  pushHistory: (entry) =>
    set((state) => {
      state.undoStack.push(entry);
      // New action invalidates the redo chain
      state.redoStack = [];
      // Trim to maximum size (remove oldest entries from the front)
      if (state.undoStack.length > MAX_UNDO_STACK) {
        state.undoStack.splice(0, state.undoStack.length - MAX_UNDO_STACK);
      }
    }),

  undo: () =>
    set((state) => {
      if (state.undoStack.length === 0) return;
      const entry = state.undoStack.pop()!;
      state.redoStack.push(entry);
      applyUndo(state, entry);
    }),

  redo: () =>
    set((state) => {
      if (state.redoStack.length === 0) return;
      const entry = state.redoStack.pop()!;
      state.undoStack.push(entry);
      applyRedo(state, entry);
    }),

  clearHistory: () =>
    set((state) => {
      state.undoStack = [];
      state.redoStack = [];
    }),

  canUndo: () => get().undoStack.length > 0,

  canRedo: () => get().redoStack.length > 0,
});
