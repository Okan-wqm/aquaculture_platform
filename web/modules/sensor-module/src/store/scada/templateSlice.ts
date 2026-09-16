import { getTenantId } from '@aquaculture/shared-ui';
import type { ScadaSliceCreator, TemplateSlice, WidgetTemplate } from './types';
import { generateId } from './types';
import { appendHistory } from './historySlice';

function getTenantIdSafe(): string | null {
  try {
    return getTenantId();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Tenant-scoped localStorage persistence                            */
/*                                                                     */
/*  Widget templates are user/tenant palette data, NOT undoable canvas */
/*  state. They persist under `scada-widget-templates:${tenantId}` in  */
/*  a versioned envelope so future shape changes can migrate forward.  */
/*  Purged on logout / tenant switch (see createScadaStore).           */
/* ------------------------------------------------------------------ */

const TEMPLATE_STORAGE_PREFIX = 'scada-widget-templates:';
const TEMPLATE_STORAGE_SCHEMA_VERSION = 1;

interface TemplateStorageEnvelope {
  schemaVersion: number;
  templates: WidgetTemplate[];
}

function templateStorageKey(tenantId: string): string {
  return `${TEMPLATE_STORAGE_PREFIX}${tenantId}`;
}

/** Read + migrate a tenant's template envelope. Returns [] when absent. */
export function loadTemplatesFromStorage(tenantId: string | null): WidgetTemplate[] {
  if (!tenantId || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(templateStorageKey(tenantId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Migration: bare arrays are the pre-schemaVersion shape → wrap as v1.
    if (Array.isArray(parsed)) {
      return parsed as WidgetTemplate[];
    }
    const envelope = parsed as Partial<TemplateStorageEnvelope>;
    if (envelope.schemaVersion === TEMPLATE_STORAGE_SCHEMA_VERSION && Array.isArray(envelope.templates)) {
      return envelope.templates;
    }
    // Unknown future version — fail safe to an empty palette rather than
    // rendering unvetted shapes.
    return [];
  } catch {
    return [];
  }
}

function persistTemplatesToStorage(tenantId: string | null, templates: WidgetTemplate[]): void {
  if (!tenantId || typeof localStorage === 'undefined') return;
  try {
    const envelope: TemplateStorageEnvelope = {
      schemaVersion: TEMPLATE_STORAGE_SCHEMA_VERSION,
      templates,
    };
    localStorage.setItem(templateStorageKey(tenantId), JSON.stringify(envelope));
  } catch {
    // Quota/private-mode failures must not break the builder action
  }
}

/** Remove every tenant's template storage (logout / tenant switch purge). */
export function purgeWidgetTemplateStorage(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(TEMPLATE_STORAGE_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    // ignore storage failures during purge
  }
}

export const createTemplateSlice: ScadaSliceCreator<TemplateSlice> = (set, get) => ({
  // Hydrated lazily via hydrateTemplatesFromStorage (tenant context may not
  // exist at store-creation time in tests/microfrontend bootstrap).
  widgetTemplates: [],

  hydrateTemplatesFromStorage: () => {
    const stored = loadTemplatesFromStorage(getTenantIdSafe());
    set((state) => {
      // Only hydrate when empty — in-session templates win over stale storage
      if (state.widgetTemplates.length === 0 && stored.length > 0) {
        state.widgetTemplates = stored;
      }
    });
  },

  saveAsTemplate: (name, category, widget) => {
    const id = generateId();
    const template: WidgetTemplate = {
      id,
      name,
      category,
      widgetType: widget.widgetType,
      config: JSON.parse(JSON.stringify(widget.config)) as Record<string, unknown>,
      defaultSize: { w: widget.position.w, h: widget.position.h },
      createdAt: Date.now(),
    };
    set((state) => {
      state.widgetTemplates.push(template);
      // Templates ship with the package export flow (save action reads the
      // store), so creating one marks the package dirty.
      state.isDirty = true;
      persistTemplatesToStorage(getTenantIdSafe(), state.widgetTemplates.slice());
    });
    return id;
  },

  deleteTemplate: (id) =>
    set((state) => {
      state.widgetTemplates = state.widgetTemplates.filter((t) => t.id !== id);
      persistTemplatesToStorage(getTenantIdSafe(), state.widgetTemplates.slice());
    }),

  applyTemplate: (screenId, templateId, position) =>
    set((state) => {
      const template = state.widgetTemplates.find((t) => t.id === templateId);
      if (!template) return;
      const screen = state.screens.find((s) => s.id === screenId);
      if (!screen) return;

      const widget = {
        id: generateId(),
        widgetType: template.widgetType,
        position: { ...position, w: template.defaultSize.w, h: template.defaultSize.h },
        config: JSON.parse(JSON.stringify(template.config)) as Record<string, unknown>,
      };
      screen.widgets.push(widget);
      state.isDirty = true;
      appendHistory(state, { type: 'WIDGET_ADD', screenId, widget });
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
