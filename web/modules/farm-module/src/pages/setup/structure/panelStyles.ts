/**
 * Shared surface classes of the facility structure page — one frame, one
 * kicker and one card-heading spelling for every card, light and dark.
 */
export const FRAME =
  'rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900';

export const KICKER =
  'text-xs font-bold uppercase tracking-widest text-gray-600 dark:text-gray-400';

export const CARD_HEADING = 'text-xl font-semibold text-gray-900 dark:text-gray-100';

export const MUTED_TEXT = 'text-sm text-gray-600 dark:text-gray-400';

/** Tiles that wrap into as many 10rem columns as fit. */
export const TILE_GRID = 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))]';

/** One tile of a band: its term above its figure. */
export const TILE = 'flex flex-col gap-1 px-5 py-4';

/** A cost tile's figure. */
export const TILE_FIGURE =
  'font-display text-3xl font-semibold tabular-nums text-gray-900 dark:text-gray-100';
