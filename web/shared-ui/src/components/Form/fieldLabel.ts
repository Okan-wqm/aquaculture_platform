/**
 * Form etiketi boyutu — kontrolün kendi metin boyutunu izler.
 *
 * The label used to be pinned at `text-sm` whatever the control's `size`, so a
 * dense row (filter bar, repeat row, toolbar) could not use the primitive's own
 * label without growing a size larger than the control next to it. Every such row
 * therefore kept a hand-written `<label class="text-xs">` outside the primitive —
 * the single largest reason raw <select>/<input> markup survived the
 * design-system sweep (FE-HIGH-079). Linking the two sizes makes the primitive's
 * label correct at every density, so the raw markup has no reason left to exist.
 *
 * `md` (the default) and `sm` keep `text-sm`, so no existing field changes.
 */

import type { Size } from '../../types';

/** Etiket metin boyutu — kontrolün `size` değerine bağlı. */
export const fieldLabelTextSize: Record<Size, string> = {
  xs: 'text-xs',
  sm: 'text-sm',
  md: 'text-sm',
  lg: 'text-base',
  xl: 'text-lg',
};

/** Etiket sınıfları — kontrol boyutuna göre metin boyutu. */
export const fieldLabelClass = (size: Size): string =>
  `block ${fieldLabelTextSize[size]} font-medium text-gray-700 dark:text-gray-300 mb-1`;
