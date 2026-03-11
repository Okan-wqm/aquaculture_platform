import type { ScadaSliceCreator, SceneSlice, ScreenType, ScadaEdgeData } from './types';
import { generateId, SCREEN_ICONS, DEFAULT_LAYOUT } from './types';

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
    });
  },

  removeScreen: (id: string) =>
    set((state) => {
      if (state.screens.length <= 1) return;

      const removedIndex = state.screens.findIndex((s) => s.id === id);
      if (removedIndex === -1) return;

      const removedScreen = state.screens[removedIndex];
      const wasDefault = removedScreen.isDefault;

      // Reparent orphaned children to the deleted screen's parent (or root)
      const newParentId = removedScreen.parentId ?? null;
      for (const screen of state.screens) {
        if (screen.parentId === id) {
          screen.parentId = newParentId;
        }
      }

      state.screens.splice(removedIndex, 1);

      // If removed screen was active, switch to first remaining
      if (state.activeScreenId === id) {
        state.activeScreenId = state.screens[0]?.id || '';
      }

      // If removed screen was default, make first remaining default
      if (wasDefault && state.screens.length > 0) {
        state.screens[0].isDefault = true;
      }

      state.selectedWidgetId = null;
      state.selectedEdgeId = null;
      state.isDirty = true;
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
          config: { ...w.config },
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

      state.screens.push({
        ...source,
        id: newScreenId,
        name: `${source.name} (Copy)`,
        isDefault: false,
        widgets: newWidgets,
        edges: newEdges,
      });

      state.activeScreenId = newScreenId;
      state.selectedWidgetId = null;
      state.selectedEdgeId = null;
      state.isDirty = true;
    }),

  updateScreen: (id: string, updates) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === id);
      if (screen) {
        Object.assign(screen, updates);
        state.isDirty = true;
      }
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
      for (const screen of state.screens) {
        screen.isDefault = screen.id === id;
      }
      state.isDirty = true;
    }),

  saveScreenViewport: (screenId, viewport) =>
    set((state) => {
      state.screenViewports[screenId] = viewport;
    }),

  getScreenViewport: (screenId) => {
    return get().screenViewports[screenId] || { x: 0, y: 0, zoom: 1 };
  },
});
