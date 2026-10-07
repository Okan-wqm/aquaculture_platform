/**
 * The chart range a page shows, kept in its URL (`?range=7d` or
 * `?from=…&to=…`), so a link, a reload and the back button all show the same
 * window.
 *
 * Parsing and writing are the shared time-range table's
 * (`parseTimeRangeParams` / `timeRangeToParams`). An absent range is not an
 * error — the page's default applies. A present but malformed one is: the
 * page gets the error to say so, and shows its default meanwhile, instead of
 * quietly showing a window the link did not ask for.
 */
import {
  parseTimeRangeParams,
  type TimeRangeError,
  timeRangeToParams,
  type TimeRangeSpec,
} from '@aquaculture/shared-contracts';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

const RANGE_PARAMS = ['range', 'from', 'to'] as const;

export interface TimeRangeSearchParams {
  /** The range to show: the link's, or the default when it has none or a bad one. */
  spec: TimeRangeSpec;
  /** Why the link's range was not used, when it carried a malformed one. */
  error: TimeRangeError | null;
  /** Show `next` and record it in the URL (a new history entry). */
  setSpec: (next: TimeRangeSpec) => void;
}

export function useTimeRangeSearchParams(defaultSpec: TimeRangeSpec): TimeRangeSearchParams {
  const [searchParams, setSearchParams] = useSearchParams();
  const range = searchParams.get('range');
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  const parsed = useMemo(() => parseTimeRangeParams({ range, from, to }), [range, from, to]);

  const setSpec = useCallback(
    (next: TimeRangeSpec) => {
      setSearchParams((current) => {
        const updated = new URLSearchParams(current);
        for (const name of RANGE_PARAMS) {
          updated.delete(name);
        }
        for (const [name, value] of Object.entries(timeRangeToParams(next))) {
          updated.set(name, value);
        }
        return updated;
      });
    },
    [setSearchParams],
  );

  if (parsed === null) {
    return { spec: defaultSpec, error: null, setSpec };
  }
  return parsed.ok
    ? { spec: parsed.spec, error: null, setSpec }
    : { spec: defaultSpec, error: parsed.error, setSpec };
}
