/**
 * Sheet code — the title block's "pafta" code for the page on screen (design
 * README §7.4, decision D13).
 *
 * WHY derived and not stored: no console page has a drawing-sheet record, but
 * every page already has a stable id in the console nav (the rail, the
 * coverage invariant and this code read the same ids), so the code is a pure
 * function of where the user is and needs no data source.
 *
 * WHAT: `<scope>-<page>` uppercase. The scope is the area id's first segment,
 * at most three letters — the console's area ids lead with their workspace
 * (`aq-operations`, `ctl-control`, `org-account`). The page part is the page
 * id's first segment, at most five letters, then the initial of each further
 * segment: `environment` → `ENVIR` (the README's `AQ-ENVIR`), `feed-records`
 * → `FEED-R` (the prototype's `AQ-FEED-R`). Any non-alphanumeric run
 * separates segments.
 */

/** The nav ids of the page on screen: its area's id and its own. */
export interface SheetCodeSource {
  readonly areaId: string;
  readonly pageId: string;
}

const SCOPE_LETTERS = 3;
const PAGE_HEAD_LETTERS = 5;

function segmentsOf(id: string): string[] {
  return id
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment !== '');
}

/** The page's sheet code, or null when an id has no letters to read (the cell is then not drawn). */
export function deriveSheetCode({ areaId, pageId }: SheetCodeSource): string | null {
  const [scope] = segmentsOf(areaId);
  const [head, ...rest] = segmentsOf(pageId);
  if (scope === undefined || head === undefined) return null;
  const page = [head.slice(0, PAGE_HEAD_LETTERS), ...rest.map((segment) => segment.charAt(0))];
  return [scope.slice(0, SCOPE_LETTERS), ...page].join('-').toUpperCase();
}
