import type { ScadaSliceCreator, WidgetSlice, ScreenWidget } from './types';

/* ------------------------------------------------------------------ */
/*  Helper: resolve effective z-index for a widget.                    */
/*  Treats undefined/null as 0 so sparse z-index math is safe.        */
/* ------------------------------------------------------------------ */

function zOf(widget: ScreenWidget): number {
  return widget.zIndex ?? 0;
}

export const createWidgetSlice: ScadaSliceCreator<WidgetSlice> = (set, _get) => ({
  addWidget: (screenId, widget) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      screen.widgets.push(widget);
      state.isDirty = true;
    }),

  removeWidget: (screenId, widgetId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;

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
      for (const binding of state.automationBindings) {
        for (const vb of binding.variableBindings) {
          if (vb.boundWidgetId === widgetId) {
            vb.boundWidgetId = null;
            vb.boundTag = null;
          }
        }
      }

      // Clear selected widget if it was this one
      if (state.selectedWidgetId === widgetId) {
        state.selectedWidgetId = null;
      }

      state.isDirty = true;
    }),

  updateWidget: (screenId, widgetId, updates) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      Object.assign(widget, updates);
      state.isDirty = true;
    }),

  updateWidgetPosition: (screenId, widgetId, position) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      if (widget.locked) return;
      widget.position = position;
      state.isDirty = true;
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
    }),

  sendToBack: (screenId, widgetId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget || widget.locked) return;

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
    }),

  bringForward: (screenId, widgetId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget || widget.locked) return;

      // Sort all widgets by z-index ascending to find the one directly above
      const sorted = [...screen.widgets].sort((a, b) => zOf(a) - zOf(b));
      const sortedIdx = sorted.findIndex((w) => w.id === widgetId);

      // Already at top — no-op
      if (sortedIdx === sorted.length - 1) return;

      // Swap z-indices with the widget directly above
      const above = sorted[sortedIdx + 1];
      const currentZ = zOf(widget);
      const aboveZ = zOf(above);

      // If they have the same z-index, nudge the target up by 1 instead of swapping
      if (currentZ === aboveZ) {
        widget.zIndex = aboveZ + 1;
      } else {
        widget.zIndex = aboveZ;
        above.zIndex = currentZ;
      }

      state.isDirty = true;
    }),

  sendBackward: (screenId, widgetId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget || widget.locked) return;

      // Sort all widgets by z-index ascending to find the one directly below
      const sorted = [...screen.widgets].sort((a, b) => zOf(a) - zOf(b));
      const sortedIdx = sorted.findIndex((w) => w.id === widgetId);

      // Already at bottom — no-op
      if (sortedIdx === 0) return;

      // Swap z-indices with the widget directly below
      const below = sorted[sortedIdx - 1];
      const currentZ = zOf(widget);
      const belowZ = zOf(below);

      // If they have the same z-index, nudge the target down by 1
      if (currentZ === belowZ) {
        widget.zIndex = belowZ - 1;
      } else {
        widget.zIndex = belowZ;
        below.zIndex = currentZ;
      }

      state.isDirty = true;
    }),

  setWidgetZIndex: (screenId, widgetId, zIndex) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      widget.zIndex = zIndex;
      state.isDirty = true;
    }),

  toggleWidgetLock: (screenId, widgetId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      widget.locked = !widget.locked;
      state.isDirty = true;
    }),

  toggleWidgetVisibility: (screenId, widgetId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      // Default is visible (true); toggle flips it
      widget.visible = widget.visible === false ? true : false;
      state.isDirty = true;
    }),
});
