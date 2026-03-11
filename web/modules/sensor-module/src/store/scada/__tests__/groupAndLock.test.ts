import { describe, it, expect, beforeEach } from 'vitest';
import { createScadaStore } from '../createScadaStore';

type Store = ReturnType<typeof createScadaStore>;

describe('GroupSlice', () => {
  let store: Store;
  let screenId: string;

  beforeEach(() => {
    store = createScadaStore();
    // Set up a screen with widgets
    store.getState().addScreen('dashboard', 'Test Screen');
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

  it('should group widgets and assign same groupId', () => {
    const groupId = store.getState().groupWidgets(screenId, ['w1', 'w2']);
    expect(groupId).toBeTruthy();

    const screen = store.getState().screens.find(s => s.id === screenId);
    const w1 = screen?.widgets.find(w => w.id === 'w1');
    const w2 = screen?.widgets.find(w => w.id === 'w2');
    const w3 = screen?.widgets.find(w => w.id === 'w3');

    expect(w1?.groupId).toBe(groupId);
    expect(w2?.groupId).toBe(groupId);
    expect(w3?.groupId).toBeUndefined(); // Not in group
  });

  it('should ungroup widgets', () => {
    const groupId = store.getState().groupWidgets(screenId, ['w1', 'w2']);
    store.getState().ungroupWidgets(screenId, groupId);

    const screen = store.getState().screens.find(s => s.id === screenId);
    expect(screen?.widgets.find(w => w.id === 'w1')?.groupId).toBeNull();
    expect(screen?.widgets.find(w => w.id === 'w2')?.groupId).toBeNull();
  });

  it('should return group members', () => {
    const groupId = store.getState().groupWidgets(screenId, ['w1', 'w3']);
    const members = store.getState().getGroupMembers(screenId, groupId);
    expect(members).toEqual(expect.arrayContaining(['w1', 'w3']));
    expect(members).toHaveLength(2);
  });

  it('should return empty array for non-existent group', () => {
    const members = store.getState().getGroupMembers(screenId, 'non-existent');
    expect(members).toEqual([]);
  });

  it('should return empty array for non-existent screen', () => {
    const members = store.getState().getGroupMembers('bad-screen', 'any-group');
    expect(members).toEqual([]);
  });

  it('should set isDirty when grouping', () => {
    store.setState({ isDirty: false });
    store.getState().groupWidgets(screenId, ['w1', 'w2']);
    expect(store.getState().isDirty).toBe(true);
  });

  it('should set isDirty when ungrouping', () => {
    const groupId = store.getState().groupWidgets(screenId, ['w1', 'w2']);
    store.setState({ isDirty: false });
    store.getState().ungroupWidgets(screenId, groupId);
    expect(store.getState().isDirty).toBe(true);
  });
});

describe('Widget Locking', () => {
  let store: Store;
  let screenId: string;

  beforeEach(() => {
    store = createScadaStore();
    store.getState().addScreen('dashboard', 'Test Screen');
    screenId = store.getState().activeScreenId;
    store.getState().addWidget(screenId, {
      id: 'w1', widgetType: 'gauge', position: { col: 0, row: 0, w: 2, h: 2 }, config: {},
    });
  });

  it('should toggle widget lock on', () => {
    store.getState().toggleWidgetLock(screenId, 'w1');

    const screen = store.getState().screens.find(s => s.id === screenId);
    expect(screen?.widgets.find(w => w.id === 'w1')?.locked).toBe(true);
  });

  it('should toggle widget lock off', () => {
    store.getState().toggleWidgetLock(screenId, 'w1');
    store.getState().toggleWidgetLock(screenId, 'w1');

    const screen = store.getState().screens.find(s => s.id === screenId);
    expect(screen?.widgets.find(w => w.id === 'w1')?.locked).toBe(false);
  });

  it('should prevent position update when locked', () => {
    store.getState().toggleWidgetLock(screenId, 'w1');

    // Try to move — should be blocked
    store.getState().updateWidgetPosition(screenId, 'w1', { col: 5, row: 5, w: 2, h: 2 });

    const screen = store.getState().screens.find(s => s.id === screenId);
    const widget = screen?.widgets.find(w => w.id === 'w1');
    expect(widget?.position.col).toBe(0); // unchanged
    expect(widget?.position.row).toBe(0); // unchanged
  });

  it('should allow position update when unlocked', () => {
    store.getState().updateWidgetPosition(screenId, 'w1', { col: 5, row: 5, w: 2, h: 2 });

    const screen = store.getState().screens.find(s => s.id === screenId);
    const widget = screen?.widgets.find(w => w.id === 'w1');
    expect(widget?.position.col).toBe(5);
    expect(widget?.position.row).toBe(5);
  });

  it('should prevent bringToFront when locked', () => {
    store.getState().addWidget(screenId, {
      id: 'w2', widgetType: 'gauge', position: { col: 3, row: 0, w: 2, h: 2 }, config: {},
    });
    store.getState().toggleWidgetLock(screenId, 'w1');

    const orderBefore = store.getState().screens.find(s => s.id === screenId)?.widgets.map(w => w.id);
    store.getState().bringToFront(screenId, 'w1');
    const orderAfter = store.getState().screens.find(s => s.id === screenId)?.widgets.map(w => w.id);

    expect(orderAfter).toEqual(orderBefore); // unchanged
  });

  it('should prevent sendToBack when locked', () => {
    store.getState().addWidget(screenId, {
      id: 'w2', widgetType: 'gauge', position: { col: 3, row: 0, w: 2, h: 2 }, config: {},
    });
    store.getState().toggleWidgetLock(screenId, 'w2'); // lock w2, which is at the end

    const orderBefore = store.getState().screens.find(s => s.id === screenId)?.widgets.map(w => w.id);
    store.getState().sendToBack(screenId, 'w2');
    const orderAfter = store.getState().screens.find(s => s.id === screenId)?.widgets.map(w => w.id);

    expect(orderAfter).toEqual(orderBefore); // unchanged
  });

  it('should set isDirty when toggling lock', () => {
    store.setState({ isDirty: false });
    store.getState().toggleWidgetLock(screenId, 'w1');
    expect(store.getState().isDirty).toBe(true);
  });
});
