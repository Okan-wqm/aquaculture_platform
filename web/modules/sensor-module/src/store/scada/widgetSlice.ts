import { original } from 'immer';
import type {
  ScadaSliceCreator, WidgetSlice, ScreenWidget, ScadaStore, HistoryEntry,
  AffectedAutomationBinding, WidgetPosition,
} from './types';
import { appendHistory } from './historySlice';

/* ------------------------------------------------------------------ */
/*  Helper: resolve effective z-index for a widget.                    */
/*  Treats undefined/null as 0 so sparse z-index math is safe.        */
/* ------------------------------------------------------------------ */

function zOf(widget: ScreenWidget): number {
  return widget.zIndex ?? 0;
}

/**
 * Pre-mutation snapshot helpers. `original(draft)` returns the frozen
 * previous state the producer started from — the value history entries
 * must capture. Never structuredClone a draft proxy (DataCloneError) and
 * never JSON-clone state that history can hold by reference: storing the
 * `original()` object itself is safe because Immer copy-on-write leaves it
 * untouched when the draft is mutated.
 */
function prevScreen(state: ScadaStore, screenId: string) {
  const prev = original(state) ?? state;
  return prev.screens.find((s) => s.id === screenId);
}

function prevWidget(state: ScadaStore, screenId: string, widgetId: string): ScreenWidget | undefined {
  return prevScreen(state, screenId)?.widgets.find((w) => w.id === widgetId);
}

/** Snapshot automation variable bindings pointing at the given widget. */
function snapshotBindingsForWidget(
  state: ScadaStore,
  widgetId: string,
): AffectedAutomationBinding[] {
  const prev = original(state) ?? state;
  const fragments: AffectedAutomationBinding[] = [];
  for (const binding of prev.automationBindings) {
    for (const vb of binding.variableBindings) {
      if (vb.boundWidgetId === widgetId) {
        fragments.push({
          programId: binding.programId,
          variableId: vb.variableId,
          boundWidgetId: vb.boundWidgetId,
          boundTag: vb.boundTag,
        });
      }
    }
  }
  return fragments;
}

/** Null out automation variable bindings pointing at the given widget (draft). */
function nullBindingsForWidget(state: ScadaStore, widgetId: string): void {
  for (const binding of state.automationBindings) {
    for (const vb of binding.variableBindings) {
      if (vb.boundWidgetId === widgetId) {
        vb.boundWidgetId = null;
        vb.boundTag = null;
      }
    }
  }
}

