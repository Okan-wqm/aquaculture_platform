/**
 * useAlertPriorityParam — keeps the alarm list's filters and the URL's
 * `?priority=` (the console annunciator's tile) in step.
 *
 * WHY both directions: the annunciator stays on screen above the list, so a
 * tile can be pressed while the list is open — the route stays mounted and
 * only the query string changes, and the list must follow. In the other
 * direction a filter the user picks by hand rewrites the parameter (or drops
 * it when no tile shows that filter), so the pressed tile, a reload and a
 * shared link all say what the list shows.
 *
 * WHY a ref of the value last written: the list's state and the router's
 * location update in separate renders. Without it, the render that sees the
 * new URL but the old filters (or the reverse) would read as "the URL asks
 * for something else" and overwrite the user's choice. Only a parameter this
 * hook did not write itself — a navigation from outside — is applied.
 *
 * WHAT: initialAlertFilter() for the list's first state, and the hook, which
 * applies outside changes through `apply` and returns `choose(filter)`, the
 * one way the page changes the tile-shaped part of its filters.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

import { ALARM_PRIORITY_PARAM, parseAnnunciatorFilter } from '@aquaculture/shared-ui';

import { filterForPriority, priorityForFilter, type AlertListFilter } from './alertPriorityFilter';

/** The filter the URL asks for when the list opens. */
export function initialAlertFilter(search: URLSearchParams): AlertListFilter {
  return filterForPriority(parseAnnunciatorFilter(search.get(ALARM_PRIORITY_PARAM)));
}

export function useAlertPriorityParam(
  apply: (filter: AlertListFilter) => void,
): (filter: AlertListFilter) => void {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = parseAnnunciatorFilter(searchParams.get(ALARM_PRIORITY_PARAM));
  const written = useRef(requested);

  useEffect(() => {
    if (requested === written.current) return;
    written.current = requested;
    apply(filterForPriority(requested));
  }, [requested, apply]);

  return useCallback(
    (filter: AlertListFilter): void => {
      const priority = priorityForFilter(filter);
      written.current = priority;
      apply(filter);
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (priority === null) next.delete(ALARM_PRIORITY_PARAM);
          else next.set(ALARM_PRIORITY_PARAM, priority);
          return next;
        },
        // A filter change is not a page: Back leaves the list, it does not undo the filter.
        { replace: true },
      );
    },
    [apply, setSearchParams],
  );
}
