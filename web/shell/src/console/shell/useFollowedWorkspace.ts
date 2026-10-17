/**
 * useFollowedWorkspace — the workspace the rail shows, following navigation
 * (FE-HIGH-334, design README §5, digest §10.3).
 *
 * WHAT: the workspace owning the location (workspaceForPath: a page another
 * workspace lists moves the rail there — a deep link, the palette, an in-page
 * link — while a page the current workspace shares keeps it), derived on
 * every render so the rail never shows a stale workspace for a frame. The
 * choice is stored per tenant once followed, and `data-ws` on <html> switches
 * the accent ramp and the ground tint (theme.css `[data-ws]`) and the motif
 * behind the column (suderra.css, FE-MEDIUM-348) from the first frame painted
 * and for as long as the console is mounted; unmounting it (sign-out, the
 * SUPER_ADMIN console) removes it.
 *
 * A role preview's narrower nav may move the rail too: the context keeps that
 * workspace apart from the admin's own and stores only the latter
 * (ConsoleShellContext, workspaceChoice.ts), so following needs no preview
 * case — the admin's own last workspace is what their next visit opens.
 */
import type { ConsoleWorkspaceId } from '@aquaculture/shared-ui';
import { useEffect, useLayoutEffect } from 'react';

import { useConsoleShell } from '../ConsoleShellContext';
import { workspaceForPath, type MatchableWorkspace } from '../nav';

export function useFollowedWorkspace(
  path: string,
  workspaces: readonly MatchableWorkspace[],
): ConsoleWorkspaceId | undefined {
  const { ws, setWs } = useConsoleShell();
  const followed = workspaceForPath(path, workspaces, ws ?? undefined);

  useEffect(() => {
    if (followed !== undefined && followed !== ws) setWs(followed);
  }, [followed, ws, setWs]);

  // A layout effect: `data-ws` picks the accent, the ground and the motif, so it
  // lands before the browser paints the frame the route change produced — a
  // passive effect ran after it and showed one frame of the previous ground.
  useLayoutEffect(() => {
    if (followed === undefined) return undefined;
    const root = document.documentElement;
    root.dataset.ws = followed;
    return () => {
      delete root.dataset.ws;
    };
  }, [followed]);

  return followed;
}
