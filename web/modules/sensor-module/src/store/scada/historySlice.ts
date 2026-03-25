import type {
  ScadaSliceCreator, HistorySlice, HistoryEntry, HistoryCheckpoint, ScadaStore,
} from './types';
import {
  MAX_UNDO_STACK, CHECKPOINT_INTERVAL, MERGE_WINDOW_MS, deepClone, generateId,
} from './types';

/* ------------------------------------------------------------------ */
/*  Merge Policy Helpers                                               */
/* ------------------------------------------------------------------ */

const MERGEABLE_TYPES = new Set(['WIDGET_MOVE', 'WIDGET_UPDATE', 'EDGE_UPDATE']);

function getMergeWindow(entryType: string): number {
  switch (entryType) {
    case 'WIDGET_MOVE': return MERGE_WINDOW_MS.WIDGET_MOVE;
    case 'WIDGET_UPDATE': return MERGE_WINDOW_MS.WIDGET_UPDATE;
    case 'EDGE_UPDATE': return MERGE_WINDOW_MS.EDGE_UPDATE;
    default: return 0;
  }
}

function getEntryTargetId(entry: HistoryEntry): string | null {
  switch (entry.type) {
    case 'WIDGET_MOVE':
    case 'WIDGET_UPDATE': return entry.widgetId;
    case 'EDGE_UPDATE': return entry.edgeId;
    default: return null;
  }
}

/**
 * Checks whether `incoming` can be merged into `existing` (top of undo stack).
 * ALL must be true: same type, same target, within time window, mergeable type, not BATCH.
 */
function canMerge(
  existing: HistoryEntry, incoming: HistoryEntry,
  lastTimestamp: number, incomingTimestamp: number,
): boolean {
  if (incoming.type === 'BATCH' || existing.type === 'BATCH') return false;
  if (!MERGEABLE_TYPES.has(incoming.type)) return false;
  if (existing.type !== incoming.type) return false;
  const existingTarget = getEntryTargetId(existing);
  const incomingTarget = getEntryTargetId(incoming);
  if (existingTarget === null || incomingTarget === null) return false;
  if (existingTarget !== incomingTarget) return false;
  const mergeWindow = getMergeWindow(incoming.type);
  if (mergeWindow <= 0) return false;
  return (incomingTimestamp - lastTimestamp) < mergeWindow;
}

/** Merges `incoming` into `existing` by updating the "after"/"to" field. */
function mergeEntries(existing: HistoryEntry, incoming: HistoryEntry, ts: number): HistoryEntry {
  switch (existing.type) {
    case 'WIDGET_MOVE':
      if (incoming.type !== 'WIDGET_MOVE') return existing;
      return { ...existing, to: incoming.to, timestamp: ts };
    case 'WIDGET_UPDATE':
      if (incoming.type !== 'WIDGET_UPDATE') return existing;
      return { ...existing, after: incoming.after, timestamp: ts };
    case 'EDGE_UPDATE':
      if (incoming.type !== 'EDGE_UPDATE') return existing;
      return { ...existing, after: incoming.after, timestamp: ts };
    default:
      return existing;
  }
}

/* ------------------------------------------------------------------ */
/*  Description Helpers                                                */
/* ------------------------------------------------------------------ */

function describeEntry(entry: HistoryEntry): string {
  switch (entry.type) {
    case 'WIDGET_ADD': return `Add ${entry.widget.widgetType ?? 'widget'}`;
    case 'WIDGET_REMOVE': return `Delete ${entry.widget.widgetType ?? 'widget'}`;
    case 'WIDGET_UPDATE': return 'Update widget';
    case 'WIDGET_MOVE': return 'Move widget';
    case 'EDGE_ADD': return 'Add edge';
    case 'EDGE_REMOVE': return 'Delete edge';
    case 'EDGE_UPDATE': return 'Update edge';
    case 'SCREEN_ADD': return `Add screen "${entry.screen.name}"`;
    case 'SCREEN_REMOVE': return `Delete screen "${entry.screen.name}"`;
    case 'SCREEN_UPDATE': return 'Update screen';
    case 'ALARM_ADD': return 'Add alarm rule';
    case 'ALARM_REMOVE': return 'Delete alarm rule';
    case 'ALARM_UPDATE': return 'Update alarm rule';
    case 'BATCH': return entry.label || `Batch (${entry.entries.length} operations)`;
  }
}