export const createWidgetSlice: ScadaSliceCreator<WidgetSlice> = (set, _get) => ({
  addWidget: (screenId, widget) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      screen.widgets.push(widget);
      state.isDirty = true;
      appendHistory(state, { type: 'WIDGET_ADD', screenId, widget });
    }),

  removeWidget: (screenId, widgetId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;

      const prev = prevScreen(state, screenId);
      const before = prev?.widgets.find((w) => w.id === widgetId);
      if (!before) return;

      const removedEdges = prev
        ? prev.edges.filter((e) => e.source === widgetId || e.target === widgetId)
        : [];
      const index = prev ? prev.widgets.findIndex((w) => w.id === widgetId) : -1;
      const affectedBindings = snapshotBindingsForWidget(state, widgetId);

      // Check if selectedEdgeId references an edge that will be removed
      if (state.selectedEdgeId) {
        const edgeBeingRemoved = screen.edges.some(
          (e) =>
            e.id === state.selectedEdgeId &&
            (e.source === widgetId || e.target === widgetId),
        );
        if (edgeBeingRemoved) {
          state.selectedEdgeId = null;
        }
      }

      // Remove widget
      screen.widgets = screen.widgets.filter((w) => w.id !== widgetId);

      // Remove edges referencing this widget
      screen.edges = screen.edges.filter(
        (e) => e.source !== widgetId && e.target !== widgetId,
      );

      // Clean up automation bindings
      nullBindingsForWidget(state, widgetId);

      // Clear selected widget if it was this one
      if (state.selectedWidgetId === widgetId) {
        state.selectedWidgetId = null;
      }

      state.isDirty = true;
      appendHistory(state, {
        type: 'WIDGET_REMOVE',
        screenId,
        widget: before,
        removedEdges,
        ...(index >= 0 ? { index } : {}),
        ...(affectedBindings.length > 0 ? { affectedBindings } : {}),
      });
    }),

  removeWidgets: (screenId, widgetIds) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;

      const prev = prevScreen(state, screenId);
      if (!prev) return;

      const entries: HistoryEntry[] = [];
      for (const widgetId of widgetIds) {
        const before = prev.widgets.find((w) => w.id === widgetId);
        if (!before) continue;
        const removedEdges = prev.edges.filter(
          (e) => e.source === widgetId || e.target === widgetId,
        );
        const index = prev.widgets.findIndex((w) => w.id === widgetId);
        const affectedBindings = snapshotBindingsForWidget(state, widgetId);

        screen.widgets = screen.widgets.filter((w) => w.id !== widgetId);
        screen.edges = screen.edges.filter(
          (e) => e.source !== widgetId && e.target !== widgetId,
        );
        nullBindingsForWidget(state, widgetId);

        if (state.selectedWidgetId === widgetId) {
          state.selectedWidgetId = null;
        }

        entries.push({
          type: 'WIDGET_REMOVE',
          screenId,
          widget: before,
          removedEdges,
          ...(index >= 0 ? { index } : {}),
          ...(affectedBindings.length > 0 ? { affectedBindings } : {}),
        });
      }

      if (entries.length === 0) return;
      state.selectedWidgetIds = [];
      state.isDirty = true;
      appendHistory(state, {
        type: 'BATCH',
        label: `Delete ${entries.length} widget${entries.length > 1 ? 's' : ''}`,
        entries,
      });
    }),

  updateWidget: (screenId, widgetId, updates) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      const before = prevWidget(state, screenId, widgetId);
      if (!before) return;
      Object.assign(widget, updates);
      state.isDirty = true;
      appendHistory(state, {
        type: 'WIDGET_UPDATE',
        screenId,
        widgetId,
        before,
        // Merge over the pre-mutation snapshot: `updates` is caller-built
        // plain data, so the result is a plain (non-draft) object.
        after: { ...before, ...updates },
      });
    }),

  updateWidgetPosition: (screenId, widgetId, position) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      if (widget.locked) return;
      const before = prevWidget(state, screenId, widgetId);
      if (!before) return;
      const from: WidgetPosition = before.position;
      widget.position = position;
      state.isDirty = true;
      // Position (and size — resize flows through here too) changes merge
      // into one entry per widget within MERGE_WINDOW_MS.WIDGET_MOVE.
      appendHistory(state, {
        type: 'WIDGET_MOVE',
        screenId,
        widgetId,
        from,
        to: position,
      });
    }),

  moveWidgets: (screenId, updates) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const prev = prevScreen(state, screenId);
      if (!prev) return;

      const entries: HistoryEntry[] = [];
      for (const { id, position } of updates) {
        const before = prev.widgets.find((w) => w.id === id);
        if (!before || before.locked) continue;
        if (
          before.position.col === position.col &&
          before.position.row === position.row &&
          before.position.w === position.w &&
          before.position.h === position.h
        ) {
          continue;
        }
        const widget = screen.widgets.find((w) => w.id === id);
        if (!widget || widget.locked) continue;
        widget.position = position;
        entries.push({
          type: 'WIDGET_MOVE',
          screenId,
          widgetId: id,
          from: before.position,
          to: position,
        });
      }

      if (entries.length === 0) return;
      state.isDirty = true;
      appendHistory(state, {
        type: 'BATCH',
        label: entries.length > 1 ? `Move ${entries.length} widgets` : 'Move widget',
        entries,
      });
    }),

  /* ---------------------------------------------------------------- */
  /*  Layer management — sparse z-index strategy                       */
  /*                                                                   */
  /*  Instead of maintaining consecutive indices (0,1,2,3...) which    */
  /*  requires O(n) renumbering on every reorder, we use sparse gaps   */
  /*  of 10 between layers. This means bringToFront/sendToBack only    */
  /*  touch a single widget. bringForward/sendBackward swap z-indices  */
  /*  between two adjacent widgets.                                    */
  /*                                                                   */
  /*  The array order in screen.widgets is also maintained for legacy   */
  /*  compatibility — older code that relies on array position for     */
  /*  rendering order still works correctly.                           */
  /* ---------------------------------------------------------------- */

  bringToFront: (screenId, widgetId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget || widget.locked) return;
      const before = prevWidget(state, screenId, widgetId);
      if (!before) return;

      const maxZ = screen.widgets.reduce((max, w) => Math.max(max, zOf(w)), 0);
      // Only update if not already the topmost
      if (zOf(widget) < maxZ || screen.widgets.length === 1) {
        widget.zIndex = maxZ + 10;
      }

      // Also maintain array order for legacy compatibility
      const idx = screen.widgets.findIndex((w) => w.id === widgetId);
      if (idx !== -1 && idx !== screen.widgets.length - 1) {
        const [removed] = screen.widgets.splice(idx, 1);
        screen.widgets.push(removed);
      }

      state.isDirty = true;
      appendHistory(state, {
        type: 'WIDGET_UPDATE',
        screenId,
        widgetId,
        before,
        after: { ...before, zIndex: widget.zIndex },
      });
    }),

  sendToBack: (screenId, widgetId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget || widget.locked) return;
      const before = prevWidget(state, screenId, widgetId);
      if (!before) return;

      const minZ = screen.widgets.reduce((min, w) => Math.min(min, zOf(w)), 0);
      // Only update if not already the bottommost
      if (zOf(widget) > minZ || screen.widgets.length === 1) {
        widget.zIndex = minZ - 10;
      }

      // Also maintain array order for legacy compatibility
      const idx = screen.widgets.findIndex((w) => w.id === widgetId);
      if (idx > 0) {
        const [removed] = screen.widgets.splice(idx, 1);
        screen.widgets.unshift(removed);
      }

      state.isDirty = true;
      appendHistory(state, {
        type: 'WIDGET_UPDATE',
        screenId,
        widgetId,
        before,
        after: { ...before, zIndex: widget.zIndex },
      });
    }),

  bringForward: (screenId, widgetId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget || widget.locked) return;
      const prev = prevScreen(state, screenId);
      if (!prev) return;

      // Sort all widgets by z-index ascending to find the one directly above
      const sorted = [...screen.widgets].sort((a, b) => zOf(a) - zOf(b));
      const sortedIdx = sorted.findIndex((w) => w.id === widgetId);

      // Already at top — no-op
      if (sortedIdx === sorted.length - 1) return;

      // Swap z-indices with the widget directly above
      const above = sorted[sortedIdx + 1];
      const beforeSelf = prev.widgets.find((w) => w.id === widgetId)!;
      const beforeAbove = prev.widgets.find((w) => w.id === above.id)!;
      const currentZ = zOf(widget);
      const aboveZ = zOf(above);

      const entries: HistoryEntry[] = [];

      // If they have the same z-index, nudge the target up by 1 instead of swapping
      if (currentZ === aboveZ) {
        widget.zIndex = aboveZ + 1;
      } else {
        widget.zIndex = aboveZ;
        above.zIndex = currentZ;
        entries.push({
          type: 'WIDGET_UPDATE',
          screenId,
          widgetId: above.id,
          before: beforeAbove,
          after: { ...beforeAbove, zIndex: currentZ },
        });
      }

      entries.push({
        type: 'WIDGET_UPDATE',
        screenId,
        widgetId,
        before: beforeSelf,
        after: { ...beforeSelf, zIndex: widget.zIndex },
      });

      state.isDirty = true;
      appendHistory(state, { type: 'BATCH', label: 'Bring forward', entries });
    }),

  sendBackward: (screenId, widgetId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget || widget.locked) return;
      const prev = prevScreen(state, screenId);
      if (!prev) return;

      // Sort all widgets by z-index ascending to find the one directly below
      const sorted = [...screen.widgets].sort((a, b) => zOf(a) - zOf(b));
      const sortedIdx = sorted.findIndex((w) => w.id === widgetId);

      // Already at bottom — no-op
      if (sortedIdx === 0) return;

      // Swap z-indices with the widget directly below
      const below = sorted[sortedIdx - 1];
      const beforeSelf = prev.widgets.find((w) => w.id === widgetId)!;
      const beforeBelow = prev.widgets.find((w) => w.id === below.id)!;
      const currentZ = zOf(widget);
      const belowZ = zOf(below);

      const entries: HistoryEntry[] = [];

      // If they have the same z-index, nudge the target down by 1
      if (currentZ === belowZ) {
        widget.zIndex = belowZ - 1;
      } else {
        widget.zIndex = belowZ;
        below.zIndex = currentZ;
        entries.push({
          type: 'WIDGET_UPDATE',
          screenId,
          widgetId: below.id,
          before: beforeBelow,
          after: { ...beforeBelow, zIndex: currentZ },
        });
      }

      entries.push({
        type: 'WIDGET_UPDATE',
        screenId,
        widgetId,
        before: beforeSelf,
        after: { ...beforeSelf, zIndex: widget.zIndex },
      });

      state.isDirty = true;
      appendHistory(state, { type: 'BATCH', label: 'Send backward', entries });
    }),

  setWidgetZIndex: (screenId, widgetId, zIndex) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      const before = prevWidget(state, screenId, widgetId);
      if (!before) return;
      widget.zIndex = zIndex;
      state.isDirty = true;
      appendHistory(state, {
        type: 'WIDGET_UPDATE',
        screenId,
        widgetId,
        before,
        after: { ...before, zIndex },
      });
    }),

  toggleWidgetLock: (screenId, widgetId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      const before = prevWidget(state, screenId, widgetId);
      if (!before) return;
      widget.locked = !widget.locked;
      state.isDirty = true;
      appendHistory(state, {
        type: 'WIDGET_UPDATE',
        screenId,
        widgetId,
        before,
        after: { ...before, locked: widget.locked },
      });
    }),

  toggleWidgetVisibility: (screenId, widgetId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      const before = prevWidget(state, screenId, widgetId);
      if (!before) return;
      // Default is visible (true); toggle flips it
      widget.visible = widget.visible === false ? true : false;
      state.isDirty = true;
      appendHistory(state, {
        type: 'WIDGET_UPDATE',
        screenId,
        widgetId,
        before,
        after: { ...before, visible: widget.visible },
      });
    }),
});
