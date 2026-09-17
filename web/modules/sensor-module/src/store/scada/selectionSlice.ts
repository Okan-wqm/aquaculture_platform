import { original } from 'immer';
import type { ScadaSliceCreator, SelectionSlice, ScadaStore, HistoryEntry, AffectedAutomationBinding } from './types';
import { generateId, deepClone } from './types';
import { appendHistory } from './historySlice';

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

export const createSelectionSlice: ScadaSliceCreator<SelectionSlice> = (set, get) => ({
  // State
  selectedWidgetId: null,
  selectedWidgetIds: [],
  selectedEdgeId: null,
  clipboard: null,
  highlightedWidgetId: null,
  pasteCount: 0,

  // --- Selection (mutual exclusion) ---

  setSelectedWidget: (id) =>
    set((state) => {
      state.selectedWidgetId = id;
      state.selectedWidgetIds = id ? [id] : [];
      if (id !== null) {
        state.selectedEdgeId = null;
      }
    }),

  setSelectedEdge: (id) =>
    set((state) => {
      state.selectedEdgeId = id;
      if (id !== null) {
        state.selectedWidgetId = null;
        state.selectedWidgetIds = [];
      }
    }),

  toggleWidgetSelection: (id) =>
    set((state) => {
      const idx = state.selectedWidgetIds.indexOf(id);
      if (idx === -1) {
        // Add to selection
        state.selectedWidgetIds.push(id);
        state.selectedWidgetId = id;
      } else {
        // Remove from selection
        state.selectedWidgetIds.splice(idx, 1);
        state.selectedWidgetId = state.selectedWidgetIds[state.selectedWidgetIds.length - 1] ?? null;
      }
      state.selectedEdgeId = null;
    }),

  selectGroup: (screenId, groupId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const groupWidgetIds = screen.widgets
        .filter((w) => w.groupId === groupId)
        .map((w) => w.id);
      if (groupWidgetIds.length === 0) return;
      state.selectedWidgetIds = groupWidgetIds;
      state.selectedWidgetId = groupWidgetIds[0];
      state.selectedEdgeId = null;
    }),

  selectAllWidgets: () =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === state.activeScreenId);
      if (!screen || screen.widgets.length === 0) return;
      state.selectedWidgetIds = screen.widgets.map((w) => w.id);
      state.selectedWidgetId = state.selectedWidgetIds[0] ?? null;
      state.selectedEdgeId = null;
    }),

  deselectAll: () =>
    set((state) => {
      state.selectedWidgetId = null;
      state.selectedWidgetIds = [];
      state.selectedEdgeId = null;
    }),

  // --- Clipboard ---

  copySelectedWidgets: () =>
    set((state) => {
      const { selectedWidgetIds, activeScreenId, screens } = state;
      if (selectedWidgetIds.length === 0) return;

      const screen = screens.find((s) => s.id === activeScreenId);
      if (!screen) return;

      const selectedSet = new Set(selectedWidgetIds);
      const widgets = screen.widgets.filter((w) => selectedSet.has(w.id));
      if (widgets.length === 0) return;

      // Collect edges where BOTH source and target are in the selection
      const matchingEdges = screen.edges.filter(
        (e) => selectedSet.has(e.source) && selectedSet.has(e.target),
      );

      state.clipboard = {
        widgets: widgets.map((w) => deepClone(w)),
        edges: matchingEdges.map((e) => deepClone(e)),
        sourceScreenId: activeScreenId,
      };
      // New clipboard content → restart the cascading paste offset
      state.pasteCount = 0;
    }),

  cutSelectedWidgets: () =>
    set((state) => {
      const { selectedWidgetIds, activeScreenId, screens } = state;
      if (selectedWidgetIds.length === 0) return;

      const screen = screens.find((s) => s.id === activeScreenId);
      if (!screen) return;

      const prev = original(state) ?? state;
      const prevScreen = prev.screens.find((s) => s.id === activeScreenId);
      if (!prevScreen) return;

      const selectedSet = new Set(selectedWidgetIds);
      const widgets = screen.widgets.filter((w) => selectedSet.has(w.id));
      if (widgets.length === 0) return;

      // Copy to clipboard
      const matchingEdges = screen.edges.filter(
        (e) => selectedSet.has(e.source) && selectedSet.has(e.target),
      );

      state.clipboard = {
        widgets: widgets.map((w) => deepClone(w)),
        edges: matchingEdges.map((e) => deepClone(e)),
        sourceScreenId: activeScreenId,
      };
      state.pasteCount = 0;

      // Remove all selected widgets and their edges — one BATCH history entry
      const entries: HistoryEntry[] = [];
      for (const widget of selectedWidgetIds) {
        const before = prevScreen.widgets.find((w) => w.id === widget);
        if (!before) continue;
        const removedEdges = prevScreen.edges.filter(
          (e) => e.source === widget || e.target === widget,
        );
        const index = prevScreen.widgets.findIndex((w) => w.id === widget);
        const affectedBindings = snapshotBindingsForWidget(state, widget);

        screen.widgets = screen.widgets.filter((w) => w.id !== widget);
        screen.edges = screen.edges.filter(
          (e) => e.source !== widget && e.target !== widget,
        );
        for (const binding of state.automationBindings) {
          for (const vb of binding.variableBindings) {
            if (vb.boundWidgetId === widget) {
              vb.boundWidgetId = null;
              vb.boundTag = null;
            }
          }
        }

        entries.push({
          type: 'WIDGET_REMOVE',
          screenId: activeScreenId,
          widget: before,
          removedEdges,
          ...(index >= 0 ? { index } : {}),
          ...(affectedBindings.length > 0 ? { affectedBindings } : {}),
        });
      }

      state.selectedWidgetId = null;
      state.selectedWidgetIds = [];
      state.isDirty = true;
      if (entries.length > 0) {
        appendHistory(state, {
          type: 'BATCH',
          label: `Cut ${entries.length} widget${entries.length > 1 ? 's' : ''}`,
          entries,
        });
      }
    }),

  pasteWidgets: (targetScreenId) =>
    set((state) => {
      const { clipboard } = state;
      if (!clipboard) return;

      const screenId = targetScreenId ?? state.activeScreenId;
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;

      // Build old-ID → new-ID mapping
      const idMap = new Map<string, string>();
      for (const widget of clipboard.widgets) {
        idMap.set(widget.id, generateId());
      }

      /**
       * GroupId remapping during paste: generate new groupIds for pasted widgets
       * so they form their own independent groups instead of joining the
       * original group. Without this, pasting a group of 3 creates a 6-member
       * group with the originals -- clearly wrong.
       */
      const groupIdMap: Record<string, string> = {};

      // Cascading paste offset: consecutive pastes of the same clipboard
      // offset by +1, +2, +3... grid cells so stacked pastes stay visible.
      const offset = 1 + state.pasteCount;
      state.pasteCount += 1;

      const addedWidgets: Array<typeof clipboard.widgets[number]> = [];
      const addedEdges: Array<typeof clipboard.edges[number]> = [];

      // Create new widgets with fresh IDs, remapped groupIds, and offset position
      for (const widget of clipboard.widgets) {
        const newId = idMap.get(widget.id)!;
        const newWidget = deepClone(widget);
        newWidget.id = newId;
        newWidget.position.col += offset;
        newWidget.position.row += offset;

        // Remap groupId so pasted widgets form independent groups
        if (newWidget.groupId) {
          if (!groupIdMap[newWidget.groupId]) {
            groupIdMap[newWidget.groupId] = generateId();
          }
          newWidget.groupId = groupIdMap[newWidget.groupId];
        }

        screen.widgets.push(newWidget);
        addedWidgets.push(newWidget);
      }

      // Remap and add edges
      for (const edge of clipboard.edges) {
        const newSource = idMap.get(edge.source);
        const newTarget = idMap.get(edge.target);
        // Only add edge if both endpoints were mapped (should always be true)
        if (!newSource || !newTarget) continue;

        const newEdge = deepClone(edge);
        newEdge.id = generateId();
        newEdge.source = newSource;
        newEdge.target = newTarget;
        screen.edges.push(newEdge);
        addedEdges.push(newEdge);
      }

      // Select all pasted widgets
      const newIds = clipboard.widgets.map((w) => idMap.get(w.id)!).filter(Boolean);
      state.selectedWidgetIds = newIds;
      state.selectedWidgetId = newIds[0] ?? null;
      state.selectedEdgeId = null;

      state.isDirty = true;
      if (addedWidgets.length > 0) {
        appendHistory(state, {
          type: 'BATCH',
          label: `Paste ${addedWidgets.length} widget${addedWidgets.length > 1 ? 's' : ''}`,
          entries: [
            ...addedWidgets.map((widget): HistoryEntry => ({
              type: 'WIDGET_ADD',
              screenId,
              widget,
            })),
            ...addedEdges.map((edge): HistoryEntry => ({
              type: 'EDGE_ADD',
              screenId,
              edge,
            })),
          ],
        });
      }
    }),

  clearClipboard: () =>
    set((state) => {
      state.clipboard = null;
      state.pasteCount = 0;
    }),

  setHighlightedWidget: (id) =>
    set((state) => {
      state.highlightedWidgetId = id;
    }),
});
