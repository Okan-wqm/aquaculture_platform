import type {
  ScadaSliceCreator, HistorySlice, HistoryEntry, HistoryCheckpoint, ScadaStore,
  AffectedAutomationBinding,
} from './types';
import {
  MAX_UNDO_STACK, CHECKPOINT_INTERVAL, MERGE_WINDOW_MS, generateId,
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
/*  appendHistory — pure helper shared by pushHistory AND slice actions */
/*                                                                     */
/*  Slice actions call this INSIDE their own immer producer so the     */
/*  mutation and the undo-stack append commit atomically (one set()).  */
/*  Nested set() calls are forbidden.                                  */
/* ------------------------------------------------------------------ */

let autoCheckpointCounter = 0;

export function appendHistory(draft: ScadaStore, entry: HistoryEntry): void {
  // Suppressed while undo/redo itself mutates the tree: applying history
  // must never push new history nor clear the redo stack.
  if (draft.isApplyingHistory) return;

  const now = entry.timestamp ?? Date.now();
  const entryWithTimestamp: HistoryEntry = { ...entry, timestamp: now };

  // --- Merge policy ---
  const top = draft.undoStack.length > 0
    ? draft.undoStack[draft.undoStack.length - 1]
    : null;

  let pushed = false;
  if (top && canMerge(top, entryWithTimestamp, draft.lastHistoryTimestamp, now)) {
    draft.undoStack[draft.undoStack.length - 1] = mergeEntries(top, entryWithTimestamp, now);
  } else {
    draft.undoStack.push(entryWithTimestamp);
    pushed = true;
  }

  // Auto-checkpoint every CHECKPOINT_INTERVAL net pushes
  if (pushed && draft.undoStack.length % CHECKPOINT_INTERVAL === 0) {
    autoCheckpointCounter++;
    const checkpoint: HistoryCheckpoint = {
      id: generateId(),
      label: `Auto-checkpoint #${autoCheckpointCounter}`,
      timestamp: now,
      stackIndex: draft.undoStack.length,
    };
    draft.checkpoints.push(checkpoint);
  }

  draft.lastHistoryTimestamp = now;
  draft.redoStack = [];

  // Trim to maximum size
  if (draft.undoStack.length > MAX_UNDO_STACK) {
    const excess = draft.undoStack.length - MAX_UNDO_STACK;
    draft.undoStack.splice(0, excess);
    for (const cp of draft.checkpoints) cp.stackIndex -= excess;
    draft.checkpoints = draft.checkpoints.filter((cp) => cp.stackIndex > 0);
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
    case 'SCREENS_REORDER': return 'Reorder screens';
    case 'ALARM_ADD': return 'Add alarm rule';
    case 'ALARM_REMOVE': return 'Delete alarm rule';
    case 'ALARM_UPDATE': return 'Update alarm rule';
    case 'BATCH': return entry.label || `Batch (${entry.entries.length} operations)`;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers shared by applyUndo/applyRedo                              */
/* ------------------------------------------------------------------ */

/** Sort the screens array (in place, on the draft) into the given ID order. */
function sortScreensByIdOrder(state: ScadaStore, order: string[]): void {
  const index = new Map(order.map((id, i) => [id, i]));
  state.screens.sort((a, b) => {
    const ai = index.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bi = index.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

/* ------------------------------------------------------------------ */
/*  Apply undo / redo operations on Immer draft state                  */
/*                                                                     */
/*  Entries store frozen snapshots captured via immer `original()` at  */
/*  mutation time (or caller-built plain objects). They are assigned   */
/*  DIRECTLY into the draft — no re-clone. Immer copy-on-write keeps   */
/*  the stored snapshot immutable, so this is both correct and cheap.  */
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
        const insertIdx = Math.min(entry.index ?? screen.widgets.length, screen.widgets.length);
        screen.widgets.splice(insertIdx, 0, entry.widget);
        for (const edge of entry.removedEdges) screen.edges.push(edge);
      }
      // Restore automation variable bindings nulled by the removal
      if (entry.affectedBindings) {
        restoreBindings(state, entry.affectedBindings);
      }
      break;
    }
    case 'WIDGET_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const idx = screen.widgets.findIndex((w) => w.id === entry.widgetId);
        if (idx !== -1) screen.widgets[idx] = entry.before;
      }
      break;
    }
    case 'WIDGET_MOVE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const widget = screen.widgets.find((w) => w.id === entry.widgetId);
        if (widget) widget.position = entry.from;
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
      if (screen) screen.edges.push(entry.edge);
      break;
    }
    case 'EDGE_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const edge = screen.edges.find((e) => e.id === entry.edgeId);
        if (edge) {
          edge.data = entry.before;
          if (entry.beforeType) edge.type = entry.beforeType;
        }
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
      state.screens.splice(insertIdx, 0, entry.screen);
      if (entry.wasActive) state.activeScreenId = entry.screen.id;
      break;
    }
    case 'SCREEN_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) Object.assign(screen, entry.before);
      break;
    }
    case 'SCREENS_REORDER': {
      sortScreensByIdOrder(state, entry.beforeOrder);
      for (const screen of state.screens) {
        const order = entry.beforeSortOrders[screen.id];
        if (order !== undefined) screen.sortOrder = order;
      }
      break;
    }
    case 'ALARM_ADD': {
      state.alarmRules = state.alarmRules.filter((r) => r.id !== entry.rule.id);
      break;
    }
    case 'ALARM_REMOVE': {
      const insertIdx = Math.min(entry.index, state.alarmRules.length);
      state.alarmRules.splice(insertIdx, 0, entry.rule);
      break;
    }
    case 'ALARM_UPDATE': {
      const ruleIdx = state.alarmRules.findIndex((r) => r.id === entry.ruleId);
      if (ruleIdx !== -1) state.alarmRules[ruleIdx] = entry.before;
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
      if (screen) screen.widgets.push(entry.widget);
      break;
    }
    case 'WIDGET_REMOVE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        screen.widgets = screen.widgets.filter((w) => w.id !== entry.widget.id);
        const removedEdgeIds = new Set(entry.removedEdges.map((e) => e.id));
        screen.edges = screen.edges.filter((e) => !removedEdgeIds.has(e.id));
      }
      // Re-apply the automation binding cleanup the original removal did
      if (entry.affectedBindings) {
        for (const frag of entry.affectedBindings) {
          const binding = state.automationBindings.find((b) => b.programId === frag.programId);
          if (!binding) continue;
          const variable = binding.variableBindings.find((v) => v.variableId === frag.variableId);
          if (variable) {
            variable.boundWidgetId = null;
            variable.boundTag = null;
          }
        }
      }
      break;
    }
    case 'WIDGET_UPDATE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const idx = screen.widgets.findIndex((w) => w.id === entry.widgetId);
        if (idx !== -1) screen.widgets[idx] = entry.after;
      }
      break;
    }
    case 'WIDGET_MOVE': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) {
        const widget = screen.widgets.find((w) => w.id === entry.widgetId);
        if (widget) widget.position = entry.to;
      }
      break;
    }
    case 'EDGE_ADD': {
      const screen = state.screens.find((s) => s.id === entry.screenId);
      if (screen) screen.edges.push(entry.edge);
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
        if (edge) {
          edge.data = entry.after;
          if (entry.afterType) edge.type = entry.afterType;
        }
      }
      break;
    }
    case 'SCREEN_ADD': {
      state.screens.push(entry.screen);
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
      if (screen) Object.assign(screen, entry.after);
      break;
    }
    case 'SCREENS_REORDER': {
      sortScreensByIdOrder(state, entry.afterOrder);
      for (const screen of state.screens) {
        const order = entry.afterSortOrders[screen.id];
        if (order !== undefined) screen.sortOrder = order;
      }
      break;
    }
    case 'ALARM_ADD': {
      state.alarmRules.push(entry.rule);
      break;
    }
    case 'ALARM_REMOVE': {
      state.alarmRules = state.alarmRules.filter((r) => r.id !== entry.rule.id);
      break;
    }
    case 'ALARM_UPDATE': {
      const ruleIdx = state.alarmRules.findIndex((r) => r.id === entry.ruleId);
      if (ruleIdx !== -1) state.alarmRules[ruleIdx] = entry.after;
      break;
    }
    case 'BATCH': {
      for (const sub of entry.entries) applyRedo(state, sub);
      break;
    }
  }
  state.isDirty = true;
}

