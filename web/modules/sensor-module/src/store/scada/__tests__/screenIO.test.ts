import { describe, it, expect } from 'vitest';
import { exportScreen, importScreen } from '../screenIO';
import type { ScreenDef, ScreenJSON } from '../types';

const mockScreen: ScreenDef = {
  id: 'screen-1',
  name: 'Test Screen',
  screenType: 'dashboard',
  isDefault: true,
  icon: 'LayoutDashboard',
  layout: { type: 'grid', cols: 12, rows: 8 },
  widgets: [
    { id: 'w1', widgetType: 'gauge', position: { col: 0, row: 0, w: 2, h: 2 }, config: { label: 'pH' } },
    { id: 'w2', widgetType: 'trend', position: { col: 3, row: 0, w: 4, h: 3 }, config: { label: 'Temp' } },
  ],
  edges: [
    { id: 'e1', source: 'w1', target: 'w2', sourceHandle: 'outlet', targetHandle: 'inlet', type: 'orthogonal', data: { connectionType: 'process-pipe' } },
  ],
  parentId: null,
  sortOrder: 0,
};

describe('exportScreen', () => {
  it('should export screen with correct name', () => {
    const json = exportScreen(mockScreen);
    expect(json.name).toBe('Test Screen');
  });

  it('should set isDefault to false on export', () => {
    const json = exportScreen(mockScreen);
    expect(json.isDefault).toBe(false);
  });

  it('should export all widgets', () => {
    const json = exportScreen(mockScreen);
    expect(json.widgets).toHaveLength(2);
  });

  it('should strip widget IDs from export', () => {
    const json = exportScreen(mockScreen);
    // exportScreen maps widgets without their id field
    for (const w of json.widgets!) {
      expect(w).not.toHaveProperty('id');
    }
  });

  it('should export all edges', () => {
    const json = exportScreen(mockScreen);
    expect(json.edges).toHaveLength(1);
  });

  it('should preserve layout', () => {
    const json = exportScreen(mockScreen);
    expect(json.layout).toEqual({ type: 'grid', cols: 12, rows: 8 });
  });

  it('should preserve widget positions and configs', () => {
    const json = exportScreen(mockScreen);
    expect(json.widgets![0].position).toEqual({ col: 0, row: 0, w: 2, h: 2 });
    expect(json.widgets![0].config).toEqual({ label: 'pH' });
    expect(json.widgets![1].widgetType).toBe('trend');
  });

  it('should set parentId to null and sortOrder to 0', () => {
    const json = exportScreen(mockScreen);
    expect(json.parentId).toBeNull();
    expect(json.sortOrder).toBe(0);
  });
});

describe('importScreen', () => {
  it('should generate a fresh screen ID', () => {
    const json = exportScreen(mockScreen);
    const imported = importScreen(json);
    expect(imported.id).not.toBe('screen-1');
    expect(imported.id).toBeTruthy();
  });

  it('should generate fresh widget IDs', () => {
    const json = exportScreen(mockScreen);
    const imported = importScreen(json);
    // All widgets should have newly generated UUIDs
    for (const w of imported.widgets) {
      expect(w.id).toBeTruthy();
      expect(w.id).not.toBe('w1');
      expect(w.id).not.toBe('w2');
    }
  });

  it('should generate fresh edge IDs', () => {
    const json = exportScreen(mockScreen);
    const imported = importScreen(json);
    for (const e of imported.edges) {
      expect(e.id).toBeTruthy();
      expect(e.id).not.toBe('e1');
    }
  });

  it('should remap edge endpoints when widget IDs are present in JSON', () => {
    // importScreen can remap edges only when the JSON includes widget IDs
    const jsonWithIds: ScreenJSON = {
      name: 'With IDs',
      widgets: [
        { id: 'old-w1', widgetType: 'gauge', position: { col: 0, row: 0, w: 2, h: 2 }, config: {} },
        { id: 'old-w2', widgetType: 'trend', position: { col: 3, row: 0, w: 4, h: 3 }, config: {} },
      ],
      edges: [
        { id: 'old-e1', source: 'old-w1', target: 'old-w2', sourceHandle: 'outlet', targetHandle: 'inlet', type: 'orthogonal', data: { connectionType: 'process-pipe' } },
      ],
    };

    const imported = importScreen(jsonWithIds);

    const edge = imported.edges[0];
    expect(edge.source).not.toBe('old-w1');
    expect(edge.target).not.toBe('old-w2');

    // Edge endpoints should match new widget IDs
    const widgetIds = imported.widgets.map(w => w.id);
    expect(widgetIds).toContain(edge.source);
    expect(widgetIds).toContain(edge.target);
  });

  it('should use name override', () => {
    const json = exportScreen(mockScreen);
    const imported = importScreen(json, 'Custom Name');
    expect(imported.name).toBe('Custom Name');
  });

  it('should use original name when no override', () => {
    const json = exportScreen(mockScreen);
    const imported = importScreen(json);
    expect(imported.name).toBe('Test Screen');
  });

  it('should preserve positions and configs', () => {
    const json = exportScreen(mockScreen);
    const imported = importScreen(json);

    expect(imported.widgets[0].position).toEqual({ col: 0, row: 0, w: 2, h: 2 });
    expect(imported.widgets[0].config).toEqual({ label: 'pH' });
    expect(imported.widgets[1].position).toEqual({ col: 3, row: 0, w: 4, h: 3 });
    expect(imported.widgets[1].config).toEqual({ label: 'Temp' });
  });

  it('should set isDefault to false', () => {
    const json = exportScreen(mockScreen);
    const imported = importScreen(json);
    expect(imported.isDefault).toBe(false);
  });

  it('should handle empty screen (no widgets, no edges)', () => {
    const imported = importScreen({ name: 'Empty' });
    expect(imported.widgets).toEqual([]);
    expect(imported.edges).toEqual([]);
    expect(imported.name).toBe('Empty');
  });

  it('should handle missing name', () => {
    const imported = importScreen({});
    expect(imported.name).toBe('Imported Screen');
  });

  it('should default layout when not provided', () => {
    const imported = importScreen({ name: 'No Layout' });
    expect(imported.layout).toEqual({ type: 'grid', cols: 12, rows: 8 });
  });

  it('should default widget position fields', () => {
    const imported = importScreen({
      name: 'Partial',
      widgets: [{ widgetType: 'gauge', config: {} }],
    });
    expect(imported.widgets[0].position).toEqual({ col: 0, row: 0, w: 2, h: 2 });
  });

  it('should default widgetType to unknown', () => {
    const imported = importScreen({
      name: 'Unknown',
      widgets: [{ config: {} }],
    });
    expect(imported.widgets[0].widgetType).toBe('unknown');
  });
});
