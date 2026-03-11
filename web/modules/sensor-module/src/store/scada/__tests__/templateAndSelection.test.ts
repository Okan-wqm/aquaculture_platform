import { describe, it, expect, beforeEach } from 'vitest';
import { createScadaStore } from '../createScadaStore';

type Store = ReturnType<typeof createScadaStore>;

describe('TemplateSlice', () => {
  let store: Store;
  let screenId: string;

  beforeEach(() => {
    store = createScadaStore();
    store.getState().addScreen('dashboard', 'Test Screen');
    screenId = store.getState().activeScreenId;
    store.getState().addWidget(screenId, {
      id: 'w1',
      widgetType: 'gauge',
      position: { col: 0, row: 0, w: 3, h: 2 },
      config: { label: 'pH Sensor', tagName: 'pH_01' },
    });
  });

  it('should save a widget as template', () => {
    const screen = store.getState().screens.find((s) => s.id === screenId);
    const widget = screen!.widgets[0];

    const templateId = store.getState().saveAsTemplate('pH Template', 'Sensors', widget);
    expect(templateId).toBeTruthy();

    const templates = store.getState().widgetTemplates;
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('pH Template');
    expect(templates[0].category).toBe('Sensors');
    expect(templates[0].widgetType).toBe('gauge');
    expect(templates[0].config.label).toBe('pH Sensor');
    expect(templates[0].defaultSize).toEqual({ w: 3, h: 2 });
  });

  it('should delete a template', () => {
    const screen = store.getState().screens.find((s) => s.id === screenId);
    const widget = screen!.widgets[0];
    const templateId = store.getState().saveAsTemplate('Test', 'Cat', widget);

    expect(store.getState().widgetTemplates).toHaveLength(1);
    store.getState().deleteTemplate(templateId);
    expect(store.getState().widgetTemplates).toHaveLength(0);
  });

  it('should apply a template to create a new widget', () => {
    const screen = store.getState().screens.find((s) => s.id === screenId);
    const widget = screen!.widgets[0];
    const templateId = store.getState().saveAsTemplate('Test', 'Cat', widget);

    const widgetCountBefore = store.getState().screens.find((s) => s.id === screenId)!.widgets.length;
    store.getState().applyTemplate(screenId, templateId, { col: 5, row: 3 });

    const screenAfter = store.getState().screens.find((s) => s.id === screenId)!;
    expect(screenAfter.widgets.length).toBe(widgetCountBefore + 1);

    const newWidget = screenAfter.widgets[screenAfter.widgets.length - 1];
    expect(newWidget.widgetType).toBe('gauge');
    expect(newWidget.position.col).toBe(5);
    expect(newWidget.position.row).toBe(3);
    expect(newWidget.position.w).toBe(3);
    expect(newWidget.position.h).toBe(2);
    expect(newWidget.config.label).toBe('pH Sensor');
  });

  it('should set isDirty when applying a template', () => {
    const screen = store.getState().screens.find((s) => s.id === screenId);
    const widget = screen!.widgets[0];
    const templateId = store.getState().saveAsTemplate('Test', 'Cat', widget);

    store.setState({ isDirty: false });
    store.getState().applyTemplate(screenId, templateId, { col: 0, row: 0 });
    expect(store.getState().isDirty).toBe(true);
  });

  it('should group templates by category', () => {
    const screen = store.getState().screens.find((s) => s.id === screenId);
    const widget = screen!.widgets[0];
    store.getState().saveAsTemplate('T1', 'Sensors', widget);
    store.getState().saveAsTemplate('T2', 'Sensors', widget);
    store.getState().saveAsTemplate('T3', 'Alarms', widget);

    const grouped = store.getState().getTemplatesByCategory();
    expect(grouped['Sensors']).toHaveLength(2);
    expect(grouped['Alarms']).toHaveLength(1);
  });

  it('should not apply template if templateId does not exist', () => {
    const widgetCountBefore = store.getState().screens.find((s) => s.id === screenId)!.widgets.length;
    store.getState().applyTemplate(screenId, 'non-existent', { col: 0, row: 0 });
    const widgetCountAfter = store.getState().screens.find((s) => s.id === screenId)!.widgets.length;
    expect(widgetCountAfter).toBe(widgetCountBefore);
  });

  it('should not apply template if screenId does not exist', () => {
    const screen = store.getState().screens.find((s) => s.id === screenId);
    const widget = screen!.widgets[0];
    const templateId = store.getState().saveAsTemplate('Test', 'Cat', widget);

    // Should not throw
    store.getState().applyTemplate('bad-screen', templateId, { col: 0, row: 0 });
    // Original screen unchanged
    expect(store.getState().screens.find((s) => s.id === screenId)!.widgets).toHaveLength(1);
  });

  it('should assign unique IDs to applied template widgets', () => {
    const screen = store.getState().screens.find((s) => s.id === screenId);
    const widget = screen!.widgets[0];
    const templateId = store.getState().saveAsTemplate('Test', 'Cat', widget);

    store.getState().applyTemplate(screenId, templateId, { col: 1, row: 1 });
    store.getState().applyTemplate(screenId, templateId, { col: 2, row: 2 });

    const screenAfter = store.getState().screens.find((s) => s.id === screenId)!;
    const ids = screenAfter.widgets.map((w) => w.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

describe('selectGroup', () => {
  let store: Store;
  let screenId: string;

  beforeEach(() => {
    store = createScadaStore();
    store.getState().addScreen('dashboard', 'Test');
    screenId = store.getState().activeScreenId;
    store.getState().addWidget(screenId, {
      id: 'w1', widgetType: 'gauge', position: { col: 0, row: 0, w: 2, h: 2 }, config: {},
    });
    store.getState().addWidget(screenId, {
      id: 'w2', widgetType: 'gauge', position: { col: 3, row: 0, w: 2, h: 2 }, config: {},
    });
    store.getState().addWidget(screenId, {
      id: 'w3', widgetType: 'gauge', position: { col: 6, row: 0, w: 2, h: 2 }, config: {},
    });
  });

  it('should select all widgets in a group', () => {
    const groupId = store.getState().groupWidgets(screenId, ['w1', 'w2']);

    store.getState().selectGroup(screenId, groupId);

    expect(store.getState().selectedWidgetIds).toEqual(expect.arrayContaining(['w1', 'w2']));
    expect(store.getState().selectedWidgetIds).toHaveLength(2);
    expect(store.getState().selectedWidgetId).toBe('w1');
    expect(store.getState().selectedEdgeId).toBeNull();
  });

  it('should not select non-group widgets', () => {
    const groupId = store.getState().groupWidgets(screenId, ['w1', 'w2']);

    store.getState().selectGroup(screenId, groupId);
    expect(store.getState().selectedWidgetIds).not.toContain('w3');
  });

  it('should handle non-existent group', () => {
    store.getState().selectGroup(screenId, 'non-existent-group');
    expect(store.getState().selectedWidgetIds).toEqual([]);
  });

  it('should handle non-existent screen', () => {
    const groupId = store.getState().groupWidgets(screenId, ['w1', 'w2']);
    store.getState().selectGroup('bad-screen-id', groupId);
    // Selection should remain unchanged from beforeEach (which clears selection via addScreen)
    expect(store.getState().selectedWidgetIds).toEqual([]);
  });

  it('should clear edge selection when selecting a group', () => {
    // First select an edge
    store.getState().setSelectedEdge('some-edge');
    expect(store.getState().selectedEdgeId).toBe('some-edge');

    const groupId = store.getState().groupWidgets(screenId, ['w1', 'w2']);
    store.getState().selectGroup(screenId, groupId);

    expect(store.getState().selectedEdgeId).toBeNull();
    expect(store.getState().selectedWidgetIds).toHaveLength(2);
  });

  it('should replace existing widget selection', () => {
    // First select w3
    store.getState().setSelectedWidget('w3');
    expect(store.getState().selectedWidgetIds).toEqual(['w3']);

    const groupId = store.getState().groupWidgets(screenId, ['w1', 'w2']);
    store.getState().selectGroup(screenId, groupId);

    expect(store.getState().selectedWidgetIds).toEqual(expect.arrayContaining(['w1', 'w2']));
    expect(store.getState().selectedWidgetIds).not.toContain('w3');
  });
});