/** Restore previously snapshotted automation binding fragments. */
function restoreBindings(state: ScadaStore, fragments: AffectedAutomationBinding[]): void {
  for (const frag of fragments) {
    const binding = state.automationBindings.find((b) => b.programId === frag.programId);
    if (!binding) continue;
    const variable = binding.variableBindings.find((v) => v.variableId === frag.variableId);
    if (variable) {
      variable.boundWidgetId = frag.boundWidgetId;
      variable.boundTag = frag.boundTag;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Slice                                                              */
/* ------------------------------------------------------------------ */

export const createHistorySlice: ScadaSliceCreator<HistorySlice> = (set, get) => ({
  undoStack: [],
  redoStack: [],
  checkpoints: [],
  lastHistoryTimestamp: 0,
  isApplyingHistory: false,

  pushHistory: (entry) =>
    set((state) => {
      appendHistory(state, entry);
    }),

  undo: () =>
    set((state) => {
      if (state.undoStack.length === 0) return;
      state.isApplyingHistory = true;
      try {
        const entry = state.undoStack.pop()!;
        state.redoStack.push(entry);
        applyUndo(state, entry);
      } finally {
        state.isApplyingHistory = false;
      }
    }),

  redo: () =>
    set((state) => {
      if (state.redoStack.length === 0) return;
      state.isApplyingHistory = true;
      try {
        const entry = state.redoStack.pop()!;
        state.undoStack.push(entry);
        applyRedo(state, entry);
      } finally {
        state.isApplyingHistory = false;
      }
    }),

  clearHistory: () =>
    set((state) => {
      state.undoStack = [];
      state.redoStack = [];
      state.checkpoints = [];
      state.lastHistoryTimestamp = 0;
      autoCheckpointCounter = 0;
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

  // ONE producer for the whole jump: pop/push entries in a loop inside a
  // single immer set() — no intermediate states, no re-entrant set() calls.
  jumpToCheckpoint: (checkpointId) =>
    set((state) => {
      const checkpoint = state.checkpoints.find((cp) => cp.id === checkpointId);
      if (!checkpoint) return;

      const currentPosition = state.undoStack.length;
      const targetPosition = checkpoint.stackIndex;
      if (targetPosition === currentPosition) return;

      state.isApplyingHistory = true;
      try {
        if (targetPosition < currentPosition) {
          const steps = currentPosition - targetPosition;
          for (let i = 0; i < steps; i++) {
            const entry = state.undoStack.pop();
            if (!entry) break;
            state.redoStack.push(entry);
            applyUndo(state, entry);
          }
        } else {
          const steps = targetPosition - currentPosition;
          for (let i = 0; i < steps; i++) {
            const entry = state.redoStack.pop();
            if (!entry) break;
            state.undoStack.push(entry);
            applyRedo(state, entry);
          }
        }
      } finally {
        state.isApplyingHistory = false;
      }
    }),
});
