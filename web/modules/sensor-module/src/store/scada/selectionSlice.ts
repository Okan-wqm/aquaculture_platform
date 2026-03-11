import type { ScadaSliceCreator, SelectionSlice } from './types';
import { generateId, deepClone } from './types';

export const createSelectionSlice: ScadaSliceCreator<SelectionSlice> = (set, get) => ({
  // State
  selectedWidgetId: null,
  selectedWidgetIds: [],
  selectedEdgeId: null,
  clipboard: null,

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
    }),

  cutSelectedWidgets: () =>
    set((state) => {
      const { selectedWidgetIds, activeScreenId, screens } = state;
      if (selectedWidgetIds.length === 0) return;

      const screen = screens.find((s) => s.id === activeScreenId);
      if (!screen) return;

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

      // Remove all selected widgets and their edges
      screen.widgets = screen.widgets.filter((w) => !selectedSet.has(w.id));
      screen.edges = screen.edges.filter(
        (e) => !selectedSet.has(e.source) && !selectedSet.has(e.target),
      );

      state.selectedWidgetId = null;
      state.selectedWidgetIds = [];
      state.isDirty = true;
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

      // Create new widgets with fresh IDs and offset position
      for (const widget of clipboard.widgets) {
        const newId = idMap.get(widget.id)!;
        const newWidget = deepClone(widget);
        newWidget.id = newId;
        newWidget.position.col += 1;
        newWidget.position.row += 1;
        screen.widgets.push(newWidget);
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
      }

      // Select all pasted widgets
      const newIds = clipboard.widgets.map((w) => idMap.get(w.id)!).filter(Boolean);
      state.selectedWidgetIds = newIds;
      state.selectedWidgetId = newIds[0] ?? null;
      state.selectedEdgeId = null;

      state.isDirty = true;
    }),

  clearClipboard: () =>
    set((state) => {
      state.clipboard = null;
    }),
});