/* ------------------------------------------------------------------ */
/*  Apply undo / redo operations on Immer draft state                  */
/* ------------------------------------------------------------------ */

function applyUndo(state: ScadaStore, entry: HistoryEntry): void {
  switch (entry.type) {
    case 'WIDGET_ADD': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) screen.widgets = screen.widgets.filter((w) => w.id !== entry.widget.id);
      break;
    }
    case 'WIDGET_REMOVE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        screen.widgets.push(deepClone(entry.widget));
        for (const edge of entry.removedEdges) screen.edges.push(deepClone(edge));
      }
      break;
    }
    case 'WIDGET_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const idx = screen.widgets.findIndex((w) => w.id === entry.widgetId);
        if (idx !== -1) screen.widgets[idx] = deepClone(entry.before);
      }
      break;
    }
    case 'WIDGET_MOVE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const widget = screen.widgets.find((w) => w.id === entry.widgetId);
        if (widget) widget.position = deepClone(entry.from);
      }
      break;
    }
    case 'EDGE_ADD': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) screen.edges = screen.edges.filter((e) => e.id !== entry.edge.id);
      break;
    }
    case 'EDGE_REMOVE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) screen.edges.push(deepClone(entry.edge));
      break;
    }
    case 'EDGE_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const edge = screen.edges.find((e) => e.id === entry.edgeId);
        if (edge) edge.data = deepClone(entry.before);
      }
      break;
    }
    case 'SCREEN_ADD': {
      const idx = state.screens.findIndex((s) => s.id === entry.screen.id);
      if (idx !== -1) {
        state.screens.splice(idx, 1);
        if (state.activeScreenId === entry.screen.id) {
          state.activeScreenId = state.screens[0]?.id ?? '';
        }
      }
      break;
    }
    case 'SCREEN_REMOVE': {
      const insertIdx = Math.min(entry.index, state.screens.length);
      state.screens.splice(insertIdx, 0, deepClone(entry.screen));
      if (entry.wasActive) state.activeScreenId = entry.screen.id;
      break;
    }
    case 'SCREEN_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) Object.assign(screen, deepClone(entry.before));
      break;
    }
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
      if (ruleIdx !== -1) state.alarmRules[ruleIdx] = deepClone(entry.before);
      break;
    }
    case 'BATCH': {
      for (let i = entry.entries.length - 1; i >= 0; i--) applyUndo(state, entry.entries[i]);
      break;
    }
  }
  state.isDirty = true;
}

function applyRedo(state: ScadaStore, entry: HistoryEntry): void {
  switch (entry.type) {
    case 'WIDGET_ADD': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) screen.widgets.push(deepClone(entry.widget));
      break;
    }
    case 'WIDGET_REMOVE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        screen.widgets = screen.widgets.filter((w) => w.id !== entry.widget.id);
        const removedEdgeIds = new Set(entry.removedEdges.map((e) => e.id));
        screen.edges = screen.edges.filter((e) => !removedEdgeIds.has(e.id));
      }
      break;
    }
    case 'WIDGET_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const idx = screen.widgets.findIndex((w) => w.id === entry.widgetId);
        if (idx !== -1) screen.widgets[idx] = deepClone(entry.after);
      }
      break;
    }
    case 'WIDGET_MOVE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const widget = screen.widgets.find((w) => w.id === entry.widgetId);
        if (widget) widget.position = deepClone(entry.to);
      }
      break;
    }
    case 'EDGE_ADD': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) screen.edges.push(deepClone(entry.edge));
      break;
    }
    case 'EDGE_REMOVE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) screen.edges = screen.edges.filter((e) => e.id !== entry.edge.id);
      break;
    }
    case 'EDGE_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const edge = screen.edges.find((e) => e.id === entry.edgeId);
        if (edge) edge.data = deepClone(entry.after);
      }
      break;
    }
    case 'SCREEN_ADD': {
      state.screens.push(deepClone(entry.screen));
      break;
    }
    case 'SCREEN_REMOVE': {
      const idx = state.screens.findIndex((s) => s.id === entry.screen.id);
      if (idx !== -1) {
        state.screens.splice(idx, 1);
        if (state.activeScreenId === entry.screen.id) {
          state.activeScreenId = state.screens[0]?.id ?? '';
        }
      }
      break;
    }
    case 'SCREEN_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) Object.assign(screen, deepClone(entry.after));
      break;
    }
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
      if (ruleIdx !== -1) state.alarmRules[ruleIdx] = deepClone(entry.after);
      break;
    }
    case 'BATCH': {
      for (const sub of entry.entries) applyRedo(state, sub);
      break;
    }
  }
  state.isDirty = true;
}

