/**
 * Which workspace and which entry a location belongs to (FE-HIGH-335), so the
 * rail follows navigation: a deep link, the palette or an in-page link to a
 * page of another workspace moves the rail there, while a page several
 * workspaces share keeps the current one (design §10.3, README §5).
 */
import {
  MATCH_NONE,
  pageMatchScore,
  parseNavLocation,
  type MatchablePage,
  type NavLocation,
} from './match';
import type { WorkspaceId } from './types';

/** The shape both definitions and built workspaces share — what matching reads. */
export interface MatchableWorkspace {
  readonly id: WorkspaceId;
  readonly areas: readonly {
    readonly id: string;
    readonly groups: readonly { readonly pages: readonly MatchablePage[] }[];
  }[];
}

function workspaceScore(workspace: MatchableWorkspace, location: NavLocation): number {
  let best = MATCH_NONE;
  for (const area of workspace.areas) {
    for (const group of area.groups) {
      for (const page of group.pages) best = Math.max(best, pageMatchScore(page, location));
    }
  }
  return best;
}

/**
 * The workspace owning `path` (pathname plus search): the one whose entry
 * claims it most strongly (match.ts), `preferred` winning a tie, else the
 * first in order. A path no entry claims keeps `preferred` when it is listed,
 * else the first workspace; undefined only for an empty list.
 */
export function workspaceForPath(
  path: string,
  workspaces: readonly MatchableWorkspace[],
  preferred?: WorkspaceId,
): WorkspaceId | undefined {
  const location = parseNavLocation(path);
  let best = MATCH_NONE;
  let owner: WorkspaceId | undefined;
  let preferredScore = MATCH_NONE;
  for (const workspace of workspaces) {
    const score = workspaceScore(workspace, location);
    if (workspace.id === preferred) preferredScore = score;
    if (score > best) {
      best = score;
      owner = workspace.id;
    }
  }
  if (best === MATCH_NONE) {
    return workspaces.some((workspace) => workspace.id === preferred)
      ? preferred
      : workspaces[0]?.id;
  }
  return preferred !== undefined && preferredScore === best ? preferred : owner;
}

/** The entry a location lights and the area holding it. */
export interface ActiveEntry<Page> {
  readonly areaId: string;
  readonly page: Page;
}

/** The entry of `workspace` that `path` lights: the strongest match, the first on a tie. */
export function findActivePage<Page extends MatchablePage>(
  path: string,
  workspace: {
    readonly areas: readonly {
      readonly id: string;
      readonly groups: readonly { readonly pages: readonly Page[] }[];
    }[];
  },
): ActiveEntry<Page> | undefined {
  const location = parseNavLocation(path);
  let best = MATCH_NONE;
  let found: ActiveEntry<Page> | undefined;
  for (const area of workspace.areas) {
    for (const group of area.groups) {
      for (const page of group.pages) {
        const score = pageMatchScore(page, location);
        if (score > best) {
          best = score;
          found = { areaId: area.id, page };
        }
      }
    }
  }
  return found;
}
