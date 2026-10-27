/**
 * Suderra page vocabulary for the tenant console pages (FE-HIGH-314), in the
 * Industry language (FE-HIGH-333).
 *
 * The palette comes from the console's token scope (shared-ui
 * styles/suderra.css): inside it `bg-white` is cream, the gray scale is the
 * graphite ramp and `primary` is the workspace accent, and every `dark:`
 * sibling below reads the Control-room ramp. These constants are only the
 * shapes — the blueprint card, the condensed stat figure, the uppercase card
 * label — written once instead of per page.
 */

/**
 * A card: suderra.css's blueprint frame — square, a 1px hairline, no fill and
 * a registration mark on each corner (README §7.7). The marks sit 6px outside
 * the box, so a card never clips (`overflow-hidden`): square corners leave
 * nothing to clip, and a clip would cut the marks.
 */
export const SD_CARD = 'sd-card';

/** A card's uppercase section label (the card heading) */
export const SD_CARD_LABEL =
  'text-[12.5px] font-semibold uppercase tracking-[0.08em] text-primary-700 dark:text-primary-300';

/** A stat card's caption */
export const SD_STAT_TITLE =
  'text-xs font-semibold uppercase tracking-[0.07em] text-gray-600 dark:text-gray-300';

/** A stat card's figure: the display face (Inter 600 in the console), tabular */
export const SD_STAT_VALUE =
  'font-display text-[34px] font-semibold leading-none tabular-nums text-gray-900 dark:text-gray-100';
