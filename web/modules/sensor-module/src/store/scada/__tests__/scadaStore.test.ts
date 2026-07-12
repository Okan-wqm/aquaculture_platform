import { describe, it, expect, beforeEach } from 'vitest';
import { createScadaStore } from '../createScadaStore';
import type { ScadaStore } from '../types';
import { generateId } from '../types';
import type { ScreenWidget, WidgetPosition } from '../types';
import type { ScadaEdge } from '../types';
import type { AlarmRuleDef, ControlPermissionsDef, TrendConfigDef, ScadaPackageJSON } from '../types';

type Store = ReturnType<typeof createScadaStore>;

function makeWidget(overrides?: Partial<ScreenWidget>): ScreenWidget {
  return {
    id: generateId(),
    widgetType: 'gauge',
    position: { col: 0, row: 0, w: 2, h: 2 },
    config: {},
    ...overrides,
  };
}

function makeEdge(source: string, target: string): ScadaEdge {
  return {
    id: generateId(),
    source,
    target,
    sourceHandle: 'outlet',
    targetHandle: 'inlet',
    type: 'orthogonal',
    data: { connectionType: 'process-pipe' },
  };
}

function makeAlarmRule(overrides?: Partial<AlarmRuleDef>): AlarmRuleDef {
  return {
    id: generateId(),
    tag: 'pH',
    condition: '>',
    value: 8.5,
    severity: 'warning',
    message: 'pH too high',
    ...overrides,
  };
}

/* ================================================================== */
/*  Test Suite                                                         */
/* ================================================================== */

