/**
 * Suderra page vocabulary for the tenant console pages (FE-HIGH-314).
 *
 * The palette comes from the `sd-page` token scope (shared-ui
 * styles/suderra.css): inside it `bg-white` is parchment, the gray scale is
 * ink and `primary` is teal, and every `dark:` sibling below reads the same
 * scope's deep-water ramp. These constants are only the Suderra *shapes* —
 * the stat card's display-serif figure, the uppercase card label — written
 * once instead of per page.
 */

/** A raised card on the paper page */
export const SD_CARD =
  'rounded-[14px] border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900';

/** A card's uppercase section label (the card heading) */
export const SD_CARD_LABEL =
  'text-[12.5px] font-semibold uppercase tracking-[0.08em] text-primary-700 dark:text-primary-300';

/** A stat card's caption */
export const SD_STAT_TITLE =
  'text-xs font-semibold uppercase tracking-[0.07em] text-gray-600 dark:text-gray-300';

/** A stat card's figure, in the display serif */
export const SD_STAT_VALUE =
  'font-display text-[34px] font-normal leading-none text-gray-900 dark:text-gray-100';
