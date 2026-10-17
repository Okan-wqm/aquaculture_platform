/**
 * Which tenant module serves a console path (FE-HIGH-335).
 *
 * The shell mounts each module remote under one prefix behind
 * `ProtectedRoute requiredModule` (web/shell/src/App.tsx). A page's module gate
 * is therefore a property of its path, not something each entry restates:
 * a /sites page needs farm wherever it is listed — which is what keeps a
 * shared page (tasks, maintenance, storage, finance) from showing as a dead
 * link in a workspace whose tenant lacks the module that serves it.
 *
 * The coverage invariant pins this table to App.tsx's guards.
 */
import type { ModuleCode } from './types';

export const MODULE_MOUNTS = {
  '/sites': 'farm',
  '/hydroponics': 'hydroponics',
  '/sensor': 'sensor',
  '/hr': 'hr',
} as const satisfies Readonly<Record<string, ModuleCode>>;

type ModuleMount = keyof typeof MODULE_MOUNTS;

function isModuleMount(prefix: string): prefix is ModuleMount {
  return Object.prototype.hasOwnProperty.call(MODULE_MOUNTS, prefix);
}

/** The module whose remote serves `path` (`?tab=` ignored), or undefined for shell, dashboard, messaging and tenant pages. */
export function moduleForPath(path: string): ModuleCode | undefined {
  const mount = /^\/[^/?]+/.exec(path)?.[0];
  return mount !== undefined && isModuleMount(mount) ? MODULE_MOUNTS[mount] : undefined;
}
