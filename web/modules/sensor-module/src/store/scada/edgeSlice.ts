import { original } from 'immer';
import type { ScadaSliceCreator, EdgeSlice, ScadaStore, ScadaEdgeData } from './types';
import { appendHistory } from './historySlice';

export const createEdgeSlice: ScadaSliceCreator<EdgeSlice> = (set) => {
  /** Pre-mutation edge snapshot (frozen previous state via immer original()). */
  function prevEdge(state: ScadaStore, screenId: string, edgeId: string) {
    const prev = original(state) ?? state;
    return prev.screens.find((s) => s.id === screenId)?.edges.find((e) => e.id === edgeId);
  }

  return {
    addEdge: (screenId, edge) =>
      set((state) => {
        const screen = state.screens.find((s) => s.id === screenId);
        if (!screen) return;
        screen.edges.push(edge);
        state.isDirty = true;
        appendHistory(state, { type: 'EDGE_ADD', screenId, edge });
      }),

    removeEdge: (screenId, edgeId) =>
      set((state) => {
        const screen = state.screens.find((s) => s.id === screenId);
        if (!screen) return;
        const before = prevEdge(state, screenId, edgeId);
        if (!before) return;
        screen.edges = screen.edges.filter((e) => e.id !== edgeId);
        if (state.selectedEdgeId === edgeId) {
          state.selectedEdgeId = null;
        }
        state.isDirty = true;
        appendHistory(state, { type: 'EDGE_REMOVE', screenId, edge: before });
      }),

    updateEdgeData: (screenId, edgeId, data) =>
      set((state) => {
        const screen = state.screens.find((s) => s.id === screenId);
        if (!screen) return;
        const edge = screen.edges.find((e) => e.id === edgeId);
        if (!edge) return;
        const before = prevEdge(state, screenId, edgeId);
        if (!before) return;
        const beforeData: ScadaEdgeData = { ...before.data };
        Object.assign(edge.data, data);
        state.isDirty = true;
        appendHistory(state, {
          type: 'EDGE_UPDATE',
          screenId,
          edgeId,
          before: beforeData,
          after: { ...edge.data },
        });
      }),

    updateEdgeType: (screenId, edgeId, newType) =>
      set((state) => {
        const screen = state.screens.find((s) => s.id === screenId);
        if (!screen) return;
        const edge = screen.edges.find((e) => e.id === edgeId);
        if (!edge) return;
        const before = prevEdge(state, screenId, edgeId);
        if (!before) return;
        const beforeType = before.type;
        const beforeData: ScadaEdgeData = { ...before.data };
        edge.type = newType;
        // Clear type-specific geometry data to avoid stale control/bend points
        edge.data = {
          connectionType: edge.data.connectionType,
          label: edge.data.label,
          animated: edge.data.animated,
        };
        state.isDirty = true;
        appendHistory(state, {
          type: 'EDGE_UPDATE',
          screenId,
          edgeId,
          before: beforeData,
          after: { ...edge.data },
          beforeType,
          afterType: newType,
        });
      }),
  };
};