describe('ScadaStore', () => {
  let store: Store;

  beforeEach(() => {
    store = createScadaStore();
  });

  /* ---------------------------------------------------------------- */
  /*  Scene Slice                                                      */
  /* ---------------------------------------------------------------- */

  describe('SceneSlice', () => {
    it('addScreen creates screen with correct defaults', () => {
      store.getState().addScreen('process', 'Main Process');
      const { screens } = store.getState();
      expect(screens).toHaveLength(1);
      expect(screens[0].name).toBe('Main Process');
      expect(screens[0].screenType).toBe('process');
      expect(screens[0].icon).toBe('Workflow');
      expect(screens[0].layout).toEqual({ type: 'grid', cols: 12, rows: 8 });
      expect(screens[0].widgets).toEqual([]);
      expect(screens[0].edges).toEqual([]);
    });

    it('addScreen first screen is default', () => {
      store.getState().addScreen('dashboard', 'First');
      expect(store.getState().screens[0].isDefault).toBe(true);
      store.getState().addScreen('process', 'Second');
      expect(store.getState().screens[1].isDefault).toBe(false);
    });

    it('addScreen sets activeScreenId and clears selection', () => {
      store.getState().addScreen('dashboard', 'First');
      const firstId = store.getState().screens[0].id;
      expect(store.getState().activeScreenId).toBe(firstId);

      store.getState().addScreen('process', 'Second');
      const secondId = store.getState().screens[1].id;
      expect(store.getState().activeScreenId).toBe(secondId);
      expect(store.getState().selectedWidgetId).toBeNull();
    });

    it('removeScreen protects last screen', () => {
      store.getState().addScreen('dashboard', 'Only');
      const id = store.getState().screens[0].id;
      store.getState().removeScreen(id);
      expect(store.getState().screens).toHaveLength(1);
    });

    it('removeScreen reassigns default if needed', () => {
      store.getState().addScreen('dashboard', 'Default');
      store.getState().addScreen('process', 'Other');
      const defaultId = store.getState().screens[0].id;
      expect(store.getState().screens[0].isDefault).toBe(true);

      store.getState().removeScreen(defaultId);
      // First remaining should become default
      expect(store.getState().screens).toHaveLength(1);
      expect(store.getState().screens[0].isDefault).toBe(true);
    });

    it('removeScreen switches active if removed was active', () => {
      store.getState().addScreen('dashboard', 'First');
      store.getState().addScreen('process', 'Second');
      const secondId = store.getState().screens[1].id;
      // Second is active (last added)
      expect(store.getState().activeScreenId).toBe(secondId);

      store.getState().removeScreen(secondId);
      // Should switch to first remaining
      expect(store.getState().activeScreenId).toBe(store.getState().screens[0].id);
    });

    it('removeScreen does not change active if removed was not active', () => {
      store.getState().addScreen('dashboard', 'First');
      store.getState().addScreen('process', 'Second');
      const firstId = store.getState().screens[0].id;
      const secondId = store.getState().screens[1].id;
      // Second is active
      expect(store.getState().activeScreenId).toBe(secondId);

      store.getState().removeScreen(firstId);
      // Active should remain second
      expect(store.getState().activeScreenId).toBe(secondId);
    });

    it('duplicateScreen creates new IDs and remaps edges', () => {
      store.getState().addScreen('process', 'Original');
      const screenId = store.getState().screens[0].id;
      const w1 = makeWidget();
      const w2 = makeWidget();
      store.getState().addWidget(screenId, w1);
      store.getState().addWidget(screenId, w2);
      const edge = makeEdge(w1.id, w2.id);
      store.getState().addEdge(screenId, edge);

      store.getState().duplicateScreen(screenId);

      const { screens } = store.getState();
      expect(screens).toHaveLength(2);

      const dup = screens[1];
      expect(dup.name).toBe('Original (Copy)');
      expect(dup.isDefault).toBe(false);
      expect(dup.id).not.toBe(screenId);

      // Widget IDs should be different
      expect(dup.widgets).toHaveLength(2);
      expect(dup.widgets[0].id).not.toBe(w1.id);
      expect(dup.widgets[1].id).not.toBe(w2.id);

      // Edge IDs remapped
      expect(dup.edges).toHaveLength(1);
      expect(dup.edges[0].id).not.toBe(edge.id);
      expect(dup.edges[0].source).toBe(dup.widgets[0].id);
      expect(dup.edges[0].target).toBe(dup.widgets[1].id);
    });

    it('setActiveScreen updates history', () => {
      store.getState().addScreen('dashboard', 'First');
      const firstId = store.getState().screens[0].id;
      store.getState().addScreen('process', 'Second');
      const secondId = store.getState().screens[1].id;

      // Active is currently secondId
      store.getState().setActiveScreen(firstId);
      expect(store.getState().activeScreenId).toBe(firstId);
      // secondId should be in the history
      expect(store.getState().screenHistory).toContain(secondId);
    });

    it('setActiveScreen clears selection', () => {
      store.getState().addScreen('dashboard', 'First');
      const screenId = store.getState().screens[0].id;
      const w = makeWidget();
      store.getState().addWidget(screenId, w);
      store.getState().setSelectedWidget(w.id);

      store.getState().addScreen('process', 'Second');
      const secondId = store.getState().screens[1].id;
      store.getState().setActiveScreen(firstScreenId());
      expect(store.getState().selectedWidgetId).toBeNull();

      function firstScreenId() {
        return store.getState().screens[0].id;
      }
    });

    it('setDefaultScreen clears other defaults', () => {
      store.getState().addScreen('dashboard', 'First');
      store.getState().addScreen('process', 'Second');
      const secondId = store.getState().screens[1].id;

      store.getState().setDefaultScreen(secondId);
      const { screens } = store.getState();
      expect(screens[0].isDefault).toBe(false);
      expect(screens[1].isDefault).toBe(true);
    });

    it('saveScreenViewport/getScreenViewport round-trip', () => {
      store.getState().addScreen('dashboard', 'Test');
      const screenId = store.getState().screens[0].id;
      const viewport = { x: 100, y: 200, zoom: 1.5 };

      store.getState().saveScreenViewport(screenId, viewport);
      const result = store.getState().getScreenViewport(screenId);
      expect(result).toEqual(viewport);
    });

    it('getScreenViewport returns default for unknown screen', () => {
      const result = store.getState().getScreenViewport('nonexistent');
      expect(result).toEqual({ x: 0, y: 0, zoom: 1 });
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Widget Slice                                                     */
  /* ---------------------------------------------------------------- */

  describe('WidgetSlice', () => {
    let screenId: string;

    beforeEach(() => {
      store.getState().addScreen('process', 'Test');
      screenId = store.getState().screens[0].id;
    });

    it('addWidget adds to correct screen', () => {
      const w = makeWidget();
      store.getState().addWidget(screenId, w);
      const screen = store.getState().screens[0];
      expect(screen.widgets).toHaveLength(1);
      expect(screen.widgets[0].id).toBe(w.id);
      expect(store.getState().isDirty).toBe(true);
    });

    it('addWidget to nonexistent screen is a no-op', () => {
      const w = makeWidget();
      store.getState().addWidget('nonexistent', w);
      expect(store.getState().screens[0].widgets).toHaveLength(0);
    });

    it('removeWidget cascades edge cleanup', () => {
      const w1 = makeWidget();
      const w2 = makeWidget();
      store.getState().addWidget(screenId, w1);
      store.getState().addWidget(screenId, w2);
      const edge = makeEdge(w1.id, w2.id);
      store.getState().addEdge(screenId, edge);

      store.getState().removeWidget(screenId, w1.id);
      const screen = store.getState().screens[0];
      expect(screen.widgets).toHaveLength(1);
      expect(screen.edges).toHaveLength(0);
    });

    it('removeWidget cascades automation binding cleanup', () => {
      const w = makeWidget();
      store.getState().addWidget(screenId, w);

      // Set up automation binding that references the widget
      store.getState().addAutomationProgram('prog1', 'Test Program', 'code', [
        { id: 'v1', varName: 'temp', scope: 'INPUT', dataType: 'REAL' },
      ]);
      store.getState().bindVariableToWidget('prog1', 'v1', w.id, 'temperature');

      // Verify binding exists
      let binding = store.getState().automationBindings[0].variableBindings[0];
      expect(binding.boundWidgetId).toBe(w.id);

      // Remove widget should clear the binding
      store.getState().removeWidget(screenId, w.id);
      binding = store.getState().automationBindings[0].variableBindings[0];
      expect(binding.boundWidgetId).toBeNull();
      expect(binding.boundTag).toBeNull();
    });

    it('removeWidget clears selection if selected', () => {
      const w = makeWidget();
      store.getState().addWidget(screenId, w);
      store.getState().setSelectedWidget(w.id);
      expect(store.getState().selectedWidgetId).toBe(w.id);

      store.getState().removeWidget(screenId, w.id);
      expect(store.getState().selectedWidgetId).toBeNull();
    });

    it('removeWidget clears selectedEdgeId if edge references removed widget', () => {
      const w1 = makeWidget();
      const w2 = makeWidget();
      store.getState().addWidget(screenId, w1);
      store.getState().addWidget(screenId, w2);
      const edge = makeEdge(w1.id, w2.id);
      store.getState().addEdge(screenId, edge);
      store.getState().setSelectedEdge(edge.id);
      expect(store.getState().selectedEdgeId).toBe(edge.id);

      store.getState().removeWidget(screenId, w1.id);
      expect(store.getState().selectedEdgeId).toBeNull();
    });

    it('updateWidget merges partial updates', () => {
      const w = makeWidget({ config: { tag: 'pH', label: 'pH Sensor' } });
      store.getState().addWidget(screenId, w);

      store.getState().updateWidget(screenId, w.id, { config: { tag: 'DO', label: 'DO Sensor' } });
      const updated = store.getState().screens[0].widgets[0];
      expect(updated.config).toEqual({ tag: 'DO', label: 'DO Sensor' });
      // widgetType should remain unchanged
      expect(updated.widgetType).toBe('gauge');
    });

    it('updateWidgetPosition updates only position', () => {
      const w = makeWidget();
      store.getState().addWidget(screenId, w);
      const newPos: WidgetPosition = { col: 5, row: 3, w: 4, h: 4 };

      store.getState().updateWidgetPosition(screenId, w.id, newPos);
      const updated = store.getState().screens[0].widgets[0];
      expect(updated.position).toEqual(newPos);
      expect(updated.widgetType).toBe('gauge');
      expect(updated.config).toEqual({});
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Edge Slice                                                       */
  /* ---------------------------------------------------------------- */

  describe('EdgeSlice', () => {
    let screenId: string;
    let w1: ScreenWidget;
    let w2: ScreenWidget;

    beforeEach(() => {
      store.getState().addScreen('process', 'Test');
      screenId = store.getState().screens[0].id;
      w1 = makeWidget();
      w2 = makeWidget();
      store.getState().addWidget(screenId, w1);
      store.getState().addWidget(screenId, w2);
    });

    it('addEdge adds to correct screen', () => {
      const edge = makeEdge(w1.id, w2.id);
      store.getState().addEdge(screenId, edge);
      expect(store.getState().screens[0].edges).toHaveLength(1);
      expect(store.getState().screens[0].edges[0].id).toBe(edge.id);
    });

    it('removeEdge clears selection if selected', () => {
      const edge = makeEdge(w1.id, w2.id);
      store.getState().addEdge(screenId, edge);
      store.getState().setSelectedEdge(edge.id);

      store.getState().removeEdge(screenId, edge.id);
      expect(store.getState().screens[0].edges).toHaveLength(0);
      expect(store.getState().selectedEdgeId).toBeNull();
    });

    it('updateEdgeData merges partial data', () => {
      const edge = makeEdge(w1.id, w2.id);
      store.getState().addEdge(screenId, edge);

      store.getState().updateEdgeData(screenId, edge.id, { label: 'Water Line', animated: true });
      const updated = store.getState().screens[0].edges[0];
      expect(updated.data.connectionType).toBe('process-pipe');
      expect(updated.data.label).toBe('Water Line');
      expect(updated.data.animated).toBe(true);
    });

    it('updateEdgeType clears geometry data', () => {
      const edge: ScadaEdge = {
        ...makeEdge(w1.id, w2.id),
        data: {
          connectionType: 'process-pipe',
          label: 'Pipe',
          animated: true,
          bendPoints: [{ x: 10, y: 20 }],
          routingMode: 'horizontal-first',
        },
      };
      store.getState().addEdge(screenId, edge);

      store.getState().updateEdgeType(screenId, edge.id, 'multiHandle');
      const updated = store.getState().screens[0].edges[0];
      expect(updated.type).toBe('multiHandle');
      // connectionType, label, animated should be preserved
      expect(updated.data.connectionType).toBe('process-pipe');
      expect(updated.data.label).toBe('Pipe');
      expect(updated.data.animated).toBe(true);
      // Geometry data should be cleared
      expect(updated.data.bendPoints).toBeUndefined();
      expect(updated.data.routingMode).toBeUndefined();
    });

    it('edge operations on non-existent screen are no-ops', () => {
      const edge = makeEdge(w1.id, w2.id);
      // Should not throw
      store.getState().addEdge('nonexistent', edge);
      store.getState().removeEdge('nonexistent', edge.id);
      store.getState().updateEdgeData('nonexistent', edge.id, { label: 'test' });
      store.getState().updateEdgeType('nonexistent', edge.id, 'draggable');
      // Original screen unaffected
      expect(store.getState().screens[0].edges).toHaveLength(0);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Selection Slice                                                  */
  /* ---------------------------------------------------------------- */

  describe('SelectionSlice', () => {
    let screenId: string;

    beforeEach(() => {
      store.getState().addScreen('process', 'Test');
      screenId = store.getState().screens[0].id;
    });

    it('setSelectedWidget clears edge selection', () => {
      store.getState().setSelectedEdge('some-edge');
      expect(store.getState().selectedEdgeId).toBe('some-edge');

      store.getState().setSelectedWidget('widget-1');
      expect(store.getState().selectedWidgetId).toBe('widget-1');
      expect(store.getState().selectedEdgeId).toBeNull();
    });

    it('setSelectedEdge clears widget selection', () => {
      store.getState().setSelectedWidget('widget-1');
      expect(store.getState().selectedWidgetId).toBe('widget-1');

      store.getState().setSelectedEdge('edge-1');
      expect(store.getState().selectedEdgeId).toBe('edge-1');
      expect(store.getState().selectedWidgetId).toBeNull();
    });

    it('setSelectedWidget(null) does not clear edge selection', () => {
      store.getState().setSelectedEdge('edge-1');
      store.getState().setSelectedWidget(null);
      expect(store.getState().selectedWidgetId).toBeNull();
      expect(store.getState().selectedEdgeId).toBe('edge-1');
    });

    it('setSelectedEdge(null) does not clear widget selection', () => {
      store.getState().setSelectedWidget('widget-1');
      store.getState().setSelectedEdge(null);
      expect(store.getState().selectedEdgeId).toBeNull();
      expect(store.getState().selectedWidgetId).toBe('widget-1');
    });

    it('copy/paste creates new IDs', () => {
      const w = makeWidget();
      store.getState().addWidget(screenId, w);
      store.getState().setSelectedWidget(w.id);

      store.getState().copySelectedWidgets();
      expect(store.getState().clipboard).not.toBeNull();

      store.getState().pasteWidgets();
      const widgets = store.getState().screens[0].widgets;
      expect(widgets).toHaveLength(2);
      expect(widgets[1].id).not.toBe(w.id);
    });

    it('paste offsets position', () => {
      const w = makeWidget({ position: { col: 3, row: 4, w: 2, h: 2 } });
      store.getState().addWidget(screenId, w);
      store.getState().setSelectedWidget(w.id);

      store.getState().copySelectedWidgets();
      store.getState().pasteWidgets();

      const pasted = store.getState().screens[0].widgets[1];
      expect(pasted.position.col).toBe(4); // 3 + 1
      expect(pasted.position.row).toBe(5); // 4 + 1
    });

    it('paste selects the first pasted widget', () => {
      const w = makeWidget();
      store.getState().addWidget(screenId, w);
      store.getState().setSelectedWidget(w.id);

      store.getState().copySelectedWidgets();
      store.getState().pasteWidgets();

      const pastedWidget = store.getState().screens[0].widgets[1];
      expect(store.getState().selectedWidgetId).toBe(pastedWidget.id);
    });

    it('cut removes from source', () => {
      const w = makeWidget();
      store.getState().addWidget(screenId, w);
      store.getState().setSelectedWidget(w.id);

      store.getState().cutSelectedWidgets();
      expect(store.getState().screens[0].widgets).toHaveLength(0);
      expect(store.getState().clipboard).not.toBeNull();
      expect(store.getState().selectedWidgetId).toBeNull();
    });

    it('cut removes associated edges', () => {
      const w1 = makeWidget();
      const w2 = makeWidget();
      store.getState().addWidget(screenId, w1);
      store.getState().addWidget(screenId, w2);
      const edge = makeEdge(w1.id, w2.id);
      store.getState().addEdge(screenId, edge);

      store.getState().setSelectedWidget(w1.id);
      store.getState().cutSelectedWidgets();

      const screen = store.getState().screens[0];
      expect(screen.widgets).toHaveLength(1);
      expect(screen.edges).toHaveLength(0);
    });

    it('clearClipboard nullifies clipboard', () => {
      const w = makeWidget();
      store.getState().addWidget(screenId, w);
      store.getState().setSelectedWidget(w.id);
      store.getState().copySelectedWidgets();
      expect(store.getState().clipboard).not.toBeNull();

      store.getState().clearClipboard();
      expect(store.getState().clipboard).toBeNull();
    });

    it('paste without clipboard is a no-op', () => {
      store.getState().pasteWidgets();
      expect(store.getState().screens[0].widgets).toHaveLength(0);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  History Slice                                                    */
  /* ---------------------------------------------------------------- */

  describe('HistorySlice', () => {
    let screenId: string;

    beforeEach(() => {
      store.getState().addScreen('process', 'Test');
      screenId = store.getState().screens[0].id;
    });

    it('pushHistory adds to undo stack', () => {
      const w = makeWidget();
      store.getState().pushHistory({ type: 'WIDGET_ADD', screenId, widget: w });
      expect(store.getState().undoStack).toHaveLength(1);
      expect(store.getState().canUndo()).toBe(true);
    });

    it('pushHistory clears redo stack', () => {
      const w = makeWidget();
      store.getState().addWidget(screenId, w);
      store.getState().pushHistory({ type: 'WIDGET_ADD', screenId, widget: w });
      // Undo to populate redo stack
      store.getState().undo();
      expect(store.getState().redoStack).toHaveLength(1);

      // Push new history should clear redo
      const w2 = makeWidget();
      store.getState().pushHistory({ type: 'WIDGET_ADD', screenId, widget: w2 });
      expect(store.getState().redoStack).toHaveLength(0);
    });

    it('undo pops from undo, pushes to redo', () => {
      const w = makeWidget();
      store.getState().addWidget(screenId, w);
      store.getState().pushHistory({ type: 'WIDGET_ADD', screenId, widget: w });
      expect(store.getState().undoStack).toHaveLength(1);
      expect(store.getState().redoStack).toHaveLength(0);

      store.getState().undo();
      expect(store.getState().undoStack).toHaveLength(0);
      expect(store.getState().redoStack).toHaveLength(1);
      expect(store.getState().canUndo()).toBe(false);
      expect(store.getState().canRedo()).toBe(true);
    });

    it('undo WIDGET_ADD removes the widget', () => {
      const w = makeWidget();
      store.getState().addWidget(screenId, w);
      store.getState().pushHistory({ type: 'WIDGET_ADD', screenId, widget: w });
      expect(store.getState().screens[0].widgets).toHaveLength(1);

      store.getState().undo();
      expect(store.getState().screens[0].widgets).toHaveLength(0);
    });

    it('undo WIDGET_REMOVE restores widget and edges', () => {
      const w = makeWidget();
      const w2 = makeWidget();
      const edge = makeEdge(w.id, w2.id);
      store.getState().addWidget(screenId, w);
      store.getState().addWidget(screenId, w2);
      store.getState().addEdge(screenId, edge);

      // Record history entry for the removal
      store.getState().pushHistory({
        type: 'WIDGET_REMOVE',
        screenId,
        widget: { ...w },
        removedEdges: [{ ...edge }],
      });
      // Manually remove to simulate the action
      store.getState().removeWidget(screenId, w.id);
      expect(store.getState().screens[0].widgets).toHaveLength(1);
      expect(store.getState().screens[0].edges).toHaveLength(0);

      // Undo should restore
      store.getState().undo();
      expect(store.getState().screens[0].widgets).toHaveLength(2);
      expect(store.getState().screens[0].edges).toHaveLength(1);
    });

    it('undo WIDGET_MOVE restores position', () => {
      const w = makeWidget({ position: { col: 0, row: 0, w: 2, h: 2 } });
      store.getState().addWidget(screenId, w);

      const from: WidgetPosition = { col: 0, row: 0, w: 2, h: 2 };
      const to: WidgetPosition = { col: 5, row: 3, w: 2, h: 2 };

      store.getState().updateWidgetPosition(screenId, w.id, to);
      store.getState().pushHistory({
        type: 'WIDGET_MOVE',
        screenId,
        widgetId: w.id,
        from,
        to,
      });

      expect(store.getState().screens[0].widgets[0].position).toEqual(to);

      store.getState().undo();
      expect(store.getState().screens[0].widgets[0].position).toEqual(from);
    });

    it('redo reverses the undo', () => {
      const w = makeWidget();
      store.getState().addWidget(screenId, w);
      store.getState().pushHistory({ type: 'WIDGET_ADD', screenId, widget: w });
      expect(store.getState().screens[0].widgets).toHaveLength(1);

      store.getState().undo();
      expect(store.getState().screens[0].widgets).toHaveLength(0);

      store.getState().redo();
      expect(store.getState().screens[0].widgets).toHaveLength(1);
    });

    it('undo stack trimmed to MAX_UNDO_STACK', () => {
      // Push 210 entries (MAX is 200)
      for (let i = 0; i < 210; i++) {
        const w = makeWidget();
        store.getState().pushHistory({ type: 'WIDGET_ADD', screenId, widget: w });
      }
      expect(store.getState().undoStack.length).toBeLessThanOrEqual(200);
    });

    it('BATCH undo applies in reverse order', () => {
      const w1 = makeWidget({ position: { col: 0, row: 0, w: 2, h: 2 } });
      const w2 = makeWidget({ position: { col: 4, row: 4, w: 2, h: 2 } });
      store.getState().addWidget(screenId, w1);
      store.getState().addWidget(screenId, w2);

      // Push batch of two moves
      store.getState().updateWidgetPosition(screenId, w1.id, { col: 1, row: 1, w: 2, h: 2 });
      store.getState().updateWidgetPosition(screenId, w2.id, { col: 5, row: 5, w: 2, h: 2 });

      store.getState().pushHistory({
        type: 'BATCH',
        label: 'Multi-move',
        entries: [
          {
            type: 'WIDGET_MOVE',
            screenId,
            widgetId: w1.id,
            from: { col: 0, row: 0, w: 2, h: 2 },
            to: { col: 1, row: 1, w: 2, h: 2 },
          },
          {
            type: 'WIDGET_MOVE',
            screenId,
            widgetId: w2.id,
            from: { col: 4, row: 4, w: 2, h: 2 },
            to: { col: 5, row: 5, w: 2, h: 2 },
          },
        ],
      });

      store.getState().undo();
      const widgets = store.getState().screens[0].widgets;
      expect(widgets.find((w) => w.id === w1.id)!.position).toEqual({
        col: 0, row: 0, w: 2, h: 2,
      });
      expect(widgets.find((w) => w.id === w2.id)!.position).toEqual({
        col: 4, row: 4, w: 2, h: 2,
      });
    });

    it('undo on empty stack is a no-op', () => {
      expect(store.getState().undoStack).toHaveLength(0);
      store.getState().undo(); // Should not throw
      expect(store.getState().undoStack).toHaveLength(0);
    });

    it('redo on empty stack is a no-op', () => {
      expect(store.getState().redoStack).toHaveLength(0);
      store.getState().redo(); // Should not throw
      expect(store.getState().redoStack).toHaveLength(0);
    });

    it('clearHistory empties both stacks', () => {
      const w = makeWidget();
      store.getState().pushHistory({ type: 'WIDGET_ADD', screenId, widget: w });
      store.getState().undo();
      expect(store.getState().undoStack).toHaveLength(0);
      expect(store.getState().redoStack).toHaveLength(1);

      store.getState().clearHistory();
      expect(store.getState().undoStack).toHaveLength(0);
      expect(store.getState().redoStack).toHaveLength(0);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Alarm Slice                                                      */
  /* ---------------------------------------------------------------- */

  describe('AlarmSlice', () => {
    it('addAlarmRule adds rule', () => {
      const rule = makeAlarmRule();
      store.getState().addAlarmRule(rule);
      expect(store.getState().alarmRules).toHaveLength(1);
      expect(store.getState().alarmRules[0].tag).toBe('pH');
      expect(store.getState().isDirty).toBe(true);
    });

    it('removeAlarmRule removes by ID', () => {
      const rule = makeAlarmRule();
      store.getState().addAlarmRule(rule);
      store.getState().removeAlarmRule(rule.id);
      expect(store.getState().alarmRules).toHaveLength(0);
    });

    it('updateAlarmRule merges partial updates', () => {
      const rule = makeAlarmRule();
      store.getState().addAlarmRule(rule);
      store.getState().updateAlarmRule(rule.id, { value: 9.0, message: 'Updated' });
      const updated = store.getState().alarmRules[0];
      expect(updated.value).toBe(9.0);
      expect(updated.message).toBe('Updated');
      expect(updated.tag).toBe('pH'); // unchanged
    });

    it('updateControlPermissions replaces entirely', () => {
      const perms: ControlPermissionsDef = {
        securityLevels: { none: ['read'], confirm: ['write'], pin: ['admin'] },
        pinHash: 'abc123',
        emergencyStop: {
          holdDuration: 3,
          affectedTags: ['pump1'],
          resetRequiresPin: true,
        },
      };
      store.getState().updateControlPermissions(perms);
      expect(store.getState().controlPermissions).toEqual(perms);
      expect(store.getState().isDirty).toBe(true);
    });

    it('updateTrendConfig replaces entirely', () => {
      const config: TrendConfigDef = {
        retentionDays: 90,
        sampleIntervalSec: 30,
        tags: ['pH', 'DO', 'temp'],
      };
      store.getState().updateTrendConfig(config);
      expect(store.getState().trendConfig).toEqual(config);
    });

    it('default controlPermissions has expected shape', () => {
      const { controlPermissions } = store.getState();
      expect(controlPermissions.securityLevels).toEqual({ none: [], confirm: [], pin: [] });
      expect(controlPermissions.pinHash).toBeNull();
      expect(controlPermissions.emergencyStop).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Project Slice                                                    */
  /* ---------------------------------------------------------------- */

  describe('ProjectSlice', () => {
    it('setPackageName marks dirty', () => {
      store.getState().setPackageName('My Package');
      expect(store.getState().packageName).toBe('My Package');
      expect(store.getState().isDirty).toBe(true);
    });

    it('setPackageId does not mark dirty', () => {
      store.getState().setPackageId('pkg-1');
      expect(store.getState().packageId).toBe('pkg-1');
      // setPackageId should NOT set isDirty
      expect(store.getState().isDirty).toBe(false);
    });

    it('setProcessId marks dirty', () => {
      store.getState().setProcessId('proc-1');
      expect(store.getState().processId).toBe('proc-1');
      expect(store.getState().isDirty).toBe(true);
    });

    it('setTargetDeviceId marks dirty so the choice persists on save (UI-006)', () => {
      store.getState().setTargetDeviceId('dev-1');
      expect(store.getState().targetDeviceId).toBe('dev-1');
      expect(store.getState().isDirty).toBe(true);
    });

    it('setTargetDeviceId to the same value does not re-dirty', () => {
      store.getState().setTargetDeviceId('dev-1');
      store.getState().markClean();
      store.getState().setTargetDeviceId('dev-1');
      expect(store.getState().isDirty).toBe(false);
    });

    it('setRightPanelTab updates tab', () => {
      store.getState().setRightPanelTab('alarms');
      expect(store.getState().rightPanelTab).toBe('alarms');
    });

    it('toScadaPackageJSON round-trips with loadFromJSON', () => {
      // Build up state
      store.getState().setPackageName('Test Package');
      store.getState().setProcessId('proc-1');
      store.getState().setTargetDeviceId('dev-1');
      store.getState().addScreen('dashboard', 'Main Dashboard');
      const screenId = store.getState().screens[0].id;
      const w = makeWidget({ widgetType: 'gauge', config: { tag: 'pH' } });
      store.getState().addWidget(screenId, w);
      const rule = makeAlarmRule();
      store.getState().addAlarmRule(rule);

      // Export
      const json = store.getState().toScadaPackageJSON();
      expect(json.meta?.packageName).toBe('Test Package');
      expect(json.meta?.processId).toBe('proc-1');
      expect(json.screens).toHaveLength(1);
      expect(json.screens![0].widgets).toHaveLength(1);
      expect(json.alarmRules).toHaveLength(1);

      // Reset and reload
      const store2 = createScadaStore();
      store2.getState().loadFromJSON(json);
      expect(store2.getState().packageName).toBe('Test Package');
      expect(store2.getState().processId).toBe('proc-1');
      expect(store2.getState().screens).toHaveLength(1);
      expect(store2.getState().screens[0].widgets).toHaveLength(1);
      expect(store2.getState().alarmRules).toHaveLength(1);
      expect(store2.getState().isDirty).toBe(false);
    });

    it('loadFromJSON normalizes widget types', () => {
      const json: ScadaPackageJSON = {
        screens: [
          {
            id: 'screen-1',
            name: 'Test',
            screenType: 'dashboard',
            isDefault: true,
            widgets: [
              { id: 'w1', widgetType: 'tank-level', position: { col: 0, row: 0, w: 2, h: 2 }, config: {} },
              { id: 'w2', widgetType: 'numeric-display', position: { col: 2, row: 0, w: 2, h: 2 }, config: {} },
            ],
          },
        ],
      };
      store.getState().loadFromJSON(json);
      const widgets = store.getState().screens[0].widgets;
      expect(widgets[0].widgetType).toBe('tankLevel');
      expect(widgets[1].widgetType).toBe('numericDisplay');
    });

    it('loadFromJSON validates edges', () => {
      const json: ScadaPackageJSON = {
        screens: [
          {
            id: 'screen-1',
            name: 'Test',
            screenType: 'process',
            isDefault: true,
            widgets: [],
            edges: [
              // Valid edge
              {
                id: 'e1',
                source: 'w1',
                target: 'w2',
                sourceHandle: 'outlet',
                targetHandle: 'inlet',
                type: 'orthogonal',
                data: { connectionType: 'process-pipe' },
              },
              // Invalid edge (missing data.connectionType) — should be filtered
              {
                id: 'e2',
                source: 'w1',
                target: 'w3',
                sourceHandle: 'outlet',
                targetHandle: 'inlet',
                type: 'orthogonal',
                data: {} as any,
              },
            ] as any[],
          },
        ],
      };
      store.getState().loadFromJSON(json);
      expect(store.getState().screens[0].edges).toHaveLength(1);
      expect(store.getState().screens[0].edges[0].id).toBe('e1');
    });

    it('loadFromJSON normalizes invalid edge types to orthogonal', () => {
      const json: ScadaPackageJSON = {
        screens: [
          {
            id: 'screen-1',
            name: 'Test',
            screenType: 'process',
            isDefault: true,
            widgets: [],
            edges: [
              {
                id: 'e1',
                source: 'w1',
                target: 'w2',
                sourceHandle: 'outlet',
                targetHandle: 'inlet',
                type: 'invalidType' as any,
                data: { connectionType: 'process-pipe' },
              },
            ] as any[],
          },
        ],
      };
      store.getState().loadFromJSON(json);
      expect(store.getState().screens[0].edges[0].type).toBe('orthogonal');
    });

    it('loadFromJSON sets isDirty to false', () => {
      store.getState().setPackageName('Dirty');
      expect(store.getState().isDirty).toBe(true);

      store.getState().loadFromJSON({
        screens: [{ id: 's1', name: 'Test', screenType: 'dashboard', isDefault: true }],
      });
      expect(store.getState().isDirty).toBe(false);
    });

    it('loadFromJSON sets activeScreenId to default screen', () => {
      store.getState().loadFromJSON({
        screens: [
          { id: 's1', name: 'First', screenType: 'dashboard', isDefault: false },
          { id: 's2', name: 'Second', screenType: 'process', isDefault: true },
        ],
      });
      expect(store.getState().activeScreenId).toBe('s2');
    });

    it('loadFromJSON clears selection', () => {
      store.getState().addScreen('dashboard', 'Test');
      const screenId = store.getState().screens[0].id;
      const w = makeWidget();
      store.getState().addWidget(screenId, w);
      store.getState().setSelectedWidget(w.id);

      store.getState().loadFromJSON({ screens: [{ id: 's1', name: 'New', isDefault: true }] });
      expect(store.getState().selectedWidgetId).toBeNull();
      expect(store.getState().selectedEdgeId).toBeNull();
    });

    it('importProcessAsWidget creates screen with processView widget', () => {
      store.getState().importProcessAsWidget({
        id: 'proc-1',
        name: 'Water Treatment',
        nodes: [{ id: 'n1', type: 'pump' }],
        edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      });
      const { screens, processId } = store.getState();
      expect(screens).toHaveLength(1);
      expect(screens[0].screenType).toBe('process');
      expect(screens[0].name).toBe('Water Treatment');
      expect(screens[0].widgets).toHaveLength(1);
      expect(screens[0].widgets[0].widgetType).toBe('processView');
      expect(screens[0].widgets[0].config.processId).toBe('proc-1');
      expect(processId).toBe('proc-1');
    });

    it('importProcessAsWidget on empty store sets first screen as default and active', () => {
      store.getState().importProcessAsWidget({
        id: 'proc-1',
        name: 'Process',
        nodes: [],
        edges: [],
      });
      expect(store.getState().screens[0].isDefault).toBe(true);
      expect(store.getState().activeScreenId).toBe(store.getState().screens[0].id);
    });

    it('importProcessAsWidget on non-empty store does not change active', () => {
      store.getState().addScreen('dashboard', 'Existing');
      const existingActiveId = store.getState().activeScreenId;

      store.getState().importProcessAsWidget({
        id: 'proc-1',
        name: 'Process',
        nodes: [],
        edges: [],
      });
      expect(store.getState().activeScreenId).toBe(existingActiveId);
      expect(store.getState().screens).toHaveLength(2);
    });

    it('reset clears all state', () => {
      // Build up state
      store.getState().setPackageName('Test');
      store.getState().setPackageId('pkg-1');
      store.getState().setProcessId('proc-1');
      store.getState().addScreen('dashboard', 'Main');
      const screenId = store.getState().screens[0].id;
      const w = makeWidget();
      store.getState().addWidget(screenId, w);
      store.getState().setSelectedWidget(w.id);
      store.getState().addAlarmRule(makeAlarmRule());
      store.getState().pushHistory({ type: 'WIDGET_ADD', screenId, widget: w });

      // Reset
      store.getState().reset();

      const s = store.getState();
      expect(s.packageId).toBeNull();
      expect(s.packageName).toBe('');
      expect(s.processId).toBeNull();
      expect(s.targetDeviceId).toBeNull();
      expect(s.screens).toHaveLength(0);
      expect(s.activeScreenId).toBe('');
      expect(s.alarmRules).toHaveLength(0);
      expect(s.automationBindings).toHaveLength(0);
      expect(s.isDirty).toBe(false);
      expect(s.selectedWidgetId).toBeNull();
      expect(s.selectedEdgeId).toBeNull();
      expect(s.undoStack).toHaveLength(0);
      expect(s.redoStack).toHaveLength(0);
      expect(s.clipboard).toBeNull();
      expect(s.rightPanelTab).toBe('widget');
      expect(s.screenViewports).toEqual({});
      expect(s.screenHistory).toEqual([]);
    });

    it('autoBindByTag matches by tag name', () => {
      store.getState().addScreen('process', 'Test');
      const screenId = store.getState().screens[0].id;

      // Widget with config.tag = 'pH'
      const w = makeWidget({ config: { tag: 'pH' } });
      store.getState().addWidget(screenId, w);

      // Add automation program with a variable that should match
      store.getState().addAutomationProgram('prog1', 'Control', 'code', [
        { id: 'v1', varName: 'pH', scope: 'INPUT', dataType: 'REAL' },
        { id: 'v2', varName: 'DO', scope: 'INPUT', dataType: 'REAL' },
      ]);

      const result = store.getState().autoBindByTag();
      expect(result.matched).toBe(1);
      expect(result.unmatched).toBe(1);

      const bindings = store.getState().automationBindings[0].variableBindings;
      const bound = bindings.find((v) => v.variableId === 'v1');
      expect(bound?.boundWidgetId).toBe(w.id);
      expect(bound?.boundTag).toBe('pH');

      const unbound = bindings.find((v) => v.variableId === 'v2');
      expect(unbound?.boundWidgetId).toBeNull();
    });

    it('autoBindByTag uses ioTagName when present', () => {
      store.getState().addScreen('process', 'Test');
      const screenId = store.getState().screens[0].id;

      const w = makeWidget({ config: { tag: 'temperature' } });
      store.getState().addWidget(screenId, w);

      store.getState().addAutomationProgram('prog1', 'Control', 'code', [
        { id: 'v1', varName: 'temp', scope: 'INPUT', dataType: 'REAL', ioTagName: 'temperature' },
      ]);

      const result = store.getState().autoBindByTag();
      expect(result.matched).toBe(1);

      const bound = store.getState().automationBindings[0].variableBindings[0];
      expect(bound.boundWidgetId).toBe(w.id);
    });

    it('autoBindByTag falls back to label matching', () => {
      store.getState().addScreen('process', 'Test');
      const screenId = store.getState().screens[0].id;

      const w = makeWidget({ config: { label: 'dissolved_oxygen' } });
      store.getState().addWidget(screenId, w);

      store.getState().addAutomationProgram('prog1', 'Control', 'code', [
        { id: 'v1', varName: 'dissolved_oxygen', scope: 'INPUT', dataType: 'REAL' },
      ]);

      const result = store.getState().autoBindByTag();
      expect(result.matched).toBe(1);
    });

    it('autoBindByTag skips already-bound variables', () => {
      store.getState().addScreen('process', 'Test');
      const screenId = store.getState().screens[0].id;

      const w1 = makeWidget({ config: { tag: 'pH' } });
      const w2 = makeWidget({ config: { tag: 'DO' } });
      store.getState().addWidget(screenId, w1);
      store.getState().addWidget(screenId, w2);

      store.getState().addAutomationProgram('prog1', 'Control', 'code', [
        { id: 'v1', varName: 'pH', scope: 'INPUT', dataType: 'REAL' },
      ]);

      // Manually bind first
      store.getState().bindVariableToWidget('prog1', 'v1', w1.id, 'pH');

      const result = store.getState().autoBindByTag();
      expect(result.matched).toBe(1); // Already bound counts as matched
      expect(result.unmatched).toBe(0);
    });

    it('addAutomationProgram prevents duplicates', () => {
      store.getState().addAutomationProgram('prog1', 'Control', 'code', [
        { id: 'v1', varName: 'temp', scope: 'INPUT', dataType: 'REAL' },
      ]);
      store.getState().addAutomationProgram('prog1', 'Control', 'code', [
        { id: 'v2', varName: 'pH', scope: 'INPUT', dataType: 'REAL' },
      ]);
      expect(store.getState().automationBindings).toHaveLength(1);
    });

    it('addAutomationProgram filters to INPUT/OUTPUT/INOUT scopes', () => {
      store.getState().addAutomationProgram('prog1', 'Control', 'code', [
        { id: 'v1', varName: 'temp', scope: 'INPUT', dataType: 'REAL' },
        { id: 'v2', varName: 'counter', scope: 'LOCAL', dataType: 'INT' },
        { id: 'v3', varName: 'out', scope: 'OUTPUT', dataType: 'BOOL' },
        { id: 'v4', varName: 'bidir', scope: 'INOUT', dataType: 'REAL' },
      ]);
      const bindings = store.getState().automationBindings[0].variableBindings;
      expect(bindings).toHaveLength(3);
      expect(bindings.map((b) => b.varName)).toEqual(['temp', 'out', 'bidir']);
    });

    it('removeAutomationProgram removes by programId', () => {
      store.getState().addAutomationProgram('prog1', 'Control', 'code', [
        { id: 'v1', varName: 'temp', scope: 'INPUT', dataType: 'REAL' },
      ]);
      store.getState().removeAutomationProgram('prog1');
      expect(store.getState().automationBindings).toHaveLength(0);
    });

    it('unbindVariable clears widget and tag', () => {
      store.getState().addAutomationProgram('prog1', 'Control', 'code', [
        { id: 'v1', varName: 'temp', scope: 'INPUT', dataType: 'REAL' },
      ]);
      store.getState().bindVariableToWidget('prog1', 'v1', 'widget-1', 'temperature');
      expect(store.getState().automationBindings[0].variableBindings[0].boundWidgetId).toBe('widget-1');

      store.getState().unbindVariable('prog1', 'v1');
      expect(store.getState().automationBindings[0].variableBindings[0].boundWidgetId).toBeNull();
      expect(store.getState().automationBindings[0].variableBindings[0].boundTag).toBeNull();
    });

    it('bindVariableToWidgetAndSetTag sets widget config.tagName and removes legacy config.tag', () => {
      store.getState().addScreen('process', 'Test');
      const screenId = store.getState().screens[0].id;
      const w = makeWidget({ config: { tag: 'oldTag' } });
      store.getState().addWidget(screenId, w);

      store.getState().addAutomationProgram('prog1', 'Control', 'code', [
        { id: 'v1', varName: 'temp', scope: 'INPUT', dataType: 'REAL' },
      ]);

      store.getState().bindVariableToWidgetAndSetTag('prog1', 'v1', w.id, 'temperature');

      // Check widget config was updated to tagName
      const widget = store.getState().screens[0].widgets[0];
      expect(widget.config.tagName).toBe('temperature');
      // Legacy config.tag should be removed
      expect(widget.config.tag).toBeUndefined();

      // Check binding was created
      const binding = store.getState().automationBindings[0].variableBindings[0];
      expect(binding.boundWidgetId).toBe(w.id);
      expect(binding.boundTag).toBe('temperature');
    });

    it('toScadaPackageJSON omits edges when empty', () => {
      store.getState().addScreen('dashboard', 'Test');
      const json = store.getState().toScadaPackageJSON();
      // When edges array is empty, it should NOT be included in the screen JSON
      expect(json.screens![0]).not.toHaveProperty('edges');
    });

    it('toScadaPackageJSON includes edges when present', () => {
      store.getState().addScreen('process', 'Test');
      const screenId = store.getState().screens[0].id;
      const w1 = makeWidget();
      const w2 = makeWidget();
      store.getState().addWidget(screenId, w1);
      store.getState().addWidget(screenId, w2);
      store.getState().addEdge(screenId, makeEdge(w1.id, w2.id));

      const json = store.getState().toScadaPackageJSON();
      expect(json.screens![0].edges).toHaveLength(1);
    });

    it('toScadaPackageJSON omits automationBindings when empty', () => {
      store.getState().addScreen('dashboard', 'Test');
      const json = store.getState().toScadaPackageJSON();
      expect(json.meta).not.toHaveProperty('automationBindings');
    });

    it('toScadaPackageJSON includes automationBindings when present', () => {
      store.getState().addAutomationProgram('prog1', 'Control', 'code', [
        { id: 'v1', varName: 'temp', scope: 'INPUT', dataType: 'REAL' },
      ]);
      store.getState().addScreen('dashboard', 'Test');
      const json = store.getState().toScadaPackageJSON();
      expect(json.meta?.automationBindings).toHaveLength(1);
    });

    it('toScadaPackageJSON omits optional alarm fields when undefined', () => {
      const rule = makeAlarmRule();
      // Ensure deadband and delay are undefined
      delete rule.deadband;
      delete rule.delay;
      store.getState().addAlarmRule(rule);
      store.getState().addScreen('dashboard', 'Test');

      const json = store.getState().toScadaPackageJSON();
      const alarmJson = json.alarmRules![0];
      expect(alarmJson).not.toHaveProperty('deadband');
      expect(alarmJson).not.toHaveProperty('delay');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Cross-slice Integration Tests                                    */
  /* ---------------------------------------------------------------- */

  describe('Cross-slice Integration', () => {
    it('store has all initial state fields', () => {
      const s = store.getState();
      // Scene
      expect(s.screens).toEqual([]);
      expect(s.activeScreenId).toBe('');
      expect(s.screenViewports).toEqual({});
      expect(s.screenHistory).toEqual([]);
      // Selection
      expect(s.selectedWidgetId).toBeNull();
      expect(s.selectedEdgeId).toBeNull();
      expect(s.clipboard).toBeNull();
      // History
      expect(s.undoStack).toEqual([]);
      expect(s.redoStack).toEqual([]);
      // Alarm
      expect(s.alarmRules).toEqual([]);
      // Project
      expect(s.packageId).toBeNull();
      expect(s.packageName).toBe('');
      expect(s.processId).toBeNull();
      expect(s.targetDeviceId).toBeNull();
      expect(s.automationBindings).toEqual([]);
      expect(s.isDirty).toBe(false);
      expect(s.rightPanelTab).toBe('widget');
    });

    it('isDirty flag is shared across slices', () => {
      expect(store.getState().isDirty).toBe(false);

      // Scene slice sets dirty
      store.getState().addScreen('dashboard', 'Test');
      expect(store.getState().isDirty).toBe(true);

      // Reset
      store.getState().reset();
      expect(store.getState().isDirty).toBe(false);

      // Alarm slice sets dirty
      store.getState().addAlarmRule(makeAlarmRule());
      expect(store.getState().isDirty).toBe(true);
    });

    it('multiple stores are independent', () => {
      const store2 = createScadaStore();
      store.getState().addScreen('dashboard', 'Store 1');
      expect(store.getState().screens).toHaveLength(1);
      expect(store2.getState().screens).toHaveLength(0);
    });
  });
});
