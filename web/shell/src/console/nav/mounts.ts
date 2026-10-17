/**
 * Which tenant module serves a console path (FE-HIGH-335).
 *
 * The shell mounts most module remotes under one prefix behind
 * `ProtectedRoute requiredModule` (web/shell/src/App.tsx), so every page
 * under the prefix needs the module: a /sites page needs farm wherever it is
 * listed — which is what keeps a shared page (tasks, maintenance, storage,
 * finance) from showing as a dead link in a workspace whose tenant lacks the
 * module that serves it. The dashboard remote is mounted once for three
 * workspaces, so its pages gate one by one (RequireRole requiredModule in
 * web/modules/dashboard/src/Module.tsx): Production needs farm, Control &
 * sensors sensor, Greenhouse hydroponics, and trends none.
 *
 * WHAT: the gates keyed by the route pattern that declares them — a `/*`
 * pattern gates its whole subtree, any other only its own path. The
 * coverage invariant pins this table to the routes' gates.
 */
import type { ModuleCode } from './types';

export const MODULE_MOUNTS = {
  '/sites/*': 'farm',
  '/hydroponics/*': 'hydroponics',
  '/sensor/*': 'sensor',
  '/hr/*': 'hr',
  '/dashboard': 'farm',
  '/dashboard/control': 'sensor',
  '/dashboard/greenhouse': 'hydroponics',
} as const satisfies Readonly<Record<string, ModuleCode>>;

const SUBTREE = '/*';

function gates(pattern: string, pathname: string): boolean {
  if (!pattern.endsWith(SUBTREE)) return pathname === pattern;
  const base = pattern.slice(0, -SUBTREE.length);
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** The module that serves `path` (`?tab=` ignored), or undefined for an ungated page. */
export function moduleForPath(path: string): ModuleCode | undefined {
  const pathname = path.split('?')[0] ?? path;
  let gate: { readonly pattern: string; readonly module: ModuleCode } | undefined;
  for (const [pattern, module] of Object.entries(MODULE_MOUNTS)) {
    // The most specific gate wins, should a page gate sit below a subtree gate.
    if (gates(pattern, pathname) && (gate === undefined || pattern.length > gate.pattern.length)) {
      gate = { pattern, module };
    }
  }
  return gate === undefined ? undefined : gate.module;
}
