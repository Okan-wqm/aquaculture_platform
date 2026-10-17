/**
 * PreviewFace — the square MOCK badge both preview forms carry (FE-MEDIUM-337).
 *
 * The face alone: hazard-amber fill, on-amber ink (the same pair in both
 * themes), the Industry badge's square 22 px with its 12.5 px bold figures
 * (design handoff §7.8 "badges are square, 22 px"; §7.2's rail badge), set in
 * condensed caps because it carries a word, not a count. In the block notice
 * it is decoration beside the eyebrow and hidden from assistive technology;
 * the inline chip wraps it in a button.
 */
import type { ReactElement } from 'react';

import { useI18n } from '../i18n';

export const PREVIEW_FACE_CLASS =
  'inline-flex h-[22px] min-w-[22px] shrink-0 items-center justify-center bg-sd-hz-amber px-1.5 font-display-sd text-[12.5px] font-bold uppercase leading-none tracking-[0.12em] text-sd-hz-on-amber';

export function PreviewFace(): ReactElement {
  const { t } = useI18n();
  return (
    <span aria-hidden="true" className={PREVIEW_FACE_CLASS}>
      {t('preview.chipLabel')}
    </span>
  );
}
