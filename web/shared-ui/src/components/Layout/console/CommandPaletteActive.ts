/**
 * The palette's highlighted row (FE-HIGH-334) — what Enter runs and
 * aria-activedescendant names.
 *
 * WHY by key, not by index: people and devices arrive after the pages, and a
 * late source inserts rows above the ones below it. An index would then point
 * at a different entry than the one the user moved to; a key stays on it. A
 * highlighted entry that drops out of the results falls back to the first row.
 *
 * WHY an explicit reset: every edit of the query starts over at the first row
 * (the prototype's "typing resets the index"). The search field calls reset()
 * on each edit, so no earlier choice survives one — remembering instead the
 * query a row was chosen under would bring that row back when the user types
 * their way back to the same query ("fe" → "f" → "fe").
 */
import { useCallback, useState } from 'react';

export interface ActiveRow {
  /** The highlighted row's index; -1 when there are no rows. */
  readonly index: number;
  /** Highlight the row at `index` (pointer hover). */
  readonly activate: (index: number) => void;
  /** Move the highlight one row down (1) or up (-1), stopping at either end. */
  readonly move: (step: 1 | -1) => void;
  /** Forget the chosen row, so the first one is highlighted: every edit of the query. */
  readonly reset: () => void;
}

export function useActiveRow(keys: readonly string[]): ActiveRow {
  // The chosen row's key; null until the user moves, and after every edit.
  const [chosen, setChosen] = useState<string | null>(null);
  const kept = chosen === null ? -1 : keys.indexOf(chosen);
  const index = keys.length === 0 ? -1 : Math.max(kept, 0);

  const activate = useCallback(
    (next: number): void => {
      if (next < 0 || next >= keys.length) return;
      setChosen(keys[next]);
    },
    [keys],
  );
  const move = useCallback(
    (step: 1 | -1): void => activate(Math.min(Math.max(index + step, 0), keys.length - 1)),
    [activate, index, keys.length],
  );
  const reset = useCallback((): void => setChosen(null), []);

  return { index, activate, move, reset };
}
