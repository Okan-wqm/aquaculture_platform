/**
 * The console preferences kept per tenant in browser storage (design digest
 * §10.1/§11): the workspace last used and the rail's collapse choice.
 *
 * WHY parsed: storage is outside the type system — a value written by an
 * older build, by hand or by another tab may be anything, so a read is
 * trusted only when it is one of the values the console writes. Anything
 * else counts as no preference.
 */
import { CONSOLE_WORKSPACE_IDS, type ConsoleWorkspaceId } from '@aquaculture/shared-ui';

/** Tenant-scoped storage keys (useTenantScopedStorage namespaces them per tenant). */
export const CONSOLE_WS_STORAGE_KEY = 'suderra.console.ws';
export const CONSOLE_NAV_COLLAPSED_STORAGE_KEY = 'suderra.console.navCollapsed';

export function parseStoredWorkspace(value: unknown): ConsoleWorkspaceId | null {
  return CONSOLE_WORKSPACE_IDS.find((id) => id === value) ?? null;
}

/** The reader's rail choice; null leaves it to the window (collapsed below 1100 px). */
export function parseStoredCollapsed(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