/* ------------------------------------------------------------------ */
/*  Slice                                                              */
/* ------------------------------------------------------------------ */

export const createHistorySlice: ScadaSliceCreator<HistorySlice> = (set, get) => {
  let pushCounter = 0;
  let autoCheckpointNumber = 0;

  return {
    undoStack: [],
    redoStack: [],
    checkpoints: [],
    lastHistoryTimestamp: 0,

    pushHistory: (entry) =>
      set((state) => {
        const now = entry.timestamp ?? Date.now();
        const entryWithTimestamp: HistoryEntry = { ...entry, timestamp: now };

        // --- Merge policy ---
        const top = state.undoStack.length > 0
          ? state.undoStack[state.undoStack.length - 1]
          : null;

        if (top && canMerge(top, entryWithTimestamp, state.lastHistoryTimestamp, now)) {
          state.undoStack[state.undoStack.length - 1] = mergeEntries(top, entryWithTimestamp, now);
        } else {
          state.undoStack.push(entryWithTimestamp);
          pushCounter++;

          // Auto-checkpoint every CHECKPOINT_INTERVAL pushes
          if (pushCounter % CHECKPOINT_INTERVAL === 0) {
            autoCheckpointNumber++;
            const checkpoint: HistoryCheckpoint = {
              id: generateId(),
              label: `Auto-checkpoint #${autoCheckpointNumber}`,
              timestamp: now,
              stackIndex: state.undoStack.length,
            };
            state.checkpoints.push(checkpoint);
          }
        }

        state.lastHistoryTimestamp = now;
        state.redoStack = [];

        // Trim to maximum size
        if (state.undoStack.length > MAX_UNDO_STACK) {
          const excess = state.undoStack.length - MAX_UNDO_STACK;
          state.undoStack.splice(0, excess);
          for (const cp of state.checkpoints) cp.stackIndex -= excess;
          state.checkpoints = state.checkpoints.filter((cp) => cp.stackIndex > 0);
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
        state.checkpoints = [];
        state.lastHistoryTimestamp = 0;
        pushCounter = 0;
        autoCheckpointNumber = 0;
      }),

    canUndo: () => get().undoStack.length > 0,
    canRedo: () => get().redoStack.length > 0,

    undoDescription: () => {
      const { undoStack } = get();
      if (undoStack.length === 0) return '';
      return `Undo: ${describeEntry(undoStack[undoStack.length - 1])}`;
    },

    redoDescription: () => {
      const { redoStack } = get();
      if (redoStack.length === 0) return '';
      return `Redo: ${describeEntry(redoStack[redoStack.length - 1])}`;
    },

    createCheckpoint: (label) =>
      set((state) => {
        const checkpoint: HistoryCheckpoint = {
          id: generateId(),
          label,
          timestamp: Date.now(),
          stackIndex: state.undoStack.length,
        };
        state.checkpoints.push(checkpoint);
      }),

    jumpToCheckpoint: (checkpointId) => {
      const state = get();
      const checkpoint = state.checkpoints.find((cp) => cp.id === checkpointId);
      if (!checkpoint) return;

      const currentPosition = state.undoStack.length;
      const targetPosition = checkpoint.stackIndex;

      if (targetPosition < currentPosition) {
        const steps = currentPosition - targetPosition;
        for (let i = 0; i < steps; i++) get().undo();
      } else if (targetPosition > currentPosition) {
        const steps = targetPosition - currentPosition;
        for (let i = 0; i < steps; i++) get().redo();
      }
    },
  };
};
