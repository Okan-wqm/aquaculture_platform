/**
 * Class vocabulary shared by the two reference documents — the design's
 * blueprint document type (display-face numbers in the accent, uppercase
 * small-caps labels, hairline-ruled lists) written once instead of per
 * component. Colours are theme tokens only: inside the page's `sd-page` scope
 * `primary` is the console accent and the gray ramp is its ink.
 */

/** A part's mark: its number ('01') or letter ('K'), in the display face */
export const DOC_MARK =
  'font-display text-[22px] font-semibold text-primary-700 dark:text-primary-300';

/** A part's heading (h2) */
export const DOC_HEADING =
  'm-0 font-display text-[26px] font-semibold leading-[1.05] text-gray-900 sm:text-[32px] dark:text-gray-100';

/** A part's lead paragraph */
export const DOC_INTRO =
  'm-0 max-w-[900px] text-base leading-normal text-pretty text-gray-700 dark:text-gray-300';

/** Uppercase label in the accent (Kurallar, Öneri, Etkiler) */
export const DOC_LABEL =
  'text-[11.5px] font-bold uppercase tracking-[0.1em] text-primary-700 dark:text-primary-300';

/** A ruled list's top border */
export const DOC_RULED_TOP = 'border-t border-gray-200 dark:border-gray-700';

/** A ruled list row's hairline */
export const DOC_HAIRLINE = 'border-b border-gray-900/10 dark:border-gray-100/10';

/** Body copy of a list row */
export const DOC_BODY = 'text-[15px] leading-normal text-pretty';

/** A small item heading (h3) in the display face */
export const DOC_ITEM_TITLE =
  'm-0 font-display text-[21px] font-semibold leading-[1.1] text-gray-900 dark:text-gray-100';

/** A finding's or topic's id ("01.1", "K3") */
export const DOC_ITEM_ID =
  'min-w-[38px] font-display text-[15px] font-semibold tracking-[0.04em] text-gray-600 dark:text-gray-400';

/** A pill on the accent tint (box parts, proposed-section parts) */
export const DOC_PILL =
  'inline-flex min-h-[22px] items-center whitespace-nowrap bg-primary-100 px-[7px] text-xs font-semibold text-primary-900 dark:bg-primary-900 dark:text-primary-100';

/** A card frame around a diagram or table: the console's blueprint surface */
export const DOC_FRAME = 'sd-card relative';

/** In-page link to another part of the document */
export const DOC_LINK =
  'font-semibold text-primary-700 hover:text-primary-900 hover:underline dark:text-primary-300 dark:hover:text-primary-100';
