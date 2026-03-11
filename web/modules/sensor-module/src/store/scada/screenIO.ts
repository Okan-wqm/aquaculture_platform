/**
 * Screen Import/Export utilities for SCADA builder.
 * Enables exporting single screens as JSON and importing them back.
 */

import type { ScreenDef, ScreenJSON } from './types';
import { generateId } from './types';

/**
 * Export a single screen to a standalone JSON object.
 * Generates a clean export with no internal IDs (they'll be regenerated on import).
 */
export function exportScreen(screen: ScreenDef): ScreenJSON {
  return {
    name: screen.name,
    screenType: screen.screenType,
    isDefault: false, // never export as default
    icon: screen.icon,
    layout: { ...screen.layout },
    widgets: screen.widgets.map((w) => ({
      widgetType: w.widgetType,
      position: { ...w.position },
      config: { ...w.config },
    })),
    edges: screen.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      type: e.type,
      data: { ...e.data },
    })),
    parentId: null,
    sortOrder: 0,
  };
}

/**
 * Import a screen from JSON, generating fresh IDs for all widgets and edges.
 * Returns a new ScreenDef ready to be added to the store.
 */
export function importScreen(json: ScreenJSON, nameOverride?: string): ScreenDef {
  const idMap = new Map<string, string>();

  // Generate fresh widget IDs
  const widgets = (json.widgets || []).map((w) => {
    const oldId = w.id || generateId();
    const newId = generateId();
    idMap.set(oldId, newId);
    return {
      id: newId,
      widgetType: w.widgetType || 'unknown',
      position: {
        col: w.position?.col ?? 0,
        row: w.position?.row ?? 0,
        w: w.position?.w ?? 2,
        h: w.position?.h ?? 2,
      },
      config: w.config || {},
    };
  });

  // Remap edge endpoints
  const edges = (json.edges || []).map((e) => ({
    id: generateId(),
    source: idMap.get(e.source) || e.source,
    target: idMap.get(e.target) || e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    type: e.type,
    data: { ...e.data },
  }));

  return {
    id: generateId(),
    name: nameOverride || json.name || 'Imported Screen',
    screenType: (json.screenType as any) || 'dashboard',
    isDefault: false,
    icon: json.icon || 'LayoutDashboard',
    layout: json.layout || { type: 'grid', cols: 12, rows: 8 },
    widgets,
    edges,
    parentId: json.parentId ?? null,
    sortOrder: json.sortOrder ?? 0,
  };
}

/**
 * Download a screen as a JSON file in the browser.
 */
export function downloadScreenJSON(screen: ScreenDef): void {
  const json = exportScreen(screen);
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${screen.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.scada-screen.json`;
  a.click();
  URL.revokeObjectURL(url);
}
