/**
 * INVARIANT (FE-HIGH-335, FE-HIGH-334): every routed tenant page is reachable
 * from the console navigation, and every console entry is a real page.
 *
 * WHY: before the console, 16 tenant pages had no nav entry and no in-app link
 * (alert rules, thresholds, tag registry, industry setup, team overview, …),
 * a dozen more were reachable only through another page, and two module-user
 * entries (`/analytics`, `/reports`) pointed at routes nothing served. Both
 * kinds of drift are silent: a page nobody can reach still passes its own
 * tests, and a dead link renders fine until clicked.
 *
 * The routes are read from source (lib/web-tenant-route-table.ts): App.tsx's
 * mounts, each remote's Module.tsx, the pages hosting a nested `<Routes>`, and
 * the tab unions of the pages that switch on `?tab=` (or, for settings, on the
 * path). The nav is the console's own data (web/shell/src/console/nav),
 * imported as data. Rules:
 *
 *   1. Coverage — each leaf route (not a `<Navigate>` redirect) is a nav
 *      entry's path, one of its tabs, or matched by its `matchPaths` (detail,
 *      create, alias routes); else it is in EXEMPT with a reason.
 *   2. No dead entry — every entry path, tab and pattern resolves to a leaf
 *      route; a redirect source does not count (E2E-FLAKE: an entry names the
 *      final route, not a hop).
 *   3. Placeholders — a routed "coming soon" page is listed as `planned`, and
 *      `planned` is only ever a placeholder.
 *   4. Gates — the nav's module table is App.tsx's `requiredModule` table, and
 *      each tenant page's gate is its route's RequireTenantCapability gate.
 *   5. Redirects land — each static `<Navigate>` target is a leaf route.
 *   6. Nothing escapes the scan — every web file hosting a `<Routes>` or
 *      reading `?tab=` is one the scan reads (or names why not).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  CONSOLE_WORKSPACES,
  MODULE_MOUNTS,
  parseNavLocation,
  patternMatches,
  type NavPageDef,
} from '../../web/shell/src/console/nav';

import {
  REPO_ROOT,
  joinRoute,
  readRoutes,
  redirectTarget,
  unionLiterals,
  type RawRoute,
} from './lib/web-tenant-route-table';

const SHELL_APP = 'web/shell/src/App.tsx';
const FARM_PAGES = 'web/modules/farm-module/src/pages';

/** Splat routes whose element hosts a `<Routes>` of its own: the file that declares them. */
const NESTED_ROUTE_FILES: Readonly<Record<string, string>> = {
  '/dashboard/*': 'web/modules/dashboard/src/Module.tsx',
  '/sites/*': 'web/modules/farm-module/src/Module.tsx',
  '/hr/*': 'web/modules/hr-module/src/Module.tsx',
  '/sensor/*': 'web/modules/sensor-module/src/Module.tsx',
  '/hydroponics/*': 'web/modules/hydroponics-module/src/Module.tsx',
  '/messaging/*': 'web/modules/messaging-module/src/Module.tsx',
  '/tenant/*': 'web/modules/tenant-admin/src/Module.tsx',
  '/sites/setup/*': `${FARM_PAGES}/setup/SetupPage.tsx`,
  '/sites/reports/*': `${FARM_PAGES}/reports/ReportsPage.tsx`,
  '/sites/analytics/*': `${FARM_PAGES}/analytics/AnalyticsPage.tsx`,
  '/sites/batch/:batchId/*': `${FARM_PAGES}/production/BatchDetailPage.tsx`,
  '/hydroponics/solution/*': 'web/modules/hydroponics-module/src/pages/solution/SolutionPage.tsx',
};

interface TabSource {
  readonly file: string;
  /** Captures the page's tab union (`'a' | 'b'`). */
  readonly union: RegExp;
}

const TAB_ID_UNION = /type TabId =([^;]+);/;

