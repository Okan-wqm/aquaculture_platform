/**
 * Phase 2: Layer Management & Z-Order — Unit Tests
 *
 * Covers:
 * - Widget slice z-order actions (bringToFront, sendToBack, bringForward, sendBackward)
 * - Edge cases (topmost/bottommost no-ops)
 * - Visibility toggle
 * - Selection slice highlightedWidgetId
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createScadaStore } from '../store/scada/createScadaStore';

type Store = ReturnType<typeof createScadaStore>;

/* ------------------------------------------------------------------ */
/*  Shared test helpers                                                */
/* ------------------------------------------------------------------ */

function getWidget(store: Store, screenId: string, widgetId: string) {
  const screen = store.getState().screens.find((s) => s.id === screenId);
  return screen?.widgets.find((w) => w.id === widgetId);
}

function getZIndex(store: Store, screenId: string, widgetId: string): number {
  return getWidget(store, screenId, widgetId)?.zIndex ?? 0;
}

/* ------------------------------------------------------------------ */
/*  Z-Order Store Actions                                              */
/* ------------------------------------------------------------------ */

describe('WidgetSlice — Layer Z-Order Actions', () => {
  let store: Store;
  let screenId: string;

  beforeEach(() => {
    store = createScadaStore();
    store.getState().addScreen('dashboard', 'Test Screen');
    screenId = store.getState().activeScreenId;

    // Three widgets with explicit z-index values for deterministic ordering
    store.getState().addWidget(screenId, {
      id: 'w1', widgetType: 'gauge', position: { col: 0, row: 0, w: 2, h: 2 },
      config: {}, zIndex: 0,
    });
    store.getState().addWidget(screenId, {
      id: 'w2', widgetType: 'gauge', position: { col: 3, row: 0, w: 2, h: 2 },
      config: {}, zIndex: 10,
    });
    store.getState().addWidget(screenId, {
      id: 'w3', widgetType: 'gauge', position: { col: 6, row: 0, w: 2, h: 2 },
      config: {}, zIndex: 20,
    });
  });

  /* ---- bringToFront ---- */

  it('should set zIndex above all others when bringToFront is called', () => {
    // w1 starts at z=0, w3 is at z=20
    store.getState().bringToFront(screenId, 'w1');
    const z1 = getZIndex(store, screenId, 'w1');

    expect(z1).toBeGreaterThan(20);
    // Should be 30 (max=20 + 10 gap)
    expect(z1).toBe(30);
  });

  /* ---- sendToBack ---- */

  it('should set zIndex below all others when sendToBack is called', () => {
    // w3 starts at z=20, w1 is at z=0
    store.getState().sendToBack(screenId, 'w3');
    const z3 = getZIndex(store, screenId, 'w3');

    expect(z3).toBeLessThan(0);
    // Should be -10 (min=0 - 10 gap)
    expect(z3).toBe(-10);
  });

  /* ---- bringForward ---- */

  it('should swap zIndex with next widget above when bringForward is called', () => {
    // Order: w1(0) < w2(10) < w3(20)
    // Bring w1 forward — should swap with w2
    store.getState().bringForward(screenId, 'w1');

    const z1 = getZIndex(store, screenId, 'w1');
    const z2 = getZIndex(store, screenId, 'w2');

    // After swap: w1 gets w2's old z-index (10), w2 gets w1's old z-index (0)
    expect(z1).toBe(10);
    expect(z2).toBe(0);
  });

  /* ---- sendBackward ---- */

  it('should swap zIndex with next widget below when sendBackward is called', () => {
    // Order: w1(0) < w2(10) < w3(20)
    // Send w3 backward — should swap with w2
    store.getState().sendBackward(screenId, 'w3');

    const z3 = getZIndex(store, screenId, 'w3');
    const z2 = getZIndex(store, screenId, 'w2');

    // After swap: w3 gets w2's old z-index (10), w2 gets w3's old z-index (20)
    expect(z3).toBe(10);
    expect(z2).toBe(20);
  });

  /* ---- No-op edge cases ---- */

  it('should be a no-op when bringForward is called on the topmost widget', () => {
    const zBefore = getZIndex(store, screenId, 'w3');
    store.getState().bringForward(screenId, 'w3');
    const zAfter = getZIndex(store, screenId, 'w3');

    expect(zAfter).toBe(zBefore);
  });

  it('should be a no-op when sendBackward is called on the bottommost widget', () => {
    const zBefore = getZIndex(store, screenId, 'w1');
    store.getState().sendBackward(screenId, 'w1');
    const zAfter = getZIndex(store, screenId, 'w1');

    expect(zAfter).toBe(zBefore);
  });

  /* ---- Locked widget protection ---- */

  it('should not change zIndex of a locked widget', () => {
    store.getState().toggleWidgetLock(screenId, 'w1');
    store.getState().bringToFront(screenId, 'w1');
    expect(getZIndex(store, screenId, 'w1')).toBe(0);
  });

  /* ---- setWidgetZIndex ---- */

  it('should allow direct z-index assignment via setWidgetZIndex', () => {
    store.getState().setWidgetZIndex(screenId, 'w1', 999);
    expect(getZIndex(store, screenId, 'w1')).toBe(999);
  });
});

