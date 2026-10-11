/**
 * Module.tsx route-chunk preloads (E2E-FLAKE).
 *
 * The sidebar hovers of the shell call `preloadFarmRoute` through the
 * federation boundary before a click, so a lazy page chunk is already
 * resolved when navigation renders it — the page's buttons exist in the DOM
 * immediately instead of appearing after the Suspense fallback. These specs
 * pin the export surface and the path -> chunk mapping the shell depends on.
 *
 * Page modules are mocked with recording factories: a factory only runs when
 * its chunk is actually imported, so `tracker.loaded` observes exactly which
 * chunk each preload call warmed.
 */
import { describe, expect, it, vi } from 'vitest';

const tracker = vi.hoisted(() => {
  const loaded: string[] = [];
  return { loaded, load: (chunk: string): void => void loaded.push(chunk) };
});

vi.mock('../pages/tanks/TanksPage', () => {
  tracker.load('tanks');
  return { default: (): null => null };
});
vi.mock('../pages/feeding/FeedingPage', () => {
  tracker.load('feeding');
  return { default: (): null => null };
});
vi.mock('../pages/environment/EnvironmentPage', () => {
  tracker.load('environment');
  return { default: (): null => null };
});
vi.mock('../pages/water-chemistry/WaterChemistryPage', () => {
  tracker.load('water-chemistry');
  return { default: (): null => null };
});

const Module = await import('../Module');

describe('farm-module route preloads', () => {
  it('exports a preload loader for every lazily loaded page chunk', () => {
    expect(typeof Module.preloadFarmRoute).toBe('function');
    const preloadExports = [
      'preloadEnvironmentPage',
      'preloadSetupPage',
      'preloadReportsPage',
      'preloadTanksPage',
      'preloadFeedingPage',
      'preloadStoragePage',
      'preloadHealthEventsPage',
      'preloadHarvestPlansPage',
      'preloadTasksPage',
      'preloadCompanyPage',
      'preloadWaterChemistryPage',
      'preloadAnalyticsPage',
      'preloadBatchDetailPage',
      'preloadMaintenancePage',
      'preloadFinancePage',
    ];
    for (const name of preloadExports) {
      expect(typeof (Module as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  // NOTE: a vi.mock factory runs only ONCE per module id — the first import —
  // so a chunk's first load is the only observable event. Cases therefore
  // assert cumulatively (toContain / set equality), never per-call isolation.
  it.each([
    // The sidebar's flattened target (MainLayout nav config): the query must
    // not break matching — this is the exact string a hover sends.
    ['/sites/feeding?tab=records', 'feeding'],
    ['/sites/tanks?tab=cleanerFish', 'tanks'],
    // Plain direct routes.
    ['/sites/tanks', 'tanks'],
    ['/sites/environment', 'environment'],
    ['/sites/water-chemistry', 'water-chemistry'],
    // Redirect SOURCES must warm their target's chunk, not their own (none).
    ['/sites/feeding/records', 'feeding'],
    ['/sites/cleaner-fish', 'tanks'],
  ])('preloadFarmRoute(%s) warms the %s chunk', async (path, chunk) => {
    Module.preloadFarmRoute(path);
    await vi.dynamicImportSettled();
    expect(tracker.loaded).toContain(chunk);
  });

  it('warms exactly the mapped chunks and nothing else', async () => {
    // Every preload above has settled: the set of chunks that ever loaded must
    // be exactly the mapped ones — no eager page imports, no cross-loading.
    expect([...new Set(tracker.loaded)].sort()).toEqual([
      'environment',
      'feeding',
      'tanks',
      'water-chemistry',
    ]);
  });

  it('is a no-op for paths this module does not render', async () => {
    const before = tracker.loaded.length;
    Module.preloadFarmRoute('/tenant/users');
    Module.preloadFarmRoute('/sites/does-not-exist');
    await vi.dynamicImportSettled();
    expect(tracker.loaded.length).toBe(before);
  });
});
