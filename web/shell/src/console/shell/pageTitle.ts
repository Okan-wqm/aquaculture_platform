/**
 * The console page's name — the document title and what a navigation
 * announces (RouteAnnouncer, WCAG 2.4.2 / 4.1.3).
 *
 * WHY from the active entry: it is the name the console already shows — the
 * header's h1 is the entry's page, the rail lights its tab — localized by the
 * nav model, so the title and the announcement speak the reader's language
 * and change with a tab (`?tab=`) as well as with a page.
 *
 * WHAT: most specific first — the tab the location opens, the page, the
 * workspace — joined by " · ". A location outside the nav is named by its
 * workspace alone; with no workspace on screen, nothing.
 */
import type { Workspace } from '../nav';

import type { ConsoleActiveEntry } from './activeEntry';

export const PAGE_TITLE_SEPARATOR = ' · ';

export function consolePageTitle(
  entry: ConsoleActiveEntry | undefined,
  workspace: Workspace | undefined,
): string {
  if (workspace === undefined) return '';
  if (entry === undefined) return workspace.label;
  const parts =
    entry.tab === undefined
      ? [entry.page.label, workspace.label]
      : [entry.tab.label, entry.page.label, workspace.label];
  return parts.join(PAGE_TITLE_SEPARATOR);
}
