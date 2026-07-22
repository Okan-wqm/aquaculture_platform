/**
 * APA-255 / APA-256 — admin route ↔ nav-manifest reachability.
 *
 * The SUPER_ADMIN sidebar is DERIVED from the ADMIN_ROUTES manifest
 * (web/shared-ui/src/authz/admin-routes.ts); the mounted route table lives in
 * admin-panel Module.tsx. Before the manifest, the two drifted silently and 10
 * mounted pages (the whole messaging section, settings/provisioning, billing
 * plans/usage) had no sidebar entry — reachable only by typing URLs.
 *
 * This gate enforces bidirectional parity by static text analysis (no imports,
 * mirroring the other web invariants):
 *   1. every non-redirect route mounted in Module.tsx has a manifest entry;
 *   2. every manifest entry maps to a mounted route (no phantom nav item);
 *   3. every non-visible manifest route declares HOW it is reachable.
 * A route added without a manifest entry (the APA-255 regression) fails (1).
 * The manifest → live-sidebar derivation itself is pinned by the shared-ui unit
 * test web/shared-ui/src/authz/__tests__/admin-routes.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf-8');

const MODULE_TSX = 'web/modules/admin-panel/src/Module.tsx';
const ADMIN_ROUTES_TS = 'web/shared-ui/src/authz/admin-routes.ts';
const BILLING_ROUTES_TS = 'web/shared-ui/src/authz/admin-billing-routes.ts';

/** Mounted `<Route>` remotePaths, excluding `<Navigate>` redirects and the `*` fallback. */
function mountedRoutes(): string[] {
  const src = read(MODULE_TSX);
  const routes: string[] = [];
  const re = /<Route\b([^>]*?)element=\{<(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const attrs = m[1] ?? '';
    const component = m[2] ?? '';
    if (component === 'Navigate') continue; // pure redirect alias
    if (/\bindex\b/.test(attrs)) {
      routes.push('');
      continue;
    }
    const pathMatch = /path="([^"]*)"/.exec(attrs);
    if (pathMatch === null) continue;
    const path = pathMatch[1] ?? '';
    if (path === '*') continue;
    routes.push(path);
  }
  return routes;
}

interface ManifestEntry {
  readonly remotePath: string;
  readonly visible: boolean;
  readonly reachableVia: string | null;
}

/** Native ADMIN_ROUTES entries (single-line objects); the `...BILLING_ROUTES` spread is skipped. */
function nativeManifest(): ManifestEntry[] {
  const src = read(ADMIN_ROUTES_TS);
  const start = src.indexOf('export const ADMIN_ROUTES');
  const region = start >= 0 ? src.slice(start) : src;
  const out: ManifestEntry[] = [];
  for (const line of region.split('\n')) {
    const rp = /remotePath:\s*'([^']*)'/.exec(line);
    const vis = /visible:\s*(true|false)/.exec(line);
    if (rp === null || vis === null) continue;
    const reach = /reachableVia:\s*'([^']*)'/.exec(line);
    out.push({
      remotePath: rp[1] ?? '',
      visible: vis[1] === 'true',
      reachableVia: reach !== null ? (reach[1] ?? '') : null,
    });
  }
  return out;
}

/** Billing remotePaths composed into ADMIN_ROUTES from the billing SSoT. */
function billingRemotePaths(): string[] {
  const src = read(BILLING_ROUTES_TS);
  const start = src.indexOf('export const ADMIN_BILLING_ROUTES');
  const end = src.indexOf('] as const;', start);
  const region = start >= 0 && end >= 0 ? src.slice(start, end) : src;
  const out: string[] = [];
  const re = /remotePath:\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) out.push(m[1] ?? '');
  return out;
}

describe('admin route ↔ nav manifest reachability (APA-255/256)', () => {
  const mounted = mountedRoutes();
  const native = nativeManifest();
  const manifestRemotePaths = [...native.map((e) => e.remotePath), ...billingRemotePaths()];
  const manifestSet = new Set(manifestRemotePaths);
  const mountedSet = new Set(mounted);

  it('every mounted admin route has a nav-manifest entry (no unreachable page)', () => {
    const orphanRoutes = mounted.filter((p) => !manifestSet.has(p));
    expect(orphanRoutes).toEqual([]);
  });

  it('every nav-manifest entry maps to a mounted route (no phantom nav item)', () => {
    const phantom = manifestRemotePaths.filter((p) => !mountedSet.has(p));
    expect(phantom).toEqual([]);
  });

  it('every non-visible manifest route declares how it is reachable', () => {
    const undeclared = native
      .filter((e) => !e.visible && (e.reachableVia === null || e.reachableVia.trim() === ''))
      .map((e) => e.remotePath);
    expect(undeclared).toEqual([]);
  });

  it('sanity: the parser found the expected route surface', () => {
    // Guards against a silent parser break that would make the gate vacuous.
    expect(mounted.length).toBeGreaterThan(40);
    expect(manifestRemotePaths.length).toBeGreaterThan(40);
  });
});
