import { original } from 'immer';
import type { ScadaSliceCreator, SceneSlice, ScreenType, ScadaEdgeData, ScadaStore, HistoryEntry } from './types';
import { generateId, SCREEN_ICONS, DEFAULT_LAYOUT } from './types';
import { appendHistory } from './historySlice';

/** Sort the screens array (in place, on the draft) into the given ID order. */
function sortScreensByOrder(state: ScadaStore, order: string[]): void {
  const index = new Map(order.map((id, i) => [id, i]));
  state.screens.sort((a, b) => {
    const ai = index.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bi = index.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

export const createSceneSlice: ScadaSliceCreator<SceneSlice> = (set, get) => ({
  // --------------- State ---------------
  screens: [],
  activeScreenId: '',
  screenViewports: {},
  screenHistory: [],

  // --------------- Actions ---------------

  addScreen: (type: ScreenType, name: string) => {
    const id = generateId();
    const isFirst = get().screens.length === 0;
    const screen = {
      id,
      name,
      screenType: type,
      isDefault: isFirst,
      icon: SCREEN_ICONS[type] || 'LayoutDashboard',
      layout: { ...DEFAULT_LAYOUT },
      widgets: [],
      edges: [],
    };

    set((state) => {
      state.screens.push(screen);
      state.activeScreenId = id;
      state.selectedWidgetId = null;
      state.isDirty = true;
      appendHistory(state, { type: 'SCREEN_ADD', screen });
    });
  },

  removeScreen: (id: string) =>
    set((state) => {
      if (state.screens.length <= 1) return;

      const removedIndex = state.screens.findIndex((s) => s.id === id);
      if (removedIndex === -1) return;

      const prev = original(state) ?? state;
      const prevScreen = prev.screens[removedIndex];
      const removedScreen = state.screens[removedIndex];
      const wasDefault = removedScreen.isDefault;
      const wasActive = state.activeScreenId === id;

      // History must cover the sibling effects too: orphan reparenting and
      // the forced isDefault flip. Captured as a BATCH so one undo restores
      // the screen AND its siblings' previous parent/default state.
      const batchEntries: HistoryEntry[] = [];

      // Reparent orphaned children to the deleted screen's parent (or root)
      const newParentId = removedScreen.parentId ?? null;
      for (const screen of state.screens) {
        if (screen.parentId === id) {
          const prevParent = prev.screens.find((s) => s.id === screen.id)?.parentId ?? null;
          batchEntries.push({
            type: 'SCREEN_UPDATE',
            screenId: screen.id,
            before: { parentId: prevParent },
            after: { parentId: newParentId },
          });
          screen.parentId = newParentId;
        }
      }

      state.screens.splice(removedIndex, 1);

      // If removed screen was active, switch to first remaining
      if (wasActive) {
        state.activeScreenId = state.screens[0]?.id || '';
      }

      // If removed screen was default, make first remaining default
      if (wasDefault && state.screens.length > 0) {
        const forced = state.screens[0];
        batchEntries.push({
          type: 'SCREEN_UPDATE',
          screenId: forced.id,
          before: { isDefault: false },
          after: { isDefault: true },
        });
        forced.isDefault = true;
      }

      state.selectedWidgetId = null;
      state.selectedEdgeId = null;
      state.isDirty = true;

      batchEntries.push({
        type: 'SCREEN_REMOVE',
        screen: prevScreen,
        index: removedIndex,
        wasActive,
      });
      appendHistory(state, {
        type: 'BATCH',
        label: `Delete screen "${removedScreen.name}"`,
        entries: batchEntries,
      });
    }),

  duplicateScreen: (id: string) =>
    set((state) => {
      const source = state.screens.find((s) => s.id === id);
      if (!source) return;

      const newScreenId = generateId();

      // Build widget ID mapping for edge remapping
      const widgetIdMap = new Map<string, string>();
      const newWidgets = source.widgets.map((w) => {
        const newWidgetId = generateId();
        widgetIdMap.set(w.id, newWidgetId);
        return {
          ...w,
          id: newWidgetId,
          position: { ...w.position },
          config: JSON.parse(JSON.stringify(w.config)) as Record<string, unknown>,
        };
      });

      // Deep clone edges with remapped source/target and cloned geometry
      const newEdges = source.edges.map((e) => {
        const dataCopy: ScadaEdgeData = { ...e.data };
        if (dataCopy.bendPoints) dataCopy.bendPoints = dataCopy.bendPoints.map((p) => ({ ...p }));
        if (dataCopy.points) dataCopy.points = dataCopy.points.map((p) => ({ ...p }));
        if (dataCopy.controlPoint) dataCopy.controlPoint = { ...dataCopy.controlPoint };
        if (dataCopy.controlPoint2) dataCopy.controlPoint2 = { ...dataCopy.controlPoint2 };

        return {
          ...e,
          id: generateId(),
          source: widgetIdMap.get(e.source) || e.source,
          target: widgetIdMap.get(e.target) || e.target,
          data: dataCopy,
        };
      });

      const duplicate = {
        ...source,
        id: newScreenId,
        name: `${source.name} (Copy)`,
        isDefault: false,
        // Deep-copy layout so edits to the duplicate never mutate the source
        layout: { ...source.layout },
        widgets: newWidgets,
        edges: newEdges,
      };
      state.screens.push(duplicate);

      state.activeScreenId = newScreenId;
      state.selectedWidgetId = null;
      state.selectedEdgeId = null;
      state.isDirty = true;
      appendHistory(state, { type: 'SCREEN_ADD', screen: duplicate });
    }),

  updateScreen: (id: string, updates) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === id);
      if (!screen) return;

      const prev = (original(state) ?? state).screens.find((s) => s.id === id);
      if (!prev) return;

      // No-op guard: skip (no isDirty, no history) when every updated key
      // already holds the same shallow value.
      const changedKeys = Object.keys(updates).filter((key) => {
        const before = (prev as unknown as Record<string, unknown>)[key];
        const after = (updates as unknown as Record<string, unknown>)[key];
        return before !== after;
      });
      if (changedKeys.length === 0) return;

      const before: Record<string, unknown> = {};
      for (const key of changedKeys) {
        before[key] = (prev as unknown as Record<string, unknown>)[key];
      }

      Object.assign(screen, updates);
      state.isDirty = true;
      appendHistory(state, {
        type: 'SCREEN_UPDATE',
        screenId: id,
        before,
        after: updates,
      });
    }),

  reorderScreens: (orderedIds: string[]) =>
    set((state) => {
      if (orderedIds.length !== state.screens.length) return;

      const prev = original(state) ?? state;
      const beforeOrder = prev.screens.map((s) => s.id);
      const afterOrder = [...orderedIds];

      // No-op when the requested order already matches the store
      if (beforeOrder.every((id, i) => id === afterOrder[i])) return;

      const beforeSortOrders: Record<string, number> = {};
      for (const s of prev.screens) beforeSortOrders[s.id] = s.sortOrder ?? 0;

      const afterSortOrders: Record<string, number> = {};
      afterOrder.forEach((id, idx) => {
        afterSortOrders[id] = idx;
        const screen = state.screens.find((s) => s.id === id);
        if (screen) screen.sortOrder = idx;
      });
      sortScreensByOrder(state, afterOrder);

      state.isDirty = true;
      appendHistory(state, {
        type: 'BATCH',
        label: 'Reorder screens',
        entries: [
          {
            type: 'SCREENS_REORDER',
            beforeOrder,
            afterOrder,
            beforeSortOrders,
            afterSortOrders,
          },
        ],
      });
    }),

  setActiveScreen: (id: string) =>
    set((state) => {
      // Push current active screen to history (dedup, max 20)
      if (state.activeScreenId) {
        const filtered = state.screenHistory.filter((h) => h !== state.activeScreenId);
        filtered.push(state.activeScreenId);
        state.screenHistory = filtered.slice(-20);
      }

      state.activeScreenId = id;
      state.selectedWidgetId = null;
      state.selectedEdgeId = null;
    }),

  setDefaultScreen: (id: string) =>
    set((state) => {
      const prev = original(state) ?? state;
      const entries: HistoryEntry[] = [];
      let changed = false;
      for (const screen of state.screens) {
        const wasDefault = prev.screens.find((s) => s.id === screen.id)?.isDefault ?? false;
        const nowDefault = screen.id === id;
        if (wasDefault !== nowDefault) {
          changed = true;
          entries.push({
            type: 'SCREEN_UPDATE',
            screenId: screen.id,
            before: { isDefault: wasDefault },
            after: { isDefault: nowDefault },
          });
        }
        screen.isDefault = nowDefault;
      }
      if (!changed) return;
      state.isDirty = true;
      appendHistory(state, { type: 'BATCH', label: 'Set default screen', entries });
    }),

  saveScreenViewport: (screenId, viewport) =>
    set((state) => {
      state.screenViewports[screenId] = viewport;
    }),

  getScreenViewport: (screenId) => {
    return get().screenViewports[screenId] || { x: 0, y: 0, zoom: 1 };
  },
});