/** Pages that switch on `?tab=`: the leaf pathname → where its tab ids are declared. */
const QUERY_TAB_SOURCES: Readonly<Record<string, TabSource>> = {
  '/sites/tanks': {
    file: `${FARM_PAGES}/tanks/TanksPage.tsx`,
    union: /useState<([^>]+)>\(\s*tabFromUrl/,
  },
  '/sites/feeding': { file: `${FARM_PAGES}/feeding/FeedingPage.tsx`, union: TAB_ID_UNION },
  '/sites/water-chemistry': {
    file: `${FARM_PAGES}/water-chemistry/WaterChemistryPage.tsx`,
    union: TAB_ID_UNION,
  },
  '/sites/storage': { file: `${FARM_PAGES}/storage/StoragePage.tsx`, union: TAB_ID_UNION },
  '/sites/maintenance': {
    file: `${FARM_PAGES}/maintenance/MaintenancePage.tsx`,
    union: TAB_ID_UNION,
  },
  '/sites/tasks': { file: `${FARM_PAGES}/tasks/TasksPage.tsx`, union: TAB_ID_UNION },
  '/sites/finance': { file: `${FARM_PAGES}/finance/FinancePage.tsx`, union: TAB_ID_UNION },
  '/hr/finance': {
    file: 'web/modules/hr-module/src/pages/finance/HRFinancePage.tsx',
    union: TAB_ID_UNION,
  },
};

/** Splat routes whose page switches tab on the path segment (no `<Routes>`). */
const PATH_TAB_SOURCES: Readonly<Record<string, TabSource>> = {
  '/settings/*': {
    file: 'web/shell/src/pages/SettingsPage.tsx',
    union: /type SettingsTab =([^;]+);/,
  },
};

/** `?tab=` readers below a parameter route: the route (covered as a pattern) carries them. */
const TAB_READERS_UNDER_PARAM_ROUTES: Readonly<Record<string, string>> = {
  'web/modules/sensor-module/src/pages/DeviceDetailPage.tsx': '/sensor/devices/:deviceId',
};

/** Files reading a `tab` query that are not pages, and why. */
const NON_PAGE_TAB_READERS: Readonly<Record<string, string>> = {
  'web/shell/src/console/nav/match.ts': "the console nav's own location parser",
};

/** Routes the console nav deliberately does not reach, keyed by declared pattern. */
const EXEMPT: Readonly<Record<string, string>> = {
  '/': 'RoleBasedRedirect: sends each role to its home (/tenant, /dashboard, /admin)',
  '/login': 'public auth page (AuthLayout), outside the console',
  '/forgot-password': 'public auth page (AuthLayout), outside the console',
  '/reset-password/:token': 'public auth page reached from the reset e-mail',
  '/accept-invitation/:token': 'public auth page reached from the invitation e-mail',
  '/unauthorized': 'error page the route guards redirect to, outside the console',
  '/*': 'NotFoundPage for unknown URLs, outside the console',
  '/admin/*': 'SUPER_ADMIN console: keeps its own Sidebar, never the tenant console',
};

/** Files hosting a `<Routes>` the scan does not read, and why. */
const UNSCANNED_ROUTES_FILES: Readonly<Record<string, string>> = {
  'web/modules/admin-panel/src/Module.tsx': 'SUPER_ADMIN console, exempt as /admin/*',
};

interface Leaf {
  readonly pattern: string;
  readonly tab: string | null;
  readonly file: string;
  readonly element: string;
}

interface RouteTable {
  readonly leaves: readonly Leaf[];
  readonly redirects: readonly {
    readonly source: string;
    readonly target: string;
    readonly file: string;
  }[];
  readonly exempted: ReadonlySet<string>;
  readonly appRoutes: readonly RawRoute[];
}

function leafKey(pattern: string, tab: string | null): string {
  return tab === null ? pattern : `${pattern}?tab=${tab}`;
}

function buildRouteTable(): RouteTable {
  const leaves = new Map<string, Leaf>();
  const redirects: { source: string; target: string; file: string }[] = [];
  const exempted = new Set<string>();
  const addLeaf = (leaf: Leaf): void => {
    leaves.set(leafKey(leaf.pattern, leaf.tab), leaf);
  };

  const expand = (route: RawRoute): void => {
    if (EXEMPT[route.pattern] !== undefined) {
      exempted.add(route.pattern);
      return;
    }
    const target = redirectTarget(route.element);
    if (target !== undefined) {
      const resolved = target.startsWith('/') ? target : joinRoute(route.prefix, target);
      redirects.push({ source: route.pattern, target: resolved, file: route.file });
      return;
    }
    const nested = NESTED_ROUTE_FILES[route.pattern];
    // A nested file's own catch-all shares its mount pattern; only the mount recurses.
    if (nested !== undefined && nested !== route.file) {
      for (const child of readRoutes(nested, route.pattern.slice(0, -2))) expand(child);
      return;
    }
    const pathTabs = PATH_TAB_SOURCES[route.pattern];
    if (pathTabs !== undefined) {
      const base = route.pattern.slice(0, -2);
      for (const tab of unionLiterals(pathTabs.file, pathTabs.union)) {
        addLeaf({
          pattern: `${base}/${tab}`,
          tab: null,
          file: pathTabs.file,
          element: route.element,
        });
      }
      return;
    }
    // A splat with no nested router only tolerates sub-paths: the page is its base.
    const pattern = route.pattern.endsWith('/*') ? route.pattern.slice(0, -2) : route.pattern;
    addLeaf({ pattern, tab: null, file: route.file, element: route.element });
    const queryTabs = QUERY_TAB_SOURCES[pattern];
    if (queryTabs !== undefined) {
      for (const tab of unionLiterals(queryTabs.file, queryTabs.union)) {
        addLeaf({ pattern, tab, file: queryTabs.file, element: route.element });
      }
    }
  };

  const appRoutes = readRoutes(SHELL_APP, '');
  for (const route of appRoutes) expand(route);
  // A path generated as a page in one mode and a redirect in another is a page.
  const live = redirects.filter((redirect) => !leaves.has(redirect.source));
  return { leaves: [...leaves.values()], redirects: live, exempted, appRoutes };
}

interface Placement {
  readonly page: NavPageDef;
  readonly where: string;
}

const PLACEMENTS: readonly Placement[] = CONSOLE_WORKSPACES.flatMap((workspace) =>
  workspace.areas.flatMap((area) =>
    area.groups.flatMap((group) =>
      group.pages.map((page) => ({ page, where: `${workspace.id} › ${area.id} › ${page.id}` })),
    ),
  ),
);
const PAGES: readonly NavPageDef[] = [...new Set(PLACEMENTS.map(({ page }) => page))];

/** Every URL an entry answers to as itself: its path, its default tab spelled out, its tabs. */
function destinations(page: NavPageDef): string[] {
  const defaultTab = page.defaultTab === undefined ? [] : [`${page.path}?tab=${page.defaultTab}`];
  return [page.path, ...defaultTab, ...(page.tabs ?? []).map((tab) => tab.path)];
}

/** The nav entries that reach `leaf`: as a destination, or (no tab) through a pattern. */
function coveringPages(leaf: Leaf): NavPageDef[] {
  return PAGES.filter((page) => {
    const exact = destinations(page).some((path) => {
      const { pathname, tab } = parseNavLocation(path);
      return pathname === leaf.pattern && tab === leaf.tab;
    });
    const pattern =
      leaf.tab === null &&
      (page.matchPaths ?? []).some((match) => patternMatches(match, leaf.pattern));
    return exact || pattern;
  });
}

function webFiles(dir: string): string[] {
  const absolute = resolve(REPO_ROOT, dir);
  return readdirSync(absolute).flatMap((name) => {
    const full = join(absolute, name);
    if (statSync(full).isDirectory()) {
      if (/^(node_modules|dist|__tests__|__mocks__|test-utils|test|tests)$/.test(name)) return [];
      return webFiles(relative(REPO_ROOT, full));
    }
    return /\.tsx?$/.test(name) && !/\.(spec|test|stories)\.tsx?$/.test(name)
      ? [relative(REPO_ROOT, full)]
      : [];
  });
}

const TABLE = buildRouteTable();

describe('web console nav coverage (FE-HIGH-335)', () => {
  it('reads the route tree (sanity: known leaves of every kind are found)', () => {
    const keys = new Set(TABLE.leaves.map((leaf) => leafKey(leaf.pattern, leaf.tab)));
    for (const key of [
      '/dashboard/analytics',
      '/messaging/new-ai',
      '/tenant',
      '/sites/setup/structure',
      '/sites/reports/escape',
      '/sites/batch/:batchId/traceability',
      '/sites/feeding?tab=sampling',
      '/sites/tanks?tab=cleanerFish',
      '/hydroponics/solution/readjustment',
      '/sensor/devices/edge/:deviceId/config',
      '/hr/training/certifications',
      '/settings/privacy',
    ]) {
      expect(keys.has(key) ? '' : `route table misses ${key}`).toBe('');
    }
    expect(TABLE.leaves.length).toBeGreaterThan(180);
    expect(TABLE.redirects.length).toBeGreaterThan(25);
    expect([...TABLE.exempted].sort()).toEqual(Object.keys(EXEMPT).sort());
  });

  it('reaches every leaf route from a nav entry, tab or matchPaths pattern', () => {
    const unreached = TABLE.leaves
      .filter((leaf) => coveringPages(leaf).length === 0)
      .map((leaf) => `${leafKey(leaf.pattern, leaf.tab)} (${leaf.file})`);
    expect(unreached).toEqual([]);
  });

  it('points every entry, tab and pattern at a leaf route — never a redirect or nothing', () => {
    const keys = new Set(TABLE.leaves.map((leaf) => leafKey(leaf.pattern, leaf.tab)));
    const dead: string[] = [];
    for (const { page, where } of PLACEMENTS) {
      for (const path of destinations(page)) {
        const { pathname, tab } = parseNavLocation(path);
        if (!keys.has(leafKey(pathname, tab))) dead.push(`${where}: ${path}`);
      }
      for (const match of page.matchPaths ?? []) {
        const hits = TABLE.leaves.some(
          (leaf) => leaf.tab === null && patternMatches(match, leaf.pattern),
        );
        if (!hits) dead.push(`${where}: matchPaths ${match}`);
      }
    }
    expect([...new Set(dead)]).toEqual([]);
  });

  it('lists each routed "coming soon" page as planned, and only those', () => {
    const wrong: string[] = [];
    for (const leaf of TABLE.leaves) {
      const placeholder = /<PlaceholderPage\b/.test(leaf.element);
      for (const page of coveringPages(leaf)) {
        if (parseNavLocation(page.path).pathname !== leaf.pattern) continue;
        if (placeholder !== (page.status === 'planned')) {
          wrong.push(
            `${page.id} → ${leaf.pattern}: placeholder=${placeholder} status=${page.status ?? '-'}`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(PAGES.filter((page) => page.status === 'planned').length).toBe(
      TABLE.leaves.filter((leaf) => /<PlaceholderPage\b/.test(leaf.element)).length,
    );
  });

  it("derives module gates from App.tsx's requiredModule mounts", () => {
    const fromApp: Record<string, string> = {};
    for (const route of TABLE.appRoutes) {
      const module = /requiredModule="([^"]+)"/.exec(route.element)?.[1];
      if (module !== undefined) fromApp[route.pattern.replace(/\/\*$/, '')] = module;
    }
    expect(fromApp).toEqual(MODULE_MOUNTS);
  });

  it('gates each tenant page as its route does (RequireTenantCapability)', () => {
    const mismatched: string[] = [];
    for (const leaf of TABLE.leaves.filter((candidate) =>
      candidate.file.includes('/tenant-admin/'),
    )) {
      const capability = /\bcapability="([^"]+)"/.exec(leaf.element)?.[1];
      const adminOnly = /\badminOnly\b/.test(leaf.element);
      expect(
        capability !== undefined || adminOnly ? '' : `${leaf.pattern}: route has no gate`,
      ).toBe('');
      for (const page of coveringPages(leaf)) {
        const ok =
          capability !== undefined
            ? page.requiredPermission === capability && page.requiredRoles === undefined
            : page.requiredPermission === undefined &&
              JSON.stringify(page.requiredRoles) === JSON.stringify(['TENANT_ADMIN']);
        if (!ok) mismatched.push(`${page.id} → ${leaf.pattern} (${capability ?? 'adminOnly'})`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('lands every static redirect on a leaf route (or an exempt one)', () => {
    const keys = new Set(TABLE.leaves.map((leaf) => leafKey(leaf.pattern, leaf.tab)));
    const sources = new Set(TABLE.redirects.map((redirect) => redirect.source));
    const lost = TABLE.redirects
      .filter((redirect) => {
        const { pathname, tab } = parseNavLocation(redirect.target);
        return (
          !keys.has(leafKey(pathname, tab)) &&
          !sources.has(pathname) &&
          EXEMPT[pathname] === undefined
        );
      })
      .map((redirect) => `${redirect.source} → ${redirect.target} (${redirect.file})`);
    expect(lost).toEqual([]);
  });

  it('scans every web file that hosts a <Routes> or reads ?tab=', () => {
    const scanned = new Set([
      SHELL_APP,
      ...Object.values(NESTED_ROUTE_FILES),
      ...Object.keys(UNSCANNED_ROUTES_FILES),
    ]);
    const tabReaders = new Set([
      ...Object.values(QUERY_TAB_SOURCES).map((source) => source.file),
      ...Object.keys(TAB_READERS_UNDER_PARAM_ROUTES),
      ...Object.keys(NON_PAGE_TAB_READERS),
    ]);
    const missed: string[] = [];
    for (const file of [...webFiles('web/shell/src'), ...webFiles('web/modules')]) {
      const text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      if (/<Routes\b/.test(text) && !scanned.has(file)) missed.push(`${file}: hosts <Routes>`);
      if (/\.get\(\s*['"]tab['"]\s*\)/.test(text) && !tabReaders.has(file))
        missed.push(`${file}: reads ?tab=`);
    }
    expect(missed).toEqual([]);
    for (const [file, route] of Object.entries(TAB_READERS_UNDER_PARAM_ROUTES)) {
      expect(
        TABLE.leaves.some((leaf) => leaf.pattern === route && coveringPages(leaf).length > 0)
          ? ''
          : `${file}: ${route} not covered`,
      ).toBe('');
    }
  });
});