/* ------------------------------------------------------------------ */
/*  Visibility Toggle                                                  */
/* ------------------------------------------------------------------ */

describe('WidgetSlice — Visibility Toggle', () => {
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

  it('should toggle widget visibility from default (true) to false', () => {
    // Default: visible is undefined (treated as true)
    expect(getWidget(store, screenId, 'w1')?.visible).toBeUndefined();

    store.getState().toggleWidgetVisibility(screenId, 'w1');
    expect(getWidget(store, screenId, 'w1')?.visible).toBe(false);
  });

  it('should toggle widget visibility back to true', () => {
    store.getState().toggleWidgetVisibility(screenId, 'w1');
    expect(getWidget(store, screenId, 'w1')?.visible).toBe(false);

    store.getState().toggleWidgetVisibility(screenId, 'w1');
    expect(getWidget(store, screenId, 'w1')?.visible).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Highlighted Widget (Selection Slice)                               */
/* ------------------------------------------------------------------ */

describe('SelectionSlice — Highlighted Widget', () => {
  let store: Store;

  beforeEach(() => {
    store = createScadaStore();
  });

  it('should set highlightedWidgetId when setHighlightedWidget is called', () => {
    expect(store.getState().highlightedWidgetId).toBeNull();

    store.getState().setHighlightedWidget('w1');
    expect(store.getState().highlightedWidgetId).toBe('w1');
  });

  it('should clear highlightedWidgetId when null is passed', () => {
    store.getState().setHighlightedWidget('w1');
    store.getState().setHighlightedWidget(null);
    expect(store.getState().highlightedWidgetId).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  bringForward/sendBackward with same z-index values                 */
/* ------------------------------------------------------------------ */

describe('WidgetSlice — Equal Z-Index Handling', () => {
  let store: Store;
  let screenId: string;

  beforeEach(() => {
    store = createScadaStore();
    store.getState().addScreen('dashboard', 'Test Screen');
    screenId = store.getState().activeScreenId;

    // Two widgets with the same z-index
    store.getState().addWidget(screenId, {
      id: 'w1', widgetType: 'gauge', position: { col: 0, row: 0, w: 2, h: 2 },
      config: {}, zIndex: 5,
    });
    store.getState().addWidget(screenId, {
      id: 'w2', widgetType: 'gauge', position: { col: 3, row: 0, w: 2, h: 2 },
      config: {}, zIndex: 5,
    });
  });

  it('should handle bringForward when two widgets have the same z-index', () => {
    // When both are at z=5, bringForward on w1 should nudge it to z=6
    store.getState().bringForward(screenId, 'w1');
    const z1 = getZIndex(store, screenId, 'w1');
    const z2 = getZIndex(store, screenId, 'w2');

    // w1 should now be above w2
    expect(z1).toBeGreaterThan(z2);
  });

  it('should handle sendBackward when two widgets have the same z-index', () => {
    // When both are at z=5, sendBackward on w2 should nudge it to z=4
    store.getState().sendBackward(screenId, 'w2');
    const z1 = getZIndex(store, screenId, 'w1');
    const z2 = getZIndex(store, screenId, 'w2');

    // w2 should now be below w1
    expect(z2).toBeLessThan(z1);
  });
});
