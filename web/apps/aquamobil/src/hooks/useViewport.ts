/**
 * useViewport — the ONE place the app asks "phone in a hand, or board on a wall?"
 *
 * THE STRATEGY, in short (the long version, with the device measurements that
 * produced the numbers, lives in the `screens` block of tailwind.config.js —
 * read that before changing anything here):
 *
 *   A BOARD VIEWPORT IS  (min-width: 900px) AND (min-height: 600px).
 *
 * The height term is not decoration. The widest phone in landscape (932×430) is
 * wider than any width-only threshold a tablet could still clear, so width alone
 * would hand the three-column board to a phone lying on its side. Height is what
 * tells the two apart: tablets in landscape are ≥744px tall, phones ≤430px.
 * Consequence, stated plainly: A PHONE IN LANDSCAPE GETS THE HANDHELD SHELL,
 * always. A tablet in portrait below 900px does too — three columns at ~250px
 * each is worse than one column at 800px.
 *
 * WHY THE QUERY STRINGS ARE DUPLICATED IN tailwind.config.js: a Tailwind screen
 * and a JS media query cannot import from each other (the config is loaded by
 * Tailwind's own runtime, outside the TS program). Both sides therefore carry
 * the literal, and src/layouts/__tests__/board-breakpoint.spec.ts fails the
 * build if they ever differ — the duplication is detectable rather than latent.
 *
 * WHY useSyncExternalStore rather than a resize listener + useState: the media
 * query list IS the external store, and React reads it during render, so the
 * first paint is already correct — no flash of the wrong shell. One
 * subscription covers BOTH cases the board must survive: a window resize and a
 * device rotation. A `change` event fires for either, so there is no separate
 * orientationchange listener (deprecated anyway) and nothing to throttle.
 */
import { useCallback, useSyncExternalStore } from 'react';

/** A tablet with room for the three-column board. See the strategy above. */
export const BOARD_MEDIA_QUERY = '(min-width: 900px) and (min-height: 600px)';

/** A large cabin tablet — the board widens its side columns above this. */
export const BOARD_WIDE_MEDIA_QUERY = '(min-width: 1280px) and (min-height: 600px)';

/**
 * WHY this check exists, and why it is not the defensive `?.` the guidelines
 * ban: jsdom (and any non-DOM host) ships no `matchMedia` at all, so this is an
 * environment CAPABILITY question, not a nullable value being papered over.
 * When there is no viewport to measure, the answer is "not a board" — the
 * handheld shell renders correctly at every size, the board does not, so
 * unknown must fail towards the handheld.
 */
function canMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/**
 * True while `query` matches, live across resizes and rotations.
 *
 * Exported because the board's panes may need a second query (`board-wide`)
 * without re-deriving the subscription mechanics.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      if (!canMatchMedia()) return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onStoreChange);
      return () => list.removeEventListener('change', onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback(
    (): boolean => canMatchMedia() && window.matchMedia(query).matches,
    [query],
  );

  // Third argument = the server/no-DOM snapshot. It resolves to `false` through
  // the same capability check, so a host without a viewport renders the
  // handheld shell rather than throwing.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** True when this viewport should run the tablet control board. */
export function useIsBoardViewport(): boolean {
  return useMediaQuery(BOARD_MEDIA_QUERY);
}
