/**
 * useRailCollapsed — whether the console rail draws its 110 px icon column or
 * its 296 px labelled accordion (design handoff §8, digest §10.2).
 *
 * WHAT: the user's preference when they made one; with none (`null`), the
 * window decides — collapsed below 1100 px, where the 296 px rail would leave
 * the page too little room.
 *
 * WHY the window is read only while there is no preference: an explicit
 * choice never changes with the window, so no listener is kept for it
 * (PERF-006: no document-level listener a closed state does not need).
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';

/** Below this width an undecided rail collapses (README §7.1). */
export const RAIL_AUTO_COLLAPSE_QUERY = '(max-width: 1099px)';

function noSubscription(): void {
  // nothing was subscribed
}

export function useRailCollapsed(preference: boolean | null): boolean {
  const list = useMemo(
    () => (preference === null ? window.matchMedia(RAIL_AUTO_COLLAPSE_QUERY) : null),
    [preference],
  );

  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      if (list === null) return noSubscription;
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [list],
  );
  const narrow = useSyncExternalStore(
    subscribe,
    () => list !== null && list.matches,
    () => false,
  );

  return preference ?? narrow;
}
