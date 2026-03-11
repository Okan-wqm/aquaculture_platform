import type { ScadaSliceCreator, WidgetSlice } from './types';

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

  bringToFront: (screenId, widgetId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const idx = screen.widgets.findIndex((w) => w.id === widgetId);
      if (idx === -1 || idx === screen.widgets.length - 1) return; // already at front
      if (screen.widgets[idx].locked) return;
      const [widget] = screen.widgets.splice(idx, 1);
      screen.widgets.push(widget);
      state.isDirty = true;
    }),

  sendToBack: (screenId, widgetId) =>
    set((state) => {
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;
      const idx = screen.widgets.findIndex((w) => w.id === widgetId);
      if (idx <= 0) return; // already at back
      if (screen.widgets[idx].locked) return;
      const [widget] = screen.widgets.splice(idx, 1);
      screen.widgets.unshift(widget);
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
});
