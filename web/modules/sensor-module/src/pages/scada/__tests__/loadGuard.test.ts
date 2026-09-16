/**
 * Load-guard tests (critical data-loss fix).
 *
 * Covers the pure decision helpers used by ScadaPackageBuilderPage AND the
 * store-level guarantee: navigating from package A to package B can never
 * write A's data into B (via reset-before-load), and a dirty A is never
 * clobbered by a re-fetch.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { decidePackageLoad, shouldAutoAddScreen } from '../loadGuard';
import { createScadaStore } from '../../../store/scada/createScadaStore';
import type { ScadaPackageJSON } from '../../../store/scada';

type Store = ReturnType<typeof createScadaStore>;

function packageJson(name: string, screenName: string): ScadaPackageJSON {
  return {
    meta: { schemaVersion: 2, packageName: name },
    screens: [
      {
        id: `screen-${name}`,
        name: screenName,
        screenType: 'process',
        isDefault: true,
        widgets: [
          {
            id: `widget-${name}`,
            widgetType: 'gauge',
            position: { col: 0, row: 0, w: 2, h: 2 },
            config: { tagName: `${name}.ph` },
          },
        ],
        edges: [],
      },
    ],
  };
}

describe('decidePackageLoad', () => {
  it('skips a fetch that does not belong to the current route', () => {
    expect(
      decidePackageLoad({
        routePackageId: 'B',
        fetchedPackageId: 'A',
        storePackageId: null,
        isDirty: false,
      }),
    ).toBe('skip');
  });

  it('never clobbers a dirty store for the SAME package', () => {
    expect(
      decidePackageLoad({
        routePackageId: 'A',
        fetchedPackageId: 'A',
        storePackageId: 'A',
        isDirty: true,
      }),
    ).toBe('skip');
  });

  it('resets before loading when the store holds a DIFFERENT package (A→B)', () => {
    expect(
      decidePackageLoad({
        routePackageId: 'B',
        fetchedPackageId: 'B',
        storePackageId: 'A',
        isDirty: true,
      }),
    ).toBe('reset-and-load');
    expect(
      decidePackageLoad({
        routePackageId: 'B',
        fetchedPackageId: 'B',
        storePackageId: 'A',
        isDirty: false,
      }),
    ).toBe('reset-and-load');
  });

  it('plain load for a clean same-package refresh or a fresh store', () => {
    expect(
      decidePackageLoad({ routePackageId: 'A', fetchedPackageId: 'A', storePackageId: 'A', isDirty: false }),
    ).toBe('load');
    expect(
      decidePackageLoad({ routePackageId: 'A', fetchedPackageId: 'A', storePackageId: null, isDirty: false }),
    ).toBe('load');
  });
});

describe('shouldAutoAddScreen', () => {
  it('waits while a package is loading', () => {
    expect(
      shouldAutoAddScreen({ storePackageId: null, routePackageId: 'A', isLoading: true }),
    ).toBe(false);
  });

  it('bootstraps for a fresh store or /new', () => {
    expect(shouldAutoAddScreen({ storePackageId: null, routePackageId: 'A', isLoading: false })).toBe(true);
    expect(shouldAutoAddScreen({ storePackageId: 'A', routePackageId: 'new', isLoading: false })).toBe(true);
  });

  it('blocks the phantom screen when the store belongs to a different package', () => {
    // Store still holds A while the route points at B — a load is pending
    expect(shouldAutoAddScreen({ storePackageId: 'A', routePackageId: 'B', isLoading: false })).toBe(false);
    expect(shouldAutoAddScreen({ storePackageId: 'A', routePackageId: 'A', isLoading: false })).toBe(true);
  });
});

describe('store + load guard integration (A→B navigation never writes A into B)', () => {
  let store: Store;

  beforeEach(() => {
    store = createScadaStore();
  });

  it('dirty package A survives a re-fetch of A (skip)', () => {
    store.getState().loadFromJSON(packageJson('A', 'A Screen'));
    store.getState().setPackageId('A');
    store.getState().setPackageName('A (edited)');

    const decision = decidePackageLoad({
      routePackageId: 'A',
      fetchedPackageId: 'A',
      storePackageId: store.getState().packageId,
      isDirty: store.getState().isDirty,
    });
    expect(decision).toBe('skip');

    // Applying the decision literally: nothing happens, edits preserved
    expect(store.getState().packageName).toBe('A (edited)');
    expect(store.getState().screens).toHaveLength(1);
  });

  it('navigating A→B resets first: A data can never leak into B', () => {
    store.getState().loadFromJSON(packageJson('A', 'A Screen'));
    store.getState().setPackageId('A');
    const aWidgetId = store.getState().screens[0].widgets[0].id;

    const decision = decidePackageLoad({
      routePackageId: 'B',
      fetchedPackageId: 'B',
      storePackageId: store.getState().packageId,
      isDirty: store.getState().isDirty,
    });
    expect(decision).toBe('reset-and-load');

    // Apply the decision exactly like the page effect does
    store.getState().reset();
    store.getState().loadFromJSON(packageJson('B', 'B Screen'));
    store.getState().setPackageId('B');

    expect(store.getState().packageId).toBe('B');
    expect(store.getState().screens).toHaveLength(1);
    expect(store.getState().screens[0].name).toBe('B Screen');
    // A's widget is gone; B's widget is present
    const widgetIds = store.getState().screens[0].widgets.map((w) => w.id);
    expect(widgetIds).not.toContain(aWidgetId);
    expect(widgetIds).toContain('widget-B');
  });

  it('a late STALE fetch for A is skipped on route B', () => {
    store.getState().loadFromJSON(packageJson('B', 'B Screen'));
    store.getState().setPackageId('B');

    const decision = decidePackageLoad({
      routePackageId: 'B',
      fetchedPackageId: 'A', // late response from the previous page
      storePackageId: 'B',
      isDirty: false,
    });
    expect(decision).toBe('skip');
    expect(store.getState().screens[0].name).toBe('B Screen');
  });
});
