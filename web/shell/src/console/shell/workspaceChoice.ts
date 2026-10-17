/**
 * workspaceChoice — the console's workspace, kept apart for a role preview
 * (FE-HIGH-334, design README §8 "view as").
 *
 * WHAT: the admin's own workspace (`own`, the one stored per tenant) and the
 * one a role preview moved to (`preview`), with the previewed role. A choice
 * made while previewing — the module menu, the palette, the rail following
 * the preview's narrower nav — lands in `preview`; ending the preview drops
 * it, so the admin is back on their own workspace.
 *
 * WHY a reducer: whether a choice is the admin's or the preview's is decided
 * from the state the choice lands on, not from a callback's closure, so two
 * updates in one tick (start a preview, then follow its home) cannot store
 * the preview's workspace as the admin's. Only `own` is ever persisted.
 */
import type { ConsoleWorkspaceId } from '@aquaculture/shared-ui';

import type { ViewAsRole } from '../data';

export interface WorkspaceChoice {
  readonly own: ConsoleWorkspaceId | null;
  readonly preview: ConsoleWorkspaceId | null;
  readonly viewAsRole: ViewAsRole | null;
}

export type WorkspaceChoiceAction =
  | { readonly type: 'select'; readonly ws: ConsoleWorkspaceId }
  | { readonly type: 'viewAs'; readonly role: ViewAsRole | null };

export function reduceWorkspaceChoice(
  state: WorkspaceChoice,
  action: WorkspaceChoiceAction,
): WorkspaceChoice {
  if (action.type === 'select') {
    return state.viewAsRole === null
      ? { ...state, own: action.ws }
      : { ...state, preview: action.ws };
  }
  // Ending a preview drops its workspace; switching roles keeps where the rail is.
  return {
    ...state,
    viewAsRole: action.role,
    preview: action.role === null ? null : state.preview,
  };
}

/** The workspace on screen: the preview's while one is open (from the admin's own until it moves). */
export function shownWorkspace(state: WorkspaceChoice): ConsoleWorkspaceId | null {
  return state.viewAsRole === null ? state.own : (state.preview ?? state.own);
}
