/**
 * How a flagged finance figure paints — the Industry hazard marks of the
 * Tenant Console design: an alarm is a red square and red ink, a warning an
 * amber triangle and amber ink, and a flagged row carries a 5px bar of the
 * same hazard colour on its leading edge. An unflagged figure paints nothing.
 *
 * The hazard tokens flip with the theme in theme.css, so none of these needs
 * a `dark:` sibling.
 */
import type { Severity } from '../model/severity';

export const SEVERITY_GLYPH: Record<Exclude<Severity, 'ok'>, string> = {
  alarm: 'inline-block size-3 shrink-0 bg-sd-hz-red',
  warn: 'inline-block size-3 shrink-0 bg-sd-hz-amber [clip-path:polygon(50%_0,100%_100%,0_100%)]',
};

export const SEVERITY_INK: Record<Severity, string> = {
  ok: '',
  warn: 'text-sd-hz-amber-ink',
  alarm: 'text-sd-danger-ink',
};

/**
 * The row bar, drawn on the row's first cell: a box shadow on a `<tr>` is not
 * painted reliably across engines, on a `<td>` it is.
 */
export const SEVERITY_ROW: Record<Severity, string> = {
  ok: '',
  warn: '[&>td:first-child]:shadow-[inset_5px_0_0_var(--color-sd-hz-amber)]',
  alarm: '[&>td:first-child]:shadow-[inset_5px_0_0_var(--color-sd-hz-red)]',
};

/** Figures in the console's display face, tabular so columns line up. */
export const FIGURE = 'font-display font-semibold tabular-nums';
