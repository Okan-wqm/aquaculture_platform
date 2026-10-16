/**
 * The entry the current location lights (FE-HIGH-334, design digest §10.6).
 *
 * WHY one resolver: the rail's active row, the header's eyebrow and h1, the
 * title block's sheet code and how a page's own PageHeader title renders all
 * describe the same entry, so they read one answer. The match is the nav
 * model's (findActivePage → match.ts scoring), never a second rule.
 *
 * WHAT: the area and page the location belongs to in the shown workspace, the
 * level-3 tab the location opens (if any), the rail's `RailActive`, and
 * the page title mode: the console's h1 is the entry's label, so a PageHeader
 * on the entry's own destination repeats it (`hidden`), while one on a detail
 * or alias route (a `matchPaths` match) names the record under it (`subtitle`).
 */
import type { PageTitleMode, RailActive } from '@aquaculture/shared-ui';

import {
  MATCH_BASE,
  findActivePage,
  pageMatchScore,
  parseNavLocation,
  type Area,
  type NavLocation,
  type NavPage,
  type NavTab,
  type Workspace,
} from '../nav';

export interface ConsoleActiveEntry {
  readonly area: Area;
  readonly page: NavPage;
  /** The level-3 tab the location opens; absent on a page without one. */
  readonly tab?: NavTab;
  readonly rail: RailActive;
  /** How the page's own PageHeader title renders under the console's h1 (never a second h1). */
  readonly titleMode: Exclude<PageTitleMode, 'heading'>;
}

function sameDestination(a: NavLocation, b: NavLocation): boolean {
  return a.pathname === b.pathname && a.tab === b.tab;
}

export function resolveActiveEntry(
  path: string,
  workspace: Workspace | undefined,
): ConsoleActiveEntry | undefined {
  if (workspace === undefined) return undefined;
  const found = findActivePage(path, workspace);
  if (found === undefined) return undefined;
  const area = workspace.areas.find((candidate) => candidate.id === found.areaId);
  if (area === undefined) return undefined;

  const location = parseNavLocation(path);
  const tab = found.page.tabs?.find((candidate) =>
    sameDestination(parseNavLocation(candidate.path), location),
  );
  return {
    area,
    page: found.page,
    ...(tab === undefined ? {} : { tab }),
    rail: {
      areaId: area.id,
      pageId: found.page.id,
      ...(tab === undefined ? {} : { tabId: tab.id }),
    },
    titleMode: pageMatchScore(found.page, location) >= MATCH_BASE ? 'hidden' : 'subtitle',
  };
}
