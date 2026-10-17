/**
 * useAreaDisclosure — which accordion areas of the rail are open (digest §10.2).
 *
 * WHAT: an area is open when it holds the current page and the reader has not
 * closed it, or when the reader opened it. Several areas may be open at once.
 * Moving to a page in another area opens that one; the area left behind closes
 * again unless the reader opened it explicitly.
 *
 * WHY the choices are kept per workspace and dropped on a switch: the areas of
 * one workspace mean nothing in another (Production's "Operations" is not
 * Greenhouse's), so a switch starts from the location alone (design §10.3).
 */
import { useCallback, useState } from 'react';

interface DisclosureState {
  readonly workspaceId: string | undefined;
  /** Areas the reader opened. */
  readonly opened: readonly string[];
  /** Areas the reader closed although they hold the current page. */
  readonly closed: readonly string[];
}

export interface AreaDisclosure {
  readonly isOpen: (areaId: string) => boolean;
  readonly toggle: (areaId: string) => void;
  /** Open an area (a collapsed tile asks for its area when it expands the rail). */
  readonly open: (areaId: string) => void;
}

function fresh(workspaceId: string | undefined): DisclosureState {
  return { workspaceId, opened: [], closed: [] };
}

function openIn(state: DisclosureState, areaId: string, activeAreaId: string | undefined): boolean {
  return (
    state.opened.includes(areaId) || (areaId === activeAreaId && !state.closed.includes(areaId))
  );
}

function withOpen(state: DisclosureState, areaId: string, open: boolean): DisclosureState {
  const opened = state.opened.filter((id) => id !== areaId);
  const closed = state.closed.filter((id) => id !== areaId);
  return open
    ? { ...state, opened: [...opened, areaId], closed }
    : { ...state, opened, closed: [...closed, areaId] };
}

export function useAreaDisclosure(
  workspaceId: string | undefined,
  activeAreaId: string | undefined,
): AreaDisclosure {
  const [state, setState] = useState<DisclosureState>(() => fresh(workspaceId));

  // A workspace switch resets during render (React's "adjust state when a
  // prop changes"), so the first paint of the new workspace already shows
  // only the area the location opens.
  if (state.workspaceId !== workspaceId) setState(fresh(workspaceId));
  const current = state.workspaceId === workspaceId ? state : fresh(workspaceId);

  const isOpen = useCallback(
    (areaId: string) => openIn(current, areaId, activeAreaId),
    [current, activeAreaId],
  );
  const toggle = useCallback(
    (areaId: string) =>
      setState((prev) => withOpen(prev, areaId, !openIn(prev, areaId, activeAreaId))),
    [activeAreaId],
  );
  const open = useCallback(
    (areaId: string) => setState((prev) => withOpen(prev, areaId, true)),
    [],
  );

  return { isOpen, toggle, open };
}
