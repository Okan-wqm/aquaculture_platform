/**
 * A page of a built nav by id (FE-HIGH-334): the console reads what the viewer
 * may open from the nav itself — the alarm list behind the annunciator, the
 * users and devices pages behind the palette's people and devices — so a link
 * the shell builds outside the rail is offered exactly when the rail offers
 * its page, at the path the rail uses.
 */
import type { NavPage, Workspace } from './types';

/** The first page with this id, in workspace → area → group order; undefined when no workspace lists it. */
export function findNavPage(workspaces: readonly Workspace[], pageId: string): NavPage | undefined {
  for (const workspace of workspaces) {
    for (const area of workspace.areas) {
      for (const group of area.groups) {
        const page = group.pages.find((candidate) => candidate.id === pageId);
        if (page !== undefined) return page;
      }
    }
  }
  return undefined;
}
