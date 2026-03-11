import type { ScadaSliceCreator, TemplateSlice, WidgetTemplate } from './types';
import { generateId } from './types';

export const createTemplateSlice: ScadaSliceCreator<TemplateSlice> = (set, get) => ({
  widgetTemplates: [],

  saveAsTemplate: (name, category, widget) => {
    const id = generateId();
    const template: WidgetTemplate = {
      id,
      name,
      category,
      widgetType: widget.widgetType,
      config: { ...widget.config },
      defaultSize: { w: widget.position.w, h: widget.position.h },
      createdAt: Date.now(),
    };
    set((state) => {
      state.widgetTemplates.push(template);
    });
    return id;
  },

  deleteTemplate: (id) =>
    set((state) => {
      state.widgetTemplates = state.widgetTemplates.filter((t) => t.id !== id);
    }),

  applyTemplate: (screenId, templateId, position) =>
    set((state) => {
      const template = state.widgetTemplates.find((t) => t.id === templateId);
      if (!template) return;
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;

      screen.widgets.push({
        id: generateId(),
        widgetType: template.widgetType,
        position: { ...position, w: template.defaultSize.w, h: template.defaultSize.h },
        config: { ...template.config },
      });
      state.isDirty = true;
    }),

  getTemplatesByCategory: () => {
    const templates = get().widgetTemplates;
    const grouped: Record<string, WidgetTemplate[]> = {};
    for (const t of templates) {
      if (!grouped[t.category]) grouped[t.category] = [];
      grouped[t.category].push(t);
    }
    return grouped;
  },
});
