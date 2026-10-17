/**
 * Matching a location to console nav entries (FE-HIGH-335).
 *
 * One scoring rule serves the rail's active row, the workspace that owns a
 * location (workspaceForPath) and the coverage invariant, so "which entry is
 * this URL" has a single answer:
 *
 *   3 — exact: the entry's own `?tab=` destination, its `defaultTab` spelled
 *       out (`/sites/finance?tab=overview`), or one of its tabs;
 *   2 — base: the entry's pathname when the entry names no tab (so a tab no
 *       other entry claims still lights its page);
 *   1 — pattern: one of the entry's `matchPaths` (detail, create, alias);
 *   0 — no match.
 */
import type { NavPageDef } from './types';

export const MATCH_EXACT = 3;
export const MATCH_BASE = 2;
export const MATCH_PATTERN = 1;
export const MATCH_NONE = 0;

/** A location reduced to what the nav distinguishes: the pathname and the `tab` query. */
export interface NavLocation {
  readonly pathname: string;
  readonly tab: string | null;
}

function normalizePathname(pathname: string): string {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return trimmed === '' ? '/' : trimmed;
}

/** `/sites/finance?tab=budget#x` → `{ pathname: '/sites/finance', tab: 'budget' }`. */
export function parseNavLocation(path: string): NavLocation {
  const withoutHash = path.split('#')[0] ?? '';
  const queryAt = withoutHash.indexOf('?');
  if (queryAt < 0) return { pathname: normalizePathname(withoutHash), tab: null };
  return {
    pathname: normalizePathname(withoutHash.slice(0, queryAt)),
    tab: new URLSearchParams(withoutHash.slice(queryAt + 1)).get('tab'),
  };
}

function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment !== '');
}

/**
 * True when a route `pattern` matches `pathname`. `:name` matches any one
 * segment, a final `*` the rest (zero or more). `pathname` may itself be a
 * route pattern: `:id` in it is then matched only by a pattern parameter or `*`.
 */
export function patternMatches(pattern: string, pathname: string): boolean {
  const want = segmentsOf(pattern);
  const have = segmentsOf(normalizePathname(pathname));
  for (let index = 0; index < want.length; index += 1) {
    const segment = want[index];
    if (segment === '*' && index === want.length - 1) return true;
    const actual = have[index];
    if (segment === undefined || actual === undefined) return false;
    if (!segment.startsWith(':') && segment !== actual) return false;
  }
  return want.length === have.length;
}

/** The fields of an entry that decide whether it matches; definitions and built pages both have them. */
export type MatchablePage = Pick<NavPageDef, 'path' | 'matchPaths' | 'defaultTab'> & {
  readonly tabs?: readonly { readonly path: string }[];
};

/** How strongly `page` claims `location` (see the scale above). */
export function pageMatchScore(page: MatchablePage, location: NavLocation): number {
  const own = parseNavLocation(page.path);
  if (own.pathname === location.pathname && location.tab !== null) {
    // The entry's own tab, or (untabbed entry) the default tab its bare path renders.
    if ((own.tab ?? page.defaultTab) === location.tab) return MATCH_EXACT;
  }
  for (const tab of page.tabs ?? []) {
    const target = parseNavLocation(tab.path);
    if (
      target.pathname === location.pathname &&
      (target.tab === null || target.tab === location.tab)
    ) {
      return MATCH_EXACT;
    }
  }
  if (own.pathname === location.pathname && own.tab === null) return MATCH_BASE;
  if (page.matchPaths?.some((pattern) => patternMatches(pattern, location.pathname))) {
    return MATCH_PATTERN;
  }
  return MATCH_NONE;
}
