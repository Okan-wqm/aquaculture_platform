import type { ScadaSliceCreator, EdgeSlice } from './types';

export const createEdgeSlice: ScadaSliceCreator<EdgeSlice> = (set) => ({
  addEdge: (screenId, edge) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      screen.edges.push(edge);
      state.isDirty = true;
    }),

  removeEdge: (screenId, edgeId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      screen.edges = screen.edges.filter((e) => e.id !== edgeId);
      if (state.selectedEdgeId === edgeId) {
        state.selectedEdgeId = null;
      }
      state.isDirty = true;
    }),

  updateEdgeData: (screenId, edgeId, data) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const edge = screen.edges.find((e) => e.id === edgeId);
      if (!edge) return;
      Object.assign(edge.data, data);
      state.isDirty = true;
    }),

  updateEdgeType: (screenId, edgeId, newType) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const edge = screen.edges.find((e) => e.id === edgeId);
      if (!edge) return;
      edge.type = newType;
      // Clear type-specific geometry data to avoid stale control/bend points
      edge.data = {
        connectionType: edge.data.connectionType,
        label: edge.data.label,
        animated: edge.data.animated,
      };
      state.isDirty = true;
    }),
});
