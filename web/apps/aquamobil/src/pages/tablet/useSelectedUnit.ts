/**
 * useSelectedUnit — the board's selection seam, shared by two panes.
 *
 * The design's rule is that picking a unit in the middle column FILLS THE RIGHT
 * PANE and does not navigate away. That makes selection a piece of state two
 * sibling panes need: the grid writes it, the detail pane reads it. Rather than
 * lifting it into BoardPage and drilling props through both panes — which would
 * mean every pane author edits the grid — it lives in the URL as `?unit=<id>`
 * and both sides reach it through this hook.
 *
 * WHY THE URL and not useState:
 *   • it is the same route, so nothing navigates away — only the query string
 *     changes, and the board stays mounted;
 *   • a reload, a service-worker update or a shared link brings the same unit
 *     back on screen, which matters on a display that is left running;
 *   • the two panes have no shared parent to own the state without one of them
 *     owning the other.
 *
 * `replace: true` keeps selections out of the history stack — the back button on
 * a cabin board should leave the board, not walk backwards through the twenty
 * units somebody looked at this morning.
 */
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/** The query-string key. Exported so a test or a deep link can build the URL. */
export const SELECTED_UNIT_PARAM = 'unit';

export interface BoardSelection {
  /** The unit id currently filling the detail pane, or null when none is. */
  selectedUnitId: string | null;
  /** Select a unit, or pass null to clear the detail pane. */
  selectUnit: (unitId: string | null) => void;
}

export function useSelectedUnit(): BoardSelection {
  const [searchParams, setSearchParams] = useSearchParams();

  const selectUnit = useCallback(
    (unitId: string | null): void => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (unitId === null) next.delete(SELECTED_UNIT_PARAM);
          else next.set(SELECTED_UNIT_PARAM, unitId);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { selectedUnitId: searchParams.get(SELECTED_UNIT_PARAM), selectUnit };
}
